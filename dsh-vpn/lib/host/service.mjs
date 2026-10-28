// dsh-vpn Host 侧编排服务（service.mjs）。
//
// VpnService 把三件事串起来：
//   1. mihomo 引擎生命周期（lib/engine/index.mjs，惰性加载）
//   2. 进程级代理策略接管/恢复（lib/host/policy.mjs）
//   3. 状态机 + 持久化 + 看门狗 + 节点/订阅管理（供 Agent 工具与 HTTP API 共用）
//
// 安全语义（硬要求）：
//   - 默认 disabled；apply 时绝不无条件安装策略。
//   - 任何 installPolicy 之前必须 mihomo health 通过（health 走 probeThroughProxy，不经全局 dispatcher）。
//   - installPolicy 之后必须再做一次**进程内全局 fetch 自测**，失败立即回滚（restore + 可选 direct）、
//     停引擎、状态 failed —— 绝不在「策略已装但通道不通」时返回成功。
//   - stop()/disable() 顺序：先 restorePolicy()，再停引擎。
//   - 看门狗连续 failureThreshold 次失败：restore launcher dispatcher → fallbackToDirect 时
//     立刻 installDirect() 覆盖为直连（安全网）→ 停引擎 → 每 retryIntervalMs 重拉订阅/重启/重接管。
//   - 订阅拉取失败但有本地缓存 → 用缓存启动引擎；没有缓存才失败。
//   - kill-switch：<dataDir>/disable.flag 或 DSH_VPN_DISABLED=1 → 强制 disabled，拒绝自动/手动启用。
//   - state.json 损坏 → 回退默认 disabled。
//
// 状态机：disabled → starting → running ↔ degraded；失败进入 failed，重试中回到 starting。

import fs from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

import {
  STATUS,
  MODES,
  normalizeConfig,
  resolveDataDirInfo,
  statePath,
  subscriptionCachePath,
  runtimeConfigPath,
  killSwitchPath,
  isKillSwitchActive,
  loadStateSync,
  saveStateSync,
  maskUrl,
  summarizeYaml,
  describeSummary,
  describeProbe,
  isPseudoNodeName,
  isProbeOk,
  errorMessage,
  formatBytes,
  randomSecret,
  truncateText,
} from './state.mjs'
import { PolicyManager, PolicyUnavailableError } from './policy.mjs'
import {
  SystemProxyManager,
  buildTargetProxyServer,
  mergeBypass,
  describeSnapshot,
  isPluginProxyServer,
} from './system-proxy.mjs'
import {
  loadEngineModule,
  isEngineModuleLoaded,
  probeThroughProxy,
  probeEngineHealth,
  resolveBinaryPath,
  createEngine,
  buildRuntimeConfig,
  pickFreePort,
  readCachedSubscription,
  writeCachedSubscription,
  parseNodesFromYaml,
  engineLogsTail,
  ensureProfileStoreDisabled,
} from './engine-bridge.mjs'

const LOG_LEVEL_ORDER = { silent: 0, error: 1, warning: 2, info: 3, debug: 4 }
const HEALTH_TIMEOUT_MS = 8000
const NODE_TEST_TIMEOUT_MS = 5000
const NODE_TEST_CONCURRENCY = 8
const MAX_STATUS_LOGS = 20
const MAX_GROUP_DEPTH = 5

/** mihomo 内置的「控制类」目标：不是真实节点，不能当作当前节点展示。 */
const CONTROL_TARGETS = new Set(['GLOBAL', 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'PASS-RULE', 'COMPATIBLE'])

/** 组名命中这些词说明它是「拒绝/直连/兜底」开关组，不作为当前节点来源。 */
const NON_ROUTING_GROUP_RE = /(reject|reject-drop|直连|direct|广告|拦截|漏网|final|兜底|旁路|global)/i

/** 真正承载用户「选节点」意图的分组名优先（注意「♻️ 自动选择」也含「选择」，需被 AUTO 排除）。 */
const PRIMARY_GROUP_RE = /(节点选择|选择节点|手动|proxy|select)/i

/** 自动选择/故障转移类分组：是链中间层，不是用户手动选节点的入口。 */
const AUTO_GROUP_RE = /(自动|auto|url-?test|fallback|故障转移|负载均衡|load-?balance|relay)/i

/**
 * 「用户选节点」入口分组判定：Selector 类型 + 名字像节点选择 + 不是自动/故障转移组。
 * 用于 select 的候选排序与当前节点解析的主分组识别。
 */
function isPrimarySelectorGroup(group) {
  if (!group || typeof group.name !== 'string') return false
  if (String(group.type || '').toLowerCase() !== 'selector') return false
  if (NON_ROUTING_GROUP_RE.test(group.name)) return false
  if (AUTO_GROUP_RE.test(group.name)) return false
  return PRIMARY_GROUP_RE.test(group.name)
}

function isControlTarget(value) {
  return typeof value === 'string' && CONTROL_TARGETS.has(value.trim().toUpperCase())
}

/**
 * 递归解析分组选择链：`🔰 节点选择.now = ♻️ 自动选择` → `♻️ 自动选择.now = 🇵🇭 菲律宾A[BGP]`。
 * 最多 MAX_GROUP_DEPTH 层，返回叶子值（可能是真实节点、DIRECT/REJECT 等控制值，或 null）。
 */
function resolveGroupChain(groupsByName, start, maxDepth = MAX_GROUP_DEPTH) {
  let value = typeof start === 'string' ? start.trim() : ''
  if (!value) return null
  const seen = new Set()
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (seen.has(value)) return null
    seen.add(value)
    const group = groupsByName.get(value)
    if (!group) return value
    const next = typeof group.now === 'string' ? group.now.trim() : ''
    if (!next) return null
    value = next
  }
  return groupsByName.has(value) ? null : value
}

function sleep(ms) {
  // 注意：这里不能 unref()——停引擎/回滚流程依赖这个定时器把事件循环撑住，
  // 否则在独立 node 脚本里（没有其它 handle）进程会以「unsettled top-level await」提前退出。
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** pid 是否存活（只用于我们自己 spawn 的 mihomo 进程）。 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

/** 兜底结束我们自己 spawn 的进程树；绝不主动杀父进程或用户进程。 */
function forceKillOwnPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  // 优先用 Node 原生 API（不依赖外部 taskkill 可执行文件；受限/沙箱环境同样可用）。
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch {
    /* 退回 taskkill */
  }
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
    } else {
      process.kill(pid, 'SIGKILL')
    }
    return true
  } catch {
    return false
  }
}

function emptyStatus() {
  return {
    status: STATUS.DISABLED,
    lastError: null,
    degradedReason: null,
    degradedAt: null,
    nodeName: null,
    port: null,
    controllerPort: null,
    startedAt: null,
    lastHealthMs: null,
    lastHealthAt: null,
    selfTestMs: null,
    consecutiveFailures: 0,
    directFallback: false,
    retryCount: 0,
    nextRetryAt: null,
    mode: 'rule',
    preferredNode: '',
    subscriptionUrl: '',
    killSwitch: { active: false, reason: null },
  }
}

export class VpnService {
  /**
   * @param {{ ctx?: any, config?: Record<string, unknown>, log?: (level: string, message: string) => void }} options
   */
  constructor(options = {}) {
    this.ctx = options.ctx || null
    this._externalLog = typeof options.log === 'function' ? options.log : null
    this.config = normalizeConfig(options.config || {})
    let dataDirInfo
    try {
      dataDirInfo = resolveDataDirInfo(this.config, process.env)
    } catch (error) {
      dataDirInfo = {
        dataDir: path.join(os.homedir(), '.dsh-vpn'),
        source: 'fallback',
        profileDir: null,
      }
      this._externalLog?.('warning', 'dsh-vpn: 解析 dataDir 失败，使用回退目录: ' + errorMessage(error))
    }
    this.dataDir = dataDirInfo.dataDir
    this._dataDirSource = dataDirInfo.source
    this._dataDirProfile = dataDirInfo.profileDir || null
    this.config.dataDir = this.dataDir
    if (dataDirInfo.source !== 'config') {
      this._externalLog?.('info', 'dsh-vpn: dataDir=' + this.dataDir + '（来源: ' + dataDirInfo.source + '）')
    }
    this.paths = {
      dataDir: this.dataDir,
      state: statePath(this.dataDir),
      subscription: subscriptionCachePath(this.dataDir),
      runtime: runtimeConfigPath(this.dataDir),
      killSwitch: killSwitchPath(this.dataDir),
    }

    this._logLevel = LOG_LEVEL_ORDER[this.config.logLevel] ?? LOG_LEVEL_ORDER.warning
    this._logs = []
    // 引擎层（lib/engine/*.mjs）的日志回调契约是 (line: string) => void，
    // 这里桥接到插件日志；同时兼容 (level, message) 形式的调用。
    this._engineLogSink = (levelOrLine, maybeLine) => {
      try {
        if (typeof maybeLine === 'string') {
          const level = Object.prototype.hasOwnProperty.call(LOG_LEVEL_ORDER, levelOrLine) ? levelOrLine : 'info'
          this._log(level, maybeLine)
        } else {
          this._log('info', String(levelOrLine ?? ''))
        }
      } catch {
        /* 日志失败绝不影响引擎 */
      }
    }
    this.policy = new PolicyManager({ log: (level, message) => this._log(level, message) })
    this._engineModule = null
    this._engine = null
    this._runtime = null
    this._subscription = {
      info: null,
      summary: null,
      fromCache: false,
      updatedAt: null,
      cachePath: this.paths.subscription,
      error: null,
    }
    this._queue = Promise.resolve()
    this._watchdogTimer = null
    this._retryTimer = null
    this._autoStartTimer = null
    this._disposed = false
    this._status = emptyStatus()

    this._loadPersistedState()

    // ---- 系统代理（Windows WinINET）----
    // 可注入 manager（自测用 memory runner，绝不触碰真实注册表）。
    this._systemProxy =
      options.systemProxy && typeof options.systemProxy === 'object'
        ? options.systemProxy
        : new SystemProxyManager({ log: (level, message) => this._log(level, message), platform: process.platform })
    this._systemProxyDesired = Boolean(this.config.systemProxy)
    if (this._state && typeof this._state.systemProxy === 'boolean') this._systemProxyDesired = this._state.systemProxy
    this._systemProxyOriginal = this._state && this._state.systemProxyOriginal ? this._state.systemProxyOriginal : null
    this._systemProxyApplied = Boolean(this._state && this._state.systemProxyApplied)
    this._systemProxyAppliedAt = this._state && typeof this._state.systemProxyAppliedAt === 'number' ? this._state.systemProxyAppliedAt : null
    this._systemProxyLastError = null
    this._systemProxyCache = null
    this._systemProxyCacheAt = 0
    this._systemProxyStatusCacheMs = Number.isFinite(options.systemProxyStatusCacheMs)
      ? Math.max(0, Number(options.systemProxyStatusCacheMs))
      : 1200
    this._exitGuard = null
    this._systemProxyStartupCleanup()
  }

  // =========================================================================
  // 日志 / 串行队列
  // =========================================================================

  _log(level, message) {
    const weight = LOG_LEVEL_ORDER[level] ?? LOG_LEVEL_ORDER.info
    if (weight > this._logLevel) return
    const text = String(message ?? '')
    this._logs.push({ at: Date.now(), level, message: text })
    if (this._logs.length > 200) this._logs.splice(0, this._logs.length - 200)
    try {
      this._externalLog?.(level, text)
    } catch {
      /* 外部日志 sink 抛错不影响插件 */
    }
    const logger = this.ctx && this.ctx.logger ? this.ctx.logger : null
    try {
      if (logger) {
        const prefixed = '[dsh-vpn] ' + text
        if (level === 'error') logger.error?.(prefixed)
        else if (level === 'warning') logger.warn?.(prefixed)
        else if (level === 'debug') logger.debug?.(prefixed)
        else logger.info?.(prefixed)
      }
    } catch {
      /* 日志失败绝不影响主流程 */
    }
  }

  /** 串行执行所有会改变引擎/策略状态的公开操作，避免并发接管。 */
  _runExclusive(operation) {
    const run = this._queue.then(operation, operation)
    this._queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // =========================================================================
  // 持久化 / 初始化
  // =========================================================================

  _loadPersistedState() {
    try {
      const kill = isKillSwitchActive({ dataDir: this.dataDir })
      this._killSwitch = { active: kill.active, reason: kill.reason }
      this._status.killSwitch = { ...this._killSwitch }
      const loaded = loadStateSync(this.dataDir)
      if (loaded.warning) this._log('warning', 'dsh-vpn: ' + loaded.warning)
      const state = loaded.state
      if (!loaded.exists && !loaded.warning) state.enabled = Boolean(this.config.enabled)
      this._state = state
      this.config.subscriptionUrl = state.subscriptionUrl || this.config.subscriptionUrl
      this.config.preferredNode = state.preferredNode || this.config.preferredNode
      // 只有真的读到 state.json 时才用持久化 mode 覆盖 patch 配置；首次运行（无 state.json）
      // 必须尊重 Config 里的 mode（否则 patch 写 mode: global 会被默认 rule 吞掉）。
      if (loaded.exists && MODES.includes(state.mode)) this.config.mode = state.mode
      else if (!MODES.includes(this.config.mode)) this.config.mode = 'rule'
      this._status.mode = this.config.mode
      this._status.preferredNode = this.config.preferredNode
      this._status.subscriptionUrl = maskUrl(this.config.subscriptionUrl)
      if (this._killSwitch.active) {
        this._status.lastError = 'kill-switch 生效，插件保持 disabled：' + this._killSwitch.reason
        this._log('warning', 'dsh-vpn: ' + this._status.lastError)
      }
      if (state.enabled && !this._killSwitch.active) this._log('info', 'dsh-vpn: 持久化 enabled=true，将在健康门控下自动接管')
      const cached = this._readCachedSync()
      if (cached) {
        this._subscription.fromCache = true
        this._subscription.summary = summarizeYaml(cached)
        this._subscription.updatedAt = this._cachedMtime()
        this._subscription.error = null
      }
    } catch (error) {
      this._state = { version: 1, enabled: false, subscriptionUrl: '', preferredNode: '', mode: 'rule', updatedAt: null }
      this._killSwitch = { active: false, reason: null }
      this._log('error', 'dsh-vpn: 初始化持久化状态失败，回退默认 disabled: ' + errorMessage(error))
    }
  }

  _persist() {
    try {
      saveStateSync(this.dataDir, {
        version: 1,
        enabled: Boolean(this._state && this._state.enabled),
        subscriptionUrl: this.config.subscriptionUrl,
        preferredNode: this.config.preferredNode,
        mode: this.config.mode,
        systemProxy: Boolean(this._systemProxyDesired),
        systemProxyApplied: Boolean(this._systemProxyApplied),
        systemProxyOriginal: this._systemProxyOriginal || null,
        systemProxyAppliedAt: this._systemProxyAppliedAt || null,
        updatedAt: Date.now(),
      })
    } catch (error) {
      this._log('warning', 'dsh-vpn: 写 state.json 失败: ' + errorMessage(error))
    }
  }

  _readCachedSync() {
    try {
      const raw = fs.readFileSync(this.paths.subscription, 'utf8')
      return raw && raw.trim() ? raw : null
    } catch {
      return null
    }
  }

  _cachedMtime() {
    try {
      return fs.statSync(this.paths.subscription).mtimeMs
    } catch {
      return null
    }
  }

  // =========================================================================
  // 系统代理（Windows WinINET）：快照 / 应用 / 精确还原
  // =========================================================================

  /** 读取当前系统代理（带短缓存，避免 status 高频轮询反复 spawn reg.exe）。 */
  _systemProxyReadLive(force = false) {
    const manager = this._systemProxy
    if (!manager || !manager.supported) {
      return { ok: false, supported: false, error: '系统代理仅支持 Windows（当前平台: ' + process.platform + '）' }
    }
    const now = Date.now()
    if (!force && this._systemProxyCache && now - this._systemProxyCacheAt < this._systemProxyStatusCacheMs) {
      return this._systemProxyCache
    }
    const result = manager.readSystemProxy()
    this._systemProxyCache = result
    this._systemProxyCacheAt = now
    return result
  }

  _invalidateSystemProxyCache() {
    this._systemProxyCache = null
    this._systemProxyCacheAt = 0
  }

  /** 当前系统代理是否精确指向插件端口（实时判定，不信内存标记）。 */
  _systemProxyIsApplied(live) {
    if (!live || live.ok !== true) return false
    const port = this._status.port
    if (!port) return false
    return (
      Number(live.normalized.proxyEnable) === 1 &&
      String(live.normalized.proxyServer || '').trim() === buildTargetProxyServer(port)
    )
  }

  _clearSystemProxyMarkers() {
    this._systemProxyOriginal = null
    this._systemProxyApplied = false
    this._systemProxyAppliedAt = null
  }

  /** status.systemProxy 的最终形状（applied 来自**实时读取**，不信内存标记）。 */
  _systemProxyStatus() {
    const manager = this._systemProxy
    const supported = Boolean(manager && manager.supported)
    const desired = Boolean(this._systemProxyDesired)
    const port = this._status.port || null
    const base = {
      supported,
      platform: process.platform,
      enabled: desired,
      applied: false,
      target: port ? buildTargetProxyServer(port) : null,
      port,
      proxyEnable: null,
      proxyServer: null,
      proxyOverride: null,
      autoConfigUrl: null,
      bypass: null,
      original: describeSnapshot(this._systemProxyOriginal),
      appliedAt: this._systemProxyAppliedAt || null,
      lastError: this._systemProxyLastError || null,
      drift: false,
      readError: null,
      restoreOnStop: Boolean(this.config.systemProxyRestoreOnStop),
      markerApplied: Boolean(this._systemProxyApplied),
    }
    if (!supported) {
      base.lastError = base.lastError || '系统代理仅支持 Windows（当前平台: ' + process.platform + '）'
      return base
    }
    const live = this._systemProxyReadLive()
    if (!live || live.ok !== true) {
      base.readError = (live && live.error) || '读取系统代理失败'
      base.lastError = base.lastError || base.readError
      return base
    }
    const applied = this._systemProxyIsApplied(live)
    return {
      ...base,
      applied,
      proxyEnable: live.normalized.proxyEnable,
      proxyServer: live.normalized.proxyServer,
      proxyOverride: live.normalized.proxyOverride,
      autoConfigUrl: live.normalized.autoConfigUrl,
      bypass: mergeBypass(live.normalized.proxyOverride),
      drift: desired && !applied,
    }
  }

  /** 启动期 stale 清理：上次异常退出留下的快照/标记 → 先精确还原，避免浏览器卡在死端口。 */
  _systemProxyStartupCleanup() {
    try {
      const manager = this._systemProxy
      if (!manager || !manager.supported) return
      const hasMarkers = Boolean(this._systemProxyOriginal) || Boolean(this._systemProxyApplied)
      if (!hasMarkers) return
      this._log('warning', 'dsh-vpn: 检测到上次未还原的系统代理快照/标记，启动期先尝试精确还原')
      const live = this._systemProxyReadLive(true)
      const ours = this._systemProxyIsApplied(live)
      const snapshot = this.config.systemProxyRestoreOnStop ? this._systemProxyOriginal : null
      const result = manager.restoreSystemProxy(snapshot, { notify: true })
      if (result.ok) {
        this._clearSystemProxyMarkers()
        this._persist()
        this._invalidateSystemProxyCache()
        this._log('info', 'dsh-vpn: 启动期系统代理已还原（' + String(result.mode) + '）')
      } else {
        this._systemProxyLastError = result.error
        this._log('error', 'dsh-vpn: 启动期还原系统代理失败: ' + result.error + (ours ? '（当前仍可能指向插件端口）' : ''))
      }
    } catch (error) {
      this._log('warning', 'dsh-vpn: 启动期系统代理清理异常（已忽略）: ' + errorMessage(error))
    }
  }

  /**
   * 运行中若用户意图为开 → 把系统代理指向当前 mixed 端口（幂等；失败只记 lastError）。
   */
  _applySystemProxyForRunning(reason) {
    const manager = this._systemProxy
    if (!manager || !manager.supported) return { ok: false, skipped: true, error: '系统代理仅支持 Windows' }
    if (!this._systemProxyDesired) return { ok: true, skipped: true }
    const port = this._status.port
    if (!port) return { ok: false, error: '没有可用的 mixed 端口' }
    const result = manager.applySystemProxy({ port, snapshot: this._systemProxyOriginal })
    this._invalidateSystemProxyCache()
    if (!result.ok) {
      this._systemProxyLastError = result.error
      this._persist()
      this._log(
        'warning',
        'dsh-vpn: 系统代理开启失败（不影响 VPN 运行；系统代理未指向插件端口）: ' + result.error,
      )
      return { ok: false, error: result.error, rolledBack: Boolean(result.rolledBack) }
    }
    this._systemProxyOriginal = result.snapshot || this._systemProxyOriginal
    this._systemProxyApplied = true
    this._systemProxyAppliedAt = result.appliedAt || Date.now()
    this._systemProxyLastError = null
    this._persist()
    if (result.changed) this._log('info', 'dsh-vpn: 系统代理已随 ' + reason + ' 指向 ' + result.target)
    return { ok: true, changed: Boolean(result.changed), target: result.target, capturedSnapshot: Boolean(result.capturedSnapshot) }
  }

  /**
   * 还原系统代理（停用/降级/退出/unload 用）。
   * 失败时先尝试"安全关闭"（ProxyEnable=0）；仍失败则返回 abort=true，调用方应保持引擎运行以免死端口。
   */
  _restoreSystemProxy(reason) {
    const manager = this._systemProxy
    if (!manager || !manager.supported) {
      this._clearSystemProxyMarkers()
      return { ok: true, skipped: true, supported: false }
    }
    const hasMarkers = Boolean(this._systemProxyOriginal) || Boolean(this._systemProxyApplied)
    const live = this._systemProxyReadLive(true)
    const ours = this._systemProxyIsApplied(live)
    if (!hasMarkers && !ours) return { ok: true, skipped: true }
    const useSnapshot = Boolean(this.config.systemProxyRestoreOnStop)
    const snapshot = useSnapshot ? this._systemProxyOriginal : null
    const result = manager.restoreSystemProxy(snapshot, { notify: true })
    this._invalidateSystemProxyCache()
    if (result.ok) {
      this._clearSystemProxyMarkers()
      this._systemProxyLastError = null
      this._persist()
      this._log('info', 'dsh-vpn: 系统代理已还原（' + reason + '，mode=' + String(result.mode) + '）')
      return { ok: true, restored: true, mode: result.mode || 'precise' }
    }
    // 精确还原失败 → 安全关闭，保证不指向已停止的插件端口
    const fallback = manager.restoreSystemProxy(null, { notify: true })
    this._invalidateSystemProxyCache()
    if (fallback.ok) {
      this._clearSystemProxyMarkers()
      this._systemProxyLastError = result.error
      this._persist()
      this._log('error', 'dsh-vpn: 精确还原系统代理失败，已安全关闭系统代理（ProxyEnable=0）: ' + result.error)
      return { ok: false, abort: false, error: result.error, fallback: 'disabled' }
    }
    this._systemProxyLastError = result.error
    this._persist()
    this._log('error', 'dsh-vpn: 系统代理还原与安全关闭均失败: ' + result.error)
    return { ok: false, abort: true, error: result.error }
  }

  /**
   * 手动开/关系统代理（工具 / HTTP / UI 共用）。
   * - enabled=true 要求 VPN running（否则 UI 应按容器契约禁用）；已 applied 时幂等。
   * - enabled=false 只还原；applied=false 时不重复还原，只清意图与标记。
   */
  setSystemProxy(enabled, options = {}) {
    return this._runExclusive(async () => {
      const value = typeof enabled === 'boolean' ? enabled : enabled === 'true' ? true : enabled === 'false' ? false : null
      if (value === null) return { ok: false, error: '缺少 enabled 参数（true/false）', status: this.status() }
      const manager = this._systemProxy
      if (!manager || !manager.supported) {
        return {
          ok: false,
          error: '系统代理仅支持 Windows（当前平台: ' + process.platform + '）',
          systemProxy: this._systemProxyStatus(),
          status: this.status(),
        }
      }
      const source = (options && options.source) || 'manual'
      if (value) {
        if (this._killSwitch && this._killSwitch.active) {
          return { ok: false, error: 'kill-switch 生效，拒绝开启系统代理', systemProxy: this._systemProxyStatus(), status: this.status() }
        }
        if (this._status.status !== STATUS.RUNNING || !this._status.port) {
          return {
            ok: false,
            error: 'VPN 未运行（先 enable），不能把系统代理指向插件端口',
            systemProxy: this._systemProxyStatus(),
            status: this.status(),
          }
        }
        const live = this._systemProxyReadLive(true)
        if (this._systemProxyIsApplied(live)) {
          // 幂等：已经 applied，只确保意图为 true
          this._systemProxyDesired = true
          this._systemProxyLastError = null
          this._persist()
          return { ok: true, changed: false, idempotent: true, systemProxy: this._systemProxyStatus(), status: this.status() }
        }
        // 快照：仅当 state 里没有未消费快照且当前不是插件端口段时捕获（绝不把自己的端口当原值）
        let snapshot = this._systemProxyOriginal
        let capturedSnapshot = false
        if (!snapshot) {
          const currentServer = live && live.ok ? live.normalized.proxyServer : null
          if (!isPluginProxyServer(currentServer)) {
            snapshot = manager.makeSnapshot(live && live.ok ? live : { values: {} }, { port: this._status.port })
            capturedSnapshot = true
          } else {
            this._log(
              'warning',
              'dsh-vpn: 当前系统代理指向插件端口段但没有可用快照，无法精确还原；本次不记录新快照',
            )
          }
        }
        const result = manager.applySystemProxy({ port: this._status.port, snapshot })
        this._invalidateSystemProxyCache()
        if (!result.ok) {
          this._systemProxyLastError = result.error
          this._persist()
          return {
            ok: false,
            error: '设置系统代理失败（已回滚，系统代理未指向插件端口）: ' + result.error,
            systemProxy: this._systemProxyStatus(),
            status: this.status(),
          }
        }
        this._systemProxyOriginal = result.snapshot || snapshot || null
        this._systemProxyApplied = true
        this._systemProxyAppliedAt = result.appliedAt || Date.now()
        this._systemProxyDesired = true
        this._systemProxyLastError = null
        this._persist()
        this._log(
          'info',
          'dsh-vpn: 系统代理已指向 ' + result.target + (capturedSnapshot ? '（已捕获原系统代理快照）' : '') + '（来源: ' + source + '）',
        )
        return {
          ok: true,
          changed: Boolean(result.changed),
          capturedSnapshot,
          systemProxy: this._systemProxyStatus(),
          status: this.status(),
        }
      }

      // 关闭
      const live = this._systemProxyReadLive(true)
      const applied = this._systemProxyIsApplied(live)
      if (!applied) {
        this._systemProxyDesired = false
        this._clearSystemProxyMarkers()
        this._invalidateSystemProxyCache()
        this._persist()
        return {
          ok: true,
          changed: false,
          restored: false,
          note: '系统代理当前未指向插件端口，仅关闭开关意图',
          systemProxy: this._systemProxyStatus(),
          status: this.status(),
        }
      }
      const snapshot = this.config.systemProxyRestoreOnStop ? this._systemProxyOriginal : null
      const result = manager.restoreSystemProxy(snapshot, { notify: true })
      this._invalidateSystemProxyCache()
      this._systemProxyDesired = false
      if (result.ok) {
        this._clearSystemProxyMarkers()
        this._systemProxyLastError = null
        this._persist()
        this._log('info', 'dsh-vpn: 系统代理已还原（手动关闭，mode=' + String(result.mode) + '）')
        return { ok: true, changed: true, restored: true, systemProxy: this._systemProxyStatus(), status: this.status() }
      }
      const fallback = manager.restoreSystemProxy(null, { notify: true })
      this._invalidateSystemProxyCache()
      this._systemProxyLastError = result.error
      if (fallback.ok) {
        this._clearSystemProxyMarkers()
        this._persist()
        return {
          ok: false,
          error: '精确还原失败，已安全关闭系统代理: ' + result.error,
          fallback: 'disabled',
          systemProxy: this._systemProxyStatus(),
          status: this.status(),
        }
      }
      this._persist()
      return { ok: false, error: '还原系统代理失败: ' + result.error, systemProxy: this._systemProxyStatus(), status: this.status() }
    })
  }

  /** 注册进程退出兜底（同步精确还原，不依赖异步 unload）；返回 disposer。 */
  installExitGuard() {
    if (this._exitGuard) return this._exitGuard
    const manager = this._systemProxy
    if (!manager || !manager.supported || typeof process.on !== 'function') {
      this._exitGuard = () => {}
      return this._exitGuard
    }
    const handler = () => {
      try {
        if (!this._systemProxyApplied && !this._systemProxyOriginal) return
        const snapshot = this.config.systemProxyRestoreOnStop ? this._systemProxyOriginal : null
        manager.restoreSystemProxy(snapshot, { notify: false })
      } catch {
        /* 退出阶段绝不抛错 */
      }
    }
    try {
      process.on('exit', handler)
    } catch {
      this._exitGuard = () => {}
      return this._exitGuard
    }
    this._exitGuard = () => {
      try {
        process.removeListener('exit', handler)
      } catch {
        /* ignore */
      }
    }
    return this._exitGuard
  }

  // =========================================================================
  // 状态（status / 订阅视图）
  // =========================================================================

  status() {
    const now = Date.now()
    const policy = this.policy.current()
    const summary = this._subscription.summary || {}
    return {
      status: this._status.status,
      // 客户端 UI（client.js）消费 `state` 字段；两处保持一致。
      state: this._status.status,
      enabled: Boolean(this._state && this._state.enabled),
      connected: this._status.status === STATUS.RUNNING,
      killSwitch: { ...this._killSwitch },
      lastError: this._status.lastError,
      degradedReason: this._status.degradedReason,
      degradedAt: this._status.degradedAt,
      nodeName: this._status.nodeName,
      port: this._status.port,
      controllerPort: this._status.controllerPort,
      startedAt: this._status.startedAt,
      uptimeMs: this._status.startedAt ? now - this._status.startedAt : null,
      lastHealthMs: this._status.lastHealthMs,
      lastHealthAt: this._status.lastHealthAt,
      selfTestMs: this._status.selfTestMs,
      consecutiveFailures: this._status.consecutiveFailures,
      failureThreshold: this.config.failureThreshold,
      directFallback: this._status.directFallback,
      retry: {
        count: this._status.retryCount,
        nextRetryAt: this._status.nextRetryAt,
        retryIntervalMs: this.config.retryIntervalMs,
      },
      mode: this.config.mode,
      preferredNode: this.config.preferredNode,
      subscriptionUrl: maskUrl(this.config.subscriptionUrl),
      subscription: this._subscriptionView(),
      systemProxy: this._systemProxyStatus(),
      policy,
      engine: this._engineInfo(),
      config: {
        healthIntervalMs: this.config.healthIntervalMs,
        failureThreshold: this.config.failureThreshold,
        retryIntervalMs: this.config.retryIntervalMs,
        probeUrl: this.config.probeUrl,
        selfTestUrl: this.config.selfTestUrl,
        fallbackToDirect: this.config.fallbackToDirect,
        proxyPort: this.config.proxyPort,
        controllerPort: this.config.controllerPort,
        logLevel: this.config.logLevel,
      },
      dataDir: this.dataDir,
      dataDirSource: this._dataDirSource,
      cachePath: this.paths.subscription,
      engineModuleLoaded: isEngineModuleLoaded(),
      logs: this._logs.slice(-MAX_STATUS_LOGS),
      engineLogs: engineLogsTail(this._engine, 10),
    }
  }

  _subscriptionView() {
    const summary = this._subscription.summary || {}
    const info = this._subscription.info || {}
    const remainingTraffic = summary.remainingTraffic ?? null
    const expireDate = summary.expireDate ?? null
    const realUrl = this.config.subscriptionUrl || ''
    return {
      // 同源本地页面专用：url 返回真实地址供 UI 预填输入框；urlMasked 用于任何展示/日志。
      // 该响应不写日志、不带 CORS，token 本来就保存在服务端配置里。
      url: realUrl,
      urlMasked: maskUrl(realUrl),
      fromCache: Boolean(this._subscription.fromCache),
      updatedAt: this._subscription.updatedAt,
      error: this._subscription.error,
      nodeCount: summary.nodeCount ?? null,
      remainingTraffic,
      expireDate,
      expireAtIso: summary.expireAtIso ?? null,
      totalBytes: summary.totalBytes ?? null,
      totalBytesText: formatBytes(summary.totalBytes),
      updateIntervalHours:
        typeof summary.updateIntervalHours === 'number'
          ? summary.updateIntervalHours
          : typeof info.updateIntervalHours === 'number'
            ? info.updateIntervalHours
            : null,
      // 客户端 UI 的别名兼容（remainingTraffic/traffic、expireDate/expire）。
      traffic: remainingTraffic,
      expire: expireDate,
      reserved: summary.reserved ?? null,
      landingPage: summary.landingPage ?? null,
      summary,
      info: this._subscription.info,
      cachePath: this.paths.subscription,
    }
  }

  _engineInfo() {
    if (!this._engine) return null
    const info = { running: null, pid: null, logs: null }
    try {
      if (typeof this._engine.isRunning === 'function') info.running = Boolean(this._engine.isRunning())
    } catch {
      info.running = null
    }
    try {
      const snapshot = typeof this._engine.status === 'function' ? this._engine.status() : null
      if (snapshot && typeof snapshot === 'object') {
        info.pid = snapshot.pid ?? null
        if (snapshot.running !== undefined) info.running = snapshot.running
        if (snapshot.state !== undefined) info.state = snapshot.state
      }
    } catch {
      /* 忽略 */
    }
    return info
  }

  _setStatus(next, patch) {
    const allowed = [STATUS.DISABLED, STATUS.STARTING, STATUS.RUNNING, STATUS.DEGRADED, STATUS.FAILED]
    if (!allowed.includes(next)) return
    const previous = this._status.status
    this._status.status = next
    if (patch && typeof patch === 'object') Object.assign(this._status, patch)
    if (previous !== next) this._log('debug', 'dsh-vpn: 状态 ' + previous + ' -> ' + next)
  }

  // =========================================================================
  // 自动启动（apply 后延迟，绝不阻塞、绝不无条件接管）
  // =========================================================================

  /**
   * DSH 启动时若持久化 state.enabled=true 且 kill-switch 未生效，则延迟 autoStartDelayMs
   * 后在健康门控下自动接管。返回是否已调度，同步、永不抛错。
   */
  maybeAutoStart() {
    try {
      if (this._disposed) return { scheduled: false, reason: 'service disposed' }
      if (this._killSwitch.active) {
        this._log('warning', 'dsh-vpn: kill-switch 生效，跳过自动启动')
        return { scheduled: false, reason: 'kill-switch' }
      }
      if (!this._state || !this._state.enabled) return { scheduled: false, reason: 'state.enabled=false' }
      if (this._status.status !== STATUS.DISABLED) return { scheduled: false, reason: 'status=' + this._status.status }
      const delay = this.config.autoStartDelayMs
      const timer = setTimeout(() => {
        this._autoStartTimer = null
        this.enable({ auto: true })
          .then((result) => {
            if (!result || result.ok !== true) this._log('error', 'dsh-vpn: 自动启动失败: ' + (result && result.error ? result.error : 'unknown'))
          })
          .catch((error) => this._log('error', 'dsh-vpn: 自动启动异常: ' + errorMessage(error)))
      }, delay)
      if (timer && typeof timer.unref === 'function') timer.unref()
      this._autoStartTimer = timer
      this._log('info', 'dsh-vpn: ' + delay + 'ms 后自动启动（持久化 enabled=true）')
      return { scheduled: true, delayMs: delay }
    } catch (error) {
      this._log('error', 'dsh-vpn: maybeAutoStart 异常（已忽略）: ' + errorMessage(error))
      return { scheduled: false, reason: errorMessage(error) }
    }
  }

  // =========================================================================
  // 启停主链路
  // =========================================================================

  /** 启用：解析订阅 → 引擎启动 → health 门控 → 安装策略 → 进程内 fetch 自测 → running。 */
  enable(options = {}) {
    return this._runExclusive(() => this._enableLocked(options))
  }

  async _enableLocked(options = {}) {
    if (this._disposed) return { ok: false, error: 'service 已卸载', status: this.status() }
    if (this._killSwitch.active) {
      const error = 'kill-switch 生效（' + this._killSwitch.reason + '），拒绝启用；删除 flag / 取消环境变量后重试'
      this._setStatus(STATUS.DISABLED, { lastError: error })
      return { ok: false, error, status: this.status() }
    }
    if (this._status.status === STATUS.RUNNING) return { ok: true, already: true, status: this.status() }
    if (this._status.status === STATUS.STARTING) return { ok: false, error: '正在启动中，请稍候', status: this.status() }

    this._clearTimers()
    this._setStatus(STATUS.STARTING, {
      lastError: null,
      degradedReason: null,
      degradedAt: null,
      consecutiveFailures: 0,
      directFallback: false,
      retryCount: 0,
      nextRetryAt: null,
      selfTestMs: null,
      lastHealthMs: null,
    })
    this._log('info', 'dsh-vpn: 开始启用（' + (options && options.auto ? '自动' : '手动') + '）')

    let proxyInstalled = false
    try {
      const yaml = await this._resolveSubscriptionYaml({ forceRefresh: false })
      const ports = await this._allocatePorts()
      const runtimeYaml = await this._buildRuntime(yaml, ports)
      const engine = await this._startEngine(runtimeYaml)
      const health = await this._healthGate(engine)
      this._log('info', 'dsh-vpn: mihomo 健康检查通过（' + (health.ms == null ? '?' : health.ms) + 'ms），开始接管进程代理')
      await this.policy.installProxy(ports.mixedPort)
      proxyInstalled = true
      const selfTest = await this._postInstallSelfTest()
      this._runtime = { ...ports, builtAt: Date.now() }
      await this._applyPreferredNode(engine)
      const nodeName = await this._currentNodeName(engine)
      this._setStatus(STATUS.RUNNING, {
        port: ports.mixedPort,
        controllerPort: ports.controllerPort,
        startedAt: Date.now(),
        lastHealthMs: health.ms,
        lastHealthAt: Date.now(),
        selfTestMs: selfTest.ms,
        nodeName,
        lastError: null,
        degradedReason: null,
        directFallback: false,
      })
      this._state.enabled = true
      this._persist()
      this._startWatchdog()
      // 接管成功后：若用户意图为开系统代理 → 指向当前 mixed 端口（失败不使 enable 失败，只记 lastError）
      let systemProxyResult = null
      if (this._systemProxyDesired) systemProxyResult = this._applySystemProxyForRunning('enable')
      this._log('info', 'dsh-vpn: 已接管（mixed-port=' + ports.mixedPort + ', node=' + String(nodeName) + ', selfTest=' + selfTest.ms + 'ms）')
      return {
        ok: true,
        status: this.status(),
        nodeName,
        port: ports.mixedPort,
        controllerPort: ports.controllerPort,
        selfTestMs: selfTest.ms,
        systemProxy: systemProxyResult,
      }
    } catch (error) {
      const message = errorMessage(error)
      this._log('error', 'dsh-vpn: 启用失败: ' + message)
      if (proxyInstalled) {
        try {
          await this.policy.restore()
        } catch (restoreError) {
          this._log('warning', 'dsh-vpn: 回滚 restorePolicy 失败: ' + errorMessage(restoreError))
        }
        if (this.config.fallbackToDirect) {
          try {
            await this.policy.installDirect()
            this._log('warning', 'dsh-vpn: 失败回滚后已安装直连策略（安全网）')
          } catch (directError) {
            this._log('error', 'dsh-vpn: 回滚时安装直连策略失败（不影响进程）: ' + errorMessage(directError))
          }
        }
      }
      await this._stopEngineQuietly()
      this._setStatus(STATUS.FAILED, {
        lastError: message,
        port: null,
        controllerPort: null,
        startedAt: null,
        lastHealthMs: null,
        selfTestMs: null,
      })
      return { ok: false, error: message, status: this.status() }
    }
  }

  /** 停用：先恢复 launcher dispatcher，再停引擎；持久化 enabled=false。 */
  disable() {
    return this._runExclusive(() => this._disableLocked())
  }

  async _disableLocked() {
    this._clearTimers()
    this._log('info', 'dsh-vpn: 停用中（先还原系统代理/dispatcher，再停引擎）')
    // 先还原系统代理：如果既无法精确还原也无法安全关闭，则中止停用（否则浏览器会指向即将停止的端口）
    const systemProxyRestore = this._restoreSystemProxy('disable')
    if (systemProxyRestore && systemProxyRestore.abort) {
      this._log('error', 'dsh-vpn: 系统代理无法还原，已中止停用（VPN 保持运行，避免系统代理指向死端口）')
      return {
        ok: false,
        error:
          '停用已中止：无法还原系统代理，为避免浏览器指向已停止的端口，VPN 仍在运行: ' +
          String(systemProxyRestore.error || 'unknown'),
        status: this.status(),
      }
    }
    try {
      await this.policy.restore()
    } catch (error) {
      this._log('warning', 'dsh-vpn: 停用时 restorePolicy 失败: ' + errorMessage(error))
    }
    await this._stopEngineQuietly()
    this._runtime = null
    this._setStatus(STATUS.DISABLED, {
      lastError: null,
      degradedReason: null,
      degradedAt: null,
      nodeName: null,
      port: null,
      controllerPort: null,
      startedAt: null,
      lastHealthMs: null,
      lastHealthAt: null,
      selfTestMs: null,
      consecutiveFailures: 0,
      directFallback: false,
      retryCount: 0,
      nextRetryAt: null,
    })
    this._state.enabled = false
    this._persist()
    this._log('info', 'dsh-vpn: 已停用')
    return { ok: true, status: this.status() }
  }

  /** 插件卸载 / 进程退出清理：先恢复策略，再停引擎，绝不移除用户的 mihomo（只停自己启动的）。 */
  async shutdown() {
    if (this._disposed) return
    this._disposed = true
    this._clearTimers()
    this._log('info', 'dsh-vpn: 插件卸载，还原系统代理/dispatcher 并停止 mihomo')
    this._restoreSystemProxy('shutdown')
    try {
      this._exitGuard?.()
    } catch {
      /* ignore */
    }
    this._exitGuard = null
    try {
      await this.policy.dispose()
    } catch (error) {
      this._log('warning', 'dsh-vpn: shutdown 恢复 dispatcher 失败: ' + errorMessage(error))
    }
    await this._stopEngineQuietly()
    this._disposed = true
  }

  // =========================================================================
  // 引擎启动 / 健康 / 自测
  // =========================================================================

  async _ensureEngineModule() {
    if (this._engineModule) return this._engineModule
    const mod = await loadEngineModule((level, message) => this._log(level, message))
    this._engineModule = mod
    return mod
  }

  async _startEngine(runtimeYaml) {
    const mod = await this._ensureEngineModule()
    const binaryPath = resolveBinaryPath(mod, {
      configured: this.config.binaryPath,
      profileDir: this.config.profileDir,
      dataDir: this.dataDir,
      log: (level, message) => this._log(level, message),
    })
    const engine = createEngine(mod, {
      binaryPath,
      dataDir: this.dataDir,
      configPath: this.paths.runtime,
      log: this._engineLogSink,
    })
    this._log('info', 'dsh-vpn: 启动 mihomo（' + binaryPath + '）')
    await engine.start(runtimeYaml)
    this._engine = engine
    this._log('info', 'dsh-vpn: mihomo 已启动')
    return engine
  }

  async _stopEngineQuietly() {
    const engine = this._engine
    this._engine = null
    if (!engine) return
    let pid = null
    try {
      const snapshot = typeof engine.status === 'function' ? engine.status() : null
      pid = snapshot && Number.isInteger(snapshot.pid) ? snapshot.pid : null
    } catch {
      pid = null
    }
    try {
      await engine.stop()
      this._log('info', 'dsh-vpn: mihomo 已停止')
      return
    } catch (error) {
      this._log('warning', 'dsh-vpn: 停止 mihomo 失败（将兜底确认）: ' + errorMessage(error))
    }
    // engine.stop() 偶发在 taskkill 返回后立刻检查 pid、把「正在退出」误判为 stillAlive。
    // 这里再等一会复查；仍存活才对我们自己 spawn 的 pid 执行一次兜底 taskkill。
    await sleep(2000)
    let alive = isProcessAlive(pid)
    if (!alive) {
      this._log('info', 'dsh-vpn: mihomo 已在 stop 之后自行退出')
      return
    }
    this._log('warning', 'dsh-vpn: mihomo 仍在运行，兜底结束自己启动的 PID ' + String(pid))
    forceKillOwnPid(pid)
    for (let attempt = 0; attempt < 6 && alive; attempt += 1) {
      await sleep(500)
      alive = isProcessAlive(pid)
    }
    if (alive) {
      this._log('error', 'dsh-vpn: mihomo 仍未停止（PID ' + String(pid) + '），请手动 taskkill /PID ' + String(pid) + ' /T /F')
    } else {
      this._log('info', 'dsh-vpn: mihomo 已停止（兜底确认）')
    }
  }

  async _healthGate(engine) {
    let alive = true
    try {
      alive = typeof engine.isRunning === 'function' ? engine.isRunning() !== false : true
    } catch {
      alive = true
    }
    if (!alive) {
      const tail = engineLogsTail(engine, 8).join('\n')
      throw new Error('mihomo 启动后立即退出' + (tail ? '；最近日志:\n' + tail : ''))
    }
    const health = await probeEngineHealth(engine, this.config.probeUrl, HEALTH_TIMEOUT_MS)
    if (!isProbeOk(health)) throw new Error('mihomo 健康检查未通过: ' + describeProbe(health))
    return health
  }

  /**
   * 接管后的最后一道闸：进程内全局 fetch 必须真的走通。
   * 失败抛错 → 调用方立即回滚（restore + 可选 direct + 停引擎 + failed）。
   */
  async _postInstallSelfTest() {
    const fetchImpl = globalThis.fetch
    if (typeof fetchImpl !== 'function') throw new Error('当前进程没有全局 fetch，无法完成接管自测')
    const url = this.config.selfTestUrl
    const timeoutMs = this.config.selfTestTimeoutMs
    const started = Date.now()
    let status = null
    try {
      const options = { redirect: 'manual' }
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') options.signal = AbortSignal.timeout(timeoutMs)
      const response = await fetchImpl(url, options)
      status = response && Number.isFinite(response.status) ? response.status : null
      const acceptable = response && (response.ok === true || (status !== null && status >= 200 && status < 400))
      if (!acceptable) throw new Error('HTTP ' + String(status))
    } catch (error) {
      throw new Error('接管后进程内 fetch 自测失败（' + url + '）: ' + errorMessage(error))
    }
    const ms = Date.now() - started
    this._log('info', 'dsh-vpn: 接管后进程内 fetch 自测通过（HTTP ' + String(status) + '，' + ms + 'ms）')
    return { ms, status, url }
  }

  // =========================================================================
  // 订阅 / 运行时配置
  // =========================================================================

  async _resolveSubscriptionYaml({ forceRefresh } = {}) {
    const url = this.config.subscriptionUrl
    let fetchError = null
    if (url) {
      try {
        const sub = await this._fetchAndCache(url)
        return sub.clashYaml
      } catch (error) {
        fetchError = error
        this._log('warning', 'dsh-vpn: 订阅拉取失败，尝试本地缓存: ' + errorMessage(error))
      }
    }
    const cached = this._readCachedSync()
    if (cached) {
      this._subscription = {
        info: null,
        summary: summarizeYaml(cached),
        fromCache: true,
        updatedAt: this._cachedMtime(),
        cachePath: this.paths.subscription,
        error: fetchError ? errorMessage(fetchError) : null,
      }
      this._log('warning', 'dsh-vpn: 使用本地缓存订阅 YAML 启动（离线模式）：' + describeSummary(this._subscription.summary))
      return cached
    }
    if (fetchError) throw new Error('订阅拉取失败且没有本地缓存: ' + errorMessage(fetchError))
    throw new Error('未配置订阅地址且没有本地缓存：请先执行 vpn subscription <https://订阅地址>')
  }

  async _fetchAndCache(url) {
    const mod = await this._ensureEngineModule()
    const sub = await mod.fetchSubscription(url, {
      timeoutMs: this.config.fetchTimeoutMs,
      log: this._engineLogSink,
    })
    if (!sub || typeof sub.clashYaml !== 'string' || !sub.clashYaml.trim()) {
      throw new Error('订阅未返回 Clash YAML（格式不支持或站点异常）')
    }
    try {
      // 缓存必须是「原始 Clash YAML」（engine 的 writeCachedSubscription 只接受含 proxies: 的内容）；
      // links 格式订阅要存转换后的 clashYaml，不能存 base64/分享链接原文。
      writeCachedSubscription(mod, this.paths.subscription, sub.clashYaml || sub.raw, (level, message) => this._log(level, message))
    } catch (error) {
      this._log('warning', 'dsh-vpn: 写订阅缓存失败（不影响本次使用）: ' + errorMessage(error))
    }
    this._subscription = {
      info: sub.info || null,
      summary: summarizeYaml(sub.clashYaml, sub.info),
      fromCache: false,
      updatedAt: Date.now(),
      cachePath: this.paths.subscription,
      error: null,
    }
    this._log('info', 'dsh-vpn: 订阅已更新：' + describeSummary(this._subscription.summary))
    return sub
  }

  async _allocatePorts() {
    const mod = await this._ensureEngineModule()
    const mixedPort = this.config.proxyPort || (await pickFreePort(mod, 18000, 18999, (level, message) => this._log(level, message)))
    const controllerPort = this.config.controllerPort || (await pickFreePort(mod, 19000, 19999, (level, message) => this._log(level, message)))
    if (mixedPort === controllerPort) throw new Error('proxyPort 与 controllerPort 不能相同: ' + mixedPort)
    return { mixedPort, controllerPort, secret: randomSecret(24) }
  }

  async _buildRuntime(yaml, ports) {
    const mod = await this._ensureEngineModule()
    const logLevel = ['silent', 'error', 'warning', 'info', 'debug'].includes(this.config.logLevel)
      ? this.config.logLevel === 'warning'
        ? 'warning'
        : this.config.logLevel
      : 'warning'
    const runtimeYaml = buildRuntimeConfig(mod, {
      yaml,
      mixedPort: ports.mixedPort,
      controllerPort: ports.controllerPort,
      secret: ports.secret || randomSecret(24),
      mode: this.config.mode,
      logLevel,
    })
    // 显式关闭 profile 持久化（store-selected/store-fake-ip），避免 mihomo 往只读/受限
    // 数据目录写 cache.db 时刷 `[CacheFile] can't open cache file ... Access is denied` 警告。
    // 若 engine 侧（lib/engine/config.mjs）已经加了 profile 段，此函数是幂等的。
    return ensureProfileStoreDisabled(runtimeYaml)
  }

  async _applyPreferredNode(engine) {
    const preferred = this.config.preferredNode
    if (!preferred) return null
    try {
      const result = await this._selectOnEngine(engine, preferred)
      if (result && result.verified === false) {
        this._log(
          'warning',
          'dsh-vpn: 首选节点「' + preferred + '」选择后未生效（当前节点: ' + String((await this._currentNodeName(engine)) || '?') + '）',
        )
        return { node: preferred, group: result.group, verified: false }
      }
      this._log('info', 'dsh-vpn: 已应用首选节点 ' + preferred + (result.group ? '（' + result.group + '）' : ''))
      // 选择已验证生效时直接把 nodeName 定为 preferred（覆盖引擎解析到伪节点名之类的脏叶子场景）
      if (result.verified) this._status.nodeName = preferred
      return { node: preferred, group: result.group, verified: Boolean(result.verified) }
    } catch (error) {
      this._log('warning', 'dsh-vpn: 应用首选节点失败（忽略）: ' + errorMessage(error))
      return null
    }
  }

  /**
   * 在 mihomo 里切换到指定节点，并**沿着分组选择链验证真的生效**。
   *
   * rule 模式必须在订阅自己的「节点选择」类 Selector 分组里选（在 GLOBAL 里选不会改变规则路由）；
   * 选择后 `🔰 节点选择.now` 可能仍指向 `♻️ 自动选择`，需要递归解析到具体节点再比对。
   *
   * @returns {Promise<{group: string, verified: boolean}>}
   */
  async _selectOnEngine(engine, name) {
    if (this.config.mode === 'global') {
      try {
        await engine.selectGlobal(name)
        const verified = await this._verifyCurrentNode(engine, name)
        if (verified) return { group: 'GLOBAL', verified: true }
        // GLOBAL 选择未生效时继续按分组选择尝试
      } catch {
        /* 退回分组选择 */
      }
    }
    const proxies = await engine.proxies()
    const groups = Array.isArray(proxies && proxies.groups) ? proxies.groups : []
    // 注意：proxies().groups 含内建 GLOBAL，还可能含 Reject/直连开关组，全部排除。
    const candidates = groups.filter(
      (group) =>
        group &&
        typeof group.name === 'string' &&
        group.name !== 'GLOBAL' &&
        !NON_ROUTING_GROUP_RE.test(group.name) &&
        String(group.type || '').toLowerCase() === 'selector' &&
        Array.isArray(group.all) &&
        group.all.includes(name),
    )
    const ordered = [
      ...candidates.filter((group) => isPrimarySelectorGroup(group)),
      ...candidates.filter((group) => !isPrimarySelectorGroup(group)),
    ]
    let lastError = null
    for (const group of ordered) {
      try {
        await engine.selectInGroup(group.name, name)
        const verified = await this._verifyCurrentNode(engine, name)
        if (verified) return { group: group.name, verified: true }
        lastError = new Error('在分组「' + group.name + '」选择后当前节点仍不是「' + name + '」')
      } catch (error) {
        lastError = error
      }
    }
    // 最后兜底：GLOBAL（mode=global 才有路由意义；rule 模式下即便成功也可能不影响路由）。
    try {
      await engine.selectGlobal(name)
      const verified = await this._verifyCurrentNode(engine, name)
      return { group: 'GLOBAL', verified }
    } catch (error) {
      throw lastError || error || new Error('没有包含节点「' + name + '」的可选分组')
    }
  }

  /** 选择后校验：递归解析当前节点链（**不含 preferred 回退**），确认最终节点等于 name。 */
  async _verifyCurrentNode(engine, name) {
    try {
      const current = await this._currentNodeName(engine, { allowPreferredFallback: false })
      return current === name
    } catch {
      return false
    }
  }

  /**
   * 计算「当前实际出口节点」。
   *
   * 实测 /proxies 结构（Lead 真实宿主）：
   *   🔰 节点选择(Selector).now = ♻️ 自动选择
   *   ♻️ 自动选择(URLTest).now = 🇵🇭 菲律宾A[BGP]
   *   ⛔ Reject(Selector).now = REJECT
   *   🎯 全球直连(Selector).now = DIRECT
   * 所以必须：排除 GLOBAL / Reject / 直连开关组；优先「节点选择」类分组；再递归解析 now
   * （最多 5 层）；最终排除 DIRECT/REJECT 等控制值，以及**伪节点名**（如
   * `⚙️ 故障转移.now = "剩余流量：299.8 GB"` —— 订阅把它当合法 fallback 选项，但名字是广告）。
   *
   * 回退顺序：节点选择类 Selector 的干净叶子 → GLOBAL（global 模式）→ 首选节点（若干净且真实存在）
   * → 其它组干净叶子 → null（UI 显示「—」，绝不显示伪节点名/分组名）。
   * 选择校验时传 `{ allowPreferredFallback: false }`，避免把"用户首选"误判成选择已生效。
   */
  async _currentNodeName(engine, options = {}) {
    const allowPreferredFallback = !options || options.allowPreferredFallback !== false
    const preferred = typeof this.config.preferredNode === 'string' ? this.config.preferredNode.trim() : ''
    const preferredUsable = () => allowPreferredFallback && Boolean(preferred) && !this._isPseudoNode(preferred)
    try {
      const proxies = await engine.proxies()
      const groups = Array.isArray(proxies && proxies.groups) ? proxies.groups : []
      const nodes = Array.isArray(proxies && proxies.nodes) ? proxies.nodes : []
      const nodeNames = new Set(
        nodes
          .map((node) => node && node.name)
          .filter((name) => typeof name === 'string' && name && !this._isPseudoNode(name)),
      )
      const preferredExists = preferredUsable() && (nodeNames.size === 0 || nodeNames.has(preferred))
      const groupsByName = new Map(
        groups.filter((group) => group && typeof group.name === 'string').map((group) => [group.name, group]),
      )
      const resolve = (start) => {
        const value = resolveGroupChain(groupsByName, start)
        if (!value || isControlTarget(value) || this._isPseudoNode(value)) return null
        return value
      }

      if (this.config.mode === 'global') {
        // global 模式下实际出口只由 GLOBAL 选择器决定：
        // 链解析到真节点才返回；若是 DIRECT/REJECT/伪节点名 → null（不要拿 rule 分组冒充）
        return resolve(proxies && proxies.global && proxies.global.now)
      }

      const sourceGroups = groups.filter(
        (group) =>
          group &&
          typeof group.name === 'string' &&
          group.name !== 'GLOBAL' &&
          !NON_ROUTING_GROUP_RE.test(group.name) &&
          typeof group.now === 'string' &&
          group.now,
      )
      const primary = sourceGroups.filter((group) => isPrimarySelectorGroup(group))
      const others = sourceGroups.filter((group) => !isPrimarySelectorGroup(group))
      const orderedOthers = [
        ...others.filter((group) => String(group.type || '').toLowerCase() === 'selector'),
        ...others.filter((group) => String(group.type || '').toLowerCase() !== 'selector'),
      ]

      if (primary.length > 0) {
        // 1) 节点选择类分组：按顺序取第一个解析出干净叶子的
        for (const group of primary) {
          const value = resolve(group.now)
          if (value) return value
        }
        // 2) 首选节点回退（链落到伪节点名/控制值等脏叶子时；用户意图优先于乱猜）
        if (preferredExists) return preferred
        // 节点选择类分组存在但链不干净：不拿其它不相干分组的节点冒充「当前节点」→ null
        return null
      }

      // 没有「节点选择」类分组时的兜底：其它组（Selector 优先）
      for (const group of orderedOthers) {
        const value = resolve(group.now)
        if (value) return value
      }
      if (preferredExists) return preferred
      const fromGlobal = resolve(proxies && proxies.global && proxies.global.now)
      if (fromGlobal) return fromGlobal
      return null
    } catch {
      if (preferredUsable()) return preferred
      return null
    }
  }

  // =========================================================================
  // 订阅 / 模式 / 节点 公开操作（工具与 HTTP API 共用）
  // =========================================================================

  setSubscription(url) {
    return this._runExclusive(async () => {
      if (this._disposed) return { ok: false, error: 'service 已卸载', status: this.status() }
      const rawUrl = String(url ?? '').trim()
      if (!rawUrl) return { ok: false, error: '缺少订阅地址（https://…）', status: this.status() }
      let parsed
      try {
        parsed = new URL(rawUrl)
      } catch {
        return { ok: false, error: '订阅地址不是合法 URL', status: this.status() }
      }
      if (parsed.protocol !== 'https:') return { ok: false, error: '订阅地址必须是 https://（拒绝明文 http）', status: this.status() }
      try {
        await this._fetchAndCache(rawUrl)
      } catch (error) {
        const message = errorMessage(error)
        this._log('error', 'dsh-vpn: 拉取新订阅失败: ' + message)
        return { ok: false, error: '拉取订阅失败，已保留原配置: ' + message, status: this.status() }
      }
      this.config.subscriptionUrl = rawUrl
      this._status.subscriptionUrl = maskUrl(rawUrl)
      this._state.subscriptionUrl = rawUrl
      this._persist()
      const applied = await this._applyConfigChange('subscription')
      if (applied && applied.ok === false) return { ok: false, error: '订阅已保存，但应用失败: ' + applied.error, status: this.status() }
      return { ok: true, subscription: this._subscriptionView(), applied, status: this.status() }
    })
  }

  updateSubscription() {
    return this._runExclusive(async () => {
      if (this._disposed) return { ok: false, error: 'service 已卸载', status: this.status() }
      if (!this.config.subscriptionUrl) return { ok: false, error: '未配置订阅地址，请先 vpn subscription <https://…>', status: this.status() }
      try {
        await this._fetchAndCache(this.config.subscriptionUrl)
      } catch (error) {
        const message = errorMessage(error)
        this._log('error', 'dsh-vpn: 更新订阅失败: ' + message)
        return { ok: false, error: message, status: this.status() }
      }
      const applied = await this._applyConfigChange('subscription')
      if (applied && applied.ok === false) return { ok: false, error: '订阅已更新，但应用失败: ' + applied.error, status: this.status() }
      return { ok: true, subscription: this._subscriptionView(), applied, status: this.status() }
    })
  }

  setMode(mode) {
    return this._runExclusive(async () => {
      const next = String(mode ?? '').trim().toLowerCase()
      if (!MODES.includes(next)) return { ok: false, error: 'mode 只能是 rule 或 global', status: this.status() }
      if (this.config.mode === next) return { ok: true, mode: next, unchanged: true, status: this.status() }
      this.config.mode = next
      this._status.mode = next
      this._state.mode = next
      this._persist()
      let applied = { ok: true, applied: false, reason: 'VPN 未运行，配置已保存，下次启用生效' }
      if (this._status.status === STATUS.RUNNING) applied = await this._applyConfigChange('mode')
      if (applied && applied.ok === false) return { ok: false, error: '模式已保存，但热应用失败: ' + applied.error, status: this.status() }
      this._log('info', 'dsh-vpn: 模式切换为 ' + next)
      return { ok: true, mode: next, applied, status: this.status() }
    })
  }

  /**
   * running 状态下热应用新配置：先 engine.reload + health；失败则完整重启引擎（端口可能变化，
   * 需要重装策略并重新自测）；再失败 → 回滚到直连安全网并进入 degraded + 自动重试。
   */
  async _applyConfigChange(kind) {
    if (this._status.status !== STATUS.RUNNING || !this._engine) {
      return { ok: true, applied: false, reason: 'VPN 未运行，配置已保存，下次启用生效', mode: null }
    }
    const engine = this._engine
    const previousPort = this._status.port
    const previousController = this._status.controllerPort
    const previousSecret = this._runtime ? this._runtime.secret : null
    try {
      const yaml = await this._resolveSubscriptionYaml({ forceRefresh: kind === 'subscription' })
      const runtimeYaml = await this._buildRuntime(yaml, {
        mixedPort: previousPort,
        controllerPort: previousController,
        secret: previousSecret || randomSecret(24),
      })
      await engine.reload(runtimeYaml)
      const health = await this._healthGate(engine)
      this._runtime = { mixedPort: previousPort, controllerPort: previousController, secret: previousSecret, builtAt: Date.now() }
      this._status.lastHealthMs = health.ms
      this._status.lastHealthAt = Date.now()
      this._log('info', 'dsh-vpn: 配置热重载成功（' + kind + '，无需重装策略）')
      return { ok: true, applied: true, mode: 'reload' }
    } catch (reloadError) {
      this._log('warning', 'dsh-vpn: 热重载失败（' + kind + '），尝试完整重启引擎: ' + errorMessage(reloadError))
    }
    try {
      await this._stopEngineQuietly()
      const yaml = await this._resolveSubscriptionYaml({ forceRefresh: false })
      const ports = await this._allocatePorts()
      const runtimeYaml = await this._buildRuntime(yaml, ports)
      const engine2 = await this._startEngine(runtimeYaml)
      const health = await this._healthGate(engine2)
      await this.policy.installProxy(ports.mixedPort)
      const selfTest = await this._postInstallSelfTest()
      this._runtime = { ...ports, builtAt: Date.now() }
      await this._applyPreferredNode(engine2)
      const nodeName = await this._currentNodeName(engine2)
      this._setStatus(STATUS.RUNNING, {
        port: ports.mixedPort,
        controllerPort: ports.controllerPort,
        lastHealthMs: health.ms,
        lastHealthAt: Date.now(),
        selfTestMs: selfTest.ms,
        nodeName,
        lastError: null,
      })
      if (this._systemProxyDesired) this._applySystemProxyForRunning('config-restart')
      return { ok: true, applied: true, mode: 'restart' }
    } catch (restartError) {
      const message = errorMessage(restartError)
      this._log('error', 'dsh-vpn: 配置应用失败，回滚到直连安全网: ' + message)
      try {
        await this.policy.restore()
      } catch {
        /* 忽略 */
      }
      if (this.config.fallbackToDirect) {
        try {
          await this.policy.installDirect()
        } catch (directError) {
          this._log('error', 'dsh-vpn: 回滚直连策略失败（不影响进程）: ' + errorMessage(directError))
        }
      }
      await this._stopEngineQuietly()
      this._setStatus(STATUS.DEGRADED, {
        lastError: message,
        degradedReason: message,
        degradedAt: Date.now(),
        port: null,
        startedAt: null,
      })
      this._scheduleRetry()
      return { ok: false, error: message, applied: false }
    }
  }

  // =========================================================================
  // 节点
  // =========================================================================

  /**
   * 伪节点判定：优先用 engine 导出的 isPseudoNodeName（与订阅解析保持一致），
   * engine 模块尚未加载时退回本地同义实现。
   */
  _isPseudoNode(name) {
    const mod = this._engineModule
    if (mod && typeof mod.isPseudoNodeName === 'function') {
      try {
        return Boolean(mod.isPseudoNodeName(name))
      } catch {
        /* 退回本地实现 */
      }
    }
    return isPseudoNodeName(name)
  }

  listNodes() {
    return this._runExclusive(async () => {
      const base = { current: this.config.preferredNode || null, status: this.status() }
      if (this._engine && (this._status.status === STATUS.RUNNING || this._status.status === STATUS.STARTING || this._status.status === STATUS.DEGRADED)) {
        try {
          const proxies = await this._engine.proxies()
          const rawNodes = Array.isArray(proxies && proxies.nodes) ? proxies.nodes : []
          const seen = new Set()
          const nodes = []
          for (const node of rawNodes) {
            if (!node || typeof node.name !== 'string' || !node.name) continue
            if (this._isPseudoNode(node.name) || seen.has(node.name)) continue
            seen.add(node.name)
            // mihomo /proxies 的 type 是原始大小写（Vless/Shadowsocks/Vmess），保留原值。
            nodes.push({ name: node.name, type: node.type || 'unknown', delay: null })
          }
          const rawGroups = Array.isArray(proxies && proxies.groups) ? proxies.groups : []
          const groups = rawGroups.map((group) => ({
            name: group.name,
            type: group.type || 'unknown',
            now: group.now || null,
            all: Array.isArray(group.all) ? group.all : [],
          }))
          let current = base.current
          try {
            current = await this._currentNodeName(this._engine)
          } catch {
            /* 保留 base.current */
          }
          return { ok: true, running: true, source: 'engine', current, nodes, groups, ...base, status: this.status() }
        } catch (error) {
          this._log('warning', 'dsh-vpn: 读取运行中节点失败，回退缓存: ' + errorMessage(error))
        }
      }
      try {
        const mod = await this._ensureEngineModule()
        const cached = this._readCachedSync()
        if (cached) {
          const parsed = parseNodesFromYaml(mod, cached)
          return { ok: true, running: false, source: 'cache', current: base.current, nodes: parsed.nodes, groups: parsed.groups, status: this.status() }
        }
      } catch (error) {
        return { ok: false, running: false, source: 'none', current: base.current, nodes: [], groups: [], error: errorMessage(error), status: this.status() }
      }
      return { ok: true, running: false, source: 'none', current: base.current, nodes: [], groups: [], status: this.status() }
    })
  }

  selectNode(name) {
    return this._runExclusive(async () => {
      const nodeName = String(name ?? '').trim()
      if (!nodeName) return { ok: false, error: '缺少 node 参数（节点名）', status: this.status() }
      const engine = this._engine
      const remember = () => {
        this.config.preferredNode = nodeName
        this._status.preferredNode = nodeName
        this._state.preferredNode = nodeName
        this._persist()
      }
      if (!engine || this._status.status !== STATUS.RUNNING) {
        remember()
        return { ok: true, node: nodeName, applied: false, note: 'VPN 未运行，已记录为下次启用时的首选节点', status: this.status() }
      }
      try {
        const result = await this._selectOnEngine(engine, nodeName)
        if (result && result.verified === false) {
          const current = await this._currentNodeName(engine)
          return {
            ok: false,
            node: nodeName,
            applied: false,
            group: result.group || null,
            error: '切换节点未生效：当前节点仍是「' + String(current || '?') + '」（该节点可能只存在于自动选择组，需在节点选择组中直接可选）',
            status: this.status(),
          }
        }
        remember()
        this._status.nodeName = nodeName
        this._log(
          'info',
          'dsh-vpn: 已切换节点 -> ' + nodeName + (result.group ? '（' + result.group + '）' : '') + '（已验证生效）',
        )
        return { ok: true, node: nodeName, applied: true, group: result.group, verified: true, status: this.status() }
      } catch (error) {
        return { ok: false, error: '切换节点失败: ' + errorMessage(error), status: this.status() }
      }
    })
  }

  /** 并发 8 对所有节点做一次 HTTP delay 测速；只读操作，不进串行队列。 */
  async testNodes() {
    if (this._disposed) return { ok: false, error: 'service 已卸载', nodes: [], status: this.status() }
    const engine = this._engine
    if (!engine || this._status.status !== STATUS.RUNNING) {
      return { ok: false, error: 'VPN 未运行，无法测速（先 enable）', nodes: [], status: this.status() }
    }
    let proxies
    try {
      proxies = await engine.proxies()
    } catch (error) {
      return { ok: false, error: '读取节点失败: ' + errorMessage(error), nodes: [], status: this.status() }
    }
    const rawNodes = Array.isArray(proxies && proxies.nodes) ? proxies.nodes : []
    const seen = new Set()
    const nodes = []
    for (const node of rawNodes) {
      if (!node || typeof node.name !== 'string' || !node.name) continue
      if (this._isPseudoNode(node.name) || seen.has(node.name)) continue
      seen.add(node.name)
      nodes.push({ name: node.name, type: node.type || 'unknown' })
    }
    const url = this.config.probeUrl
    const results = new Array(nodes.length)
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= nodes.length) return
        const node = nodes[index]
        try {
          const raw = await engine.delay(node.name, url, NODE_TEST_TIMEOUT_MS)
          // engine.delay() 契约：{ ok, name, url, delay?, error? }（失败不抛错）
          const numeric = raw && typeof raw === 'object' ? Number(raw.delay) : typeof raw === 'number' ? raw : NaN
          const failed = Boolean(raw && typeof raw === 'object' && raw.ok === false)
          const ok = !failed && Number.isFinite(numeric) && numeric > 0
          results[index] = {
            name: node.name,
            type: node.type,
            ok,
            delay: ok ? numeric : null,
            error: ok ? null : (raw && raw.error) || 'timeout',
          }
        } catch (error) {
          results[index] = { name: node.name, type: node.type, ok: false, delay: null, error: errorMessage(error) }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(NODE_TEST_CONCURRENCY, nodes.length) }, () => worker()))
    return {
      ok: true,
      testedAt: Date.now(),
      concurrency: NODE_TEST_CONCURRENCY,
      timeoutMs: NODE_TEST_TIMEOUT_MS,
      nodes: results,
      available: results.filter((item) => item && item.ok).length,
      total: results.length,
      status: this.status(),
    }
  }

  // =========================================================================
  // 看门狗 / 降级 / 恢复
  // =========================================================================

  _clearTimers() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer)
      this._watchdogTimer = null
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer)
      this._retryTimer = null
    }
    if (this._autoStartTimer) {
      clearTimeout(this._autoStartTimer)
      this._autoStartTimer = null
    }
  }

  _startWatchdog() {
    this._stopWatchdog()
    const interval = this.config.healthIntervalMs
    this._watchdogTimer = setInterval(() => {
      this._runExclusive(() => this._watchdogTick()).catch((error) => {
        this._log('error', 'dsh-vpn: watchdog tick 异常（已忽略）: ' + errorMessage(error))
      })
    }, interval)
    if (this._watchdogTimer && typeof this._watchdogTimer.unref === 'function') this._watchdogTimer.unref()
    this._log('debug', 'dsh-vpn: watchdog 已启动，间隔 ' + interval + 'ms，阈值 ' + this.config.failureThreshold)
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer)
      this._watchdogTimer = null
    }
  }

  async _watchdogTick() {
    if (this._disposed) return
    if (this._status.status !== STATUS.RUNNING) return
    const port = this._status.port
    if (!port) {
      await this._enterDegraded('watchdog: 运行中却没有可用端口')
      return
    }
    const mod = this._engineModule
    let probe
    if (mod && typeof mod.probeThroughProxy === 'function') {
      probe = await probeThroughProxy(mod, port, this.config.probeUrl, HEALTH_TIMEOUT_MS)
    } else {
      probe = { ok: false, ms: null, status: null, error: 'engine 模块不可用' }
    }
    let engineAlive = true
    try {
      engineAlive = this._engine ? this._engine.isRunning() !== false : false
    } catch {
      engineAlive = false
    }
    if (probe.ok && engineAlive) {
      this._status.consecutiveFailures = 0
      this._status.lastHealthMs = probe.ms
      this._status.lastHealthAt = Date.now()
      this._status.lastError = null
      return
    }
    const reason = engineAlive ? describeProbe(probe) : 'mihomo 进程已退出'
    this._status.consecutiveFailures += 1
    this._status.lastError =
      '健康检查失败（' + this._status.consecutiveFailures + '/' + this.config.failureThreshold + '）: ' + reason
    this._log('warning', 'dsh-vpn: ' + this._status.lastError)
    if (this._status.consecutiveFailures >= this.config.failureThreshold) {
      await this._enterDegraded(this._status.lastError)
    }
  }

  /**
   * 降级：立即恢复 launcher dispatcher → fallbackToDirect 时安装直连安全网 → 停引擎 → 定时重试。
   * 这里任何一步失败都只记日志，绝不向上抛错。
   */
  async _enterDegraded(reason) {
    if (this._disposed) return
    if (this._status.status === STATUS.DEGRADED) return
    this._stopWatchdog()
    this._setStatus(STATUS.DEGRADED, {
      degradedReason: reason,
      degradedAt: Date.now(),
      lastError: reason,
      consecutiveFailures: this.config.failureThreshold,
    })
    this._log('error', 'dsh-vpn: 连续健康检查失败，立即恢复直连策略（degraded）: ' + String(reason))
    try {
      await this.policy.restore()
    } catch (error) {
      this._log('warning', 'dsh-vpn: degraded 恢复 launcher dispatcher 失败: ' + errorMessage(error))
    }
    if (this.config.fallbackToDirect) {
      try {
        await this.policy.installDirect()
        this._status.directFallback = true
        this._log('warning', 'dsh-vpn: 已安装直连策略（安全网），DSH 至少可直连出网')
      } catch (error) {
        this._status.directFallback = false
        this._log('error', 'dsh-vpn: 安装直连策略失败（继续用 launcher dispatcher，不抛错）: ' + errorMessage(error))
      }
    } else {
      this._status.directFallback = false
    }
    // 引擎即将停止：先还原系统代理（精确还原失败会退化为安全关闭），绝不让浏览器指向死端口
    this._restoreSystemProxy('degraded')
    await this._stopEngineQuietly()
    this._status.port = null
    this._status.startedAt = null
    this._status.nodeName = null
    this._scheduleRetry()
  }

  _scheduleRetry() {
    if (this._disposed) return
    if (this._retryTimer) {
      clearTimeout(this._retryTimer)
      this._retryTimer = null
    }
    const interval = this.config.retryIntervalMs
    this._status.retryCount = (this._status.retryCount || 0) + 1
    this._status.nextRetryAt = Date.now() + interval
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      this._runExclusive(() => this._recover()).catch((error) => {
        this._log('error', 'dsh-vpn: 恢复尝试异常（已忽略）: ' + errorMessage(error))
        this._scheduleRetry()
      })
    }, interval)
    if (this._retryTimer && typeof this._retryTimer.unref === 'function') this._retryTimer.unref()
    this._log('warning', 'dsh-vpn: ' + Math.round(interval / 1000) + 's 后尝试恢复（第 ' + this._status.retryCount + ' 次）')
  }

  async _recover() {
    if (this._disposed) return
    if (this._status.status !== STATUS.DEGRADED) return
    this._log('info', 'dsh-vpn: 开始恢复尝试（重拉订阅/重启引擎/重新接管）')
    this._setStatus(STATUS.STARTING, { lastError: this._status.lastError })
    let proxyInstalled = false
    try {
      const yaml = await this._resolveSubscriptionYaml({ forceRefresh: true })
      const ports = await this._allocatePorts()
      const runtimeYaml = await this._buildRuntime(yaml, ports)
      const engine = await this._startEngine(runtimeYaml)
      const health = await this._healthGate(engine)
      await this.policy.installProxy(ports.mixedPort)
      proxyInstalled = true
      const selfTest = await this._postInstallSelfTest()
      this._runtime = { ...ports, builtAt: Date.now() }
      await this._applyPreferredNode(engine)
      const nodeName = await this._currentNodeName(engine)
      this._setStatus(STATUS.RUNNING, {
        port: ports.mixedPort,
        controllerPort: ports.controllerPort,
        startedAt: Date.now(),
        lastHealthMs: health.ms,
        lastHealthAt: Date.now(),
        selfTestMs: selfTest.ms,
        nodeName,
        lastError: null,
        degradedReason: null,
        degradedAt: null,
        consecutiveFailures: 0,
        directFallback: false,
        nextRetryAt: null,
        retryCount: 0,
      })
      this._log('info', 'dsh-vpn: 恢复成功，重新接管进程代理（mixed-port=' + ports.mixedPort + '）')
      this._startWatchdog()
      if (this._systemProxyDesired) this._applySystemProxyForRunning('recover')
    } catch (error) {
      const message = errorMessage(error)
      this._log('error', 'dsh-vpn: 恢复失败，保持 degraded，继续重试: ' + message)
      if (proxyInstalled) {
        try {
          await this.policy.restore()
        } catch {
          /* 忽略 */
        }
      }
      await this._stopEngineQuietly()
      if (this.config.fallbackToDirect) {
        try {
          const current = this.policy.current()
          if (!current.direct) await this.policy.installDirect()
          this._status.directFallback = true
        } catch (directError) {
          this._status.directFallback = false
          this._log('error', 'dsh-vpn: 恢复失败后安装直连策略失败（不影响进程）: ' + errorMessage(directError))
        }
      }
      const degradedReason = this._status.degradedReason
      this._setStatus(STATUS.DEGRADED, {
        lastError: '恢复失败: ' + message,
        degradedReason,
        degradedAt: Date.now(),
        port: null,
        startedAt: null,
        consecutiveFailures: 0,
      })
      this._scheduleRetry()
    }
  }

  // =========================================================================
  // 诊断辅助
  // =========================================================================

  /** 最近日志（供 tool / HTTP 诊断）。 */
  logs(limit = 100) {
    const count = Math.max(1, Math.min(200, Number(limit) || 100))
    return this._logs.slice(-count)
  }

  /** 一句话状态摘要（tool render 用）。 */
  describeStatus(status = this.status()) {
    const lines = []
    lines.push('状态: ' + status.status + (status.connected ? '（已接管进程代理）' : ''))
    if (status.port) lines.push('mixed-port: ' + status.port + '  controller-port: ' + (status.controllerPort || '?'))
    if (status.nodeName) lines.push('当前节点: ' + status.nodeName)
    lines.push('模式: ' + status.mode + (status.preferredNode ? '  首选节点: ' + status.preferredNode : ''))
    if (status.lastHealthMs != null) lines.push('最近健康检查: ' + status.lastHealthMs + 'ms')
    if (status.selfTestMs != null) lines.push('接管自测: ' + status.selfTestMs + 'ms')
    if (status.subscriptionUrl) lines.push('订阅: ' + status.subscriptionUrl)
    const summaryText = describeSummary(status.subscription && status.subscription.summary)
    if (summaryText) lines.push('订阅摘要: ' + summaryText)
    if (status.policy && status.policy.active) {
      lines.push(
        '进程代理策略: ' +
          (status.policy.direct ? '直连' : '代理 ' + (status.policy.proxyUrl || '?')) +
          '（通路: ' + (status.policy.active.via || '?') + '）',
      )
    } else if (status.policy && status.policy.takeoverAvailable === false) {
      lines.push('进程代理策略: 不可用（' + (status.policy.lastError || 'dsh-http-proxy/undici 均不可用') + '）')
    }
    const systemProxy = status.systemProxy
    if (systemProxy) {
      if (!systemProxy.supported) {
        lines.push('系统代理: 不支持（' + (systemProxy.lastError || '仅 Windows') + '）')
      } else if (systemProxy.applied) {
        lines.push('系统代理: 已开启（浏览器/本机软件 → ' + (systemProxy.target || '?') + '）')
      } else if (systemProxy.enabled) {
        lines.push(
          '系统代理: 已设为开启意图但当前未生效' +
            (systemProxy.drift ? '（系统代理已被其他程序改动，可再次开启）' : '') +
            (systemProxy.proxyServer ? '，当前值: ' + systemProxy.proxyServer : ''),
        )
      } else {
        lines.push('系统代理: 未开启' + (systemProxy.proxyServer ? '（当前: ' + systemProxy.proxyServer + '）' : ''))
      }
      if (systemProxy.original && systemProxy.original.proxyServer) {
        lines.push('系统代理原值: ' + systemProxy.original.proxyServer + '（关闭时会精确还原）')
      }
      if (systemProxy.lastError) lines.push('系统代理错误: ' + truncateText(systemProxy.lastError, 400))
    }
    if (status.killSwitch && status.killSwitch.active) lines.push('kill-switch: 生效（' + status.killSwitch.reason + '）')
    if (status.lastError) lines.push('最近错误: ' + truncateText(status.lastError, 800))
    if (status.degradedReason && status.degradedReason !== status.lastError) lines.push('降级原因: ' + truncateText(status.degradedReason, 800))
    return lines.join('\n')
  }
}

export default VpnService
