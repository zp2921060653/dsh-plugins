// dsh-vpn Host 侧纯逻辑模块（无 dsh / 无 engine 依赖，可由普通 node 直接 import 自测）。
//
// 职责：
//   1. Config 归一化（cordis patch 传入的 raw config → 安全默认值）
//   2. dataDir / state.json / subscription.yaml / disable.flag 路径解析
//   3. state.json 原子写 + 损坏容错读取（损坏 → 默认 disabled）
//   4. kill-switch：`<dataDir>/disable.flag` 或环境变量 `DSH_VPN_DISABLED=1`
//   5. 订阅摘要解析（节点数 / 剩余流量 / 到期 / 落地页）+ URL 脱敏
//   6. 健康探测结果归一化（probeThroughProxy / health 的返回值形状兼容）
//
// 这里刻意不 import node 之外的任何包，也不 import ../engine，保证：
//   node -e "import('./lib/host/state.mjs')" 在普通 node 下可用。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 插件状态机取值。 */
export const STATUS = Object.freeze({
  DISABLED: 'disabled',
  STARTING: 'starting',
  RUNNING: 'running',
  DEGRADED: 'degraded',
  FAILED: 'failed',
})

export const MODES = Object.freeze(['rule', 'global'])
export const LOG_LEVELS = Object.freeze(['silent', 'error', 'warning', 'info', 'debug'])

/** kill-switch 环境变量名。 */
export const KILL_SWITCH_ENV = 'DSH_VPN_DISABLED'
/** kill-switch 标志文件名（放在 dataDir 下，用户建/删文件即可救援）。 */
export const KILL_SWITCH_FILE = 'disable.flag'

/** 代理策略必须绕过的 loopback（与 @deepseek-ai/dsh-http-proxy 的 LOOPBACK_NO_PROXY 对齐）。 */
export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,[::1]'

/** 健康探测 URL（HTTP 204，经代理取回很快）。 */
export const DEFAULT_PROBE_URL = 'http://www.gstatic.com/generate_204'
/** 接管后的进程内 fetch 自测 URL（必须 https，验证 TLS 通道真的通）。 */
export const DEFAULT_SELF_TEST_URL = 'https://www.gstatic.com/generate_204'

/** 插件 Config 的默认值；index.js 的 Schema 默认值必须与之保持一致。 */
export const DEFAULT_CONFIG = Object.freeze({
  subscriptionUrl: '',
  enabled: false,
  mode: 'rule',
  preferredNode: '',
  proxyPort: 0,
  controllerPort: 0,
  healthIntervalMs: 30000,
  failureThreshold: 3,
  retryIntervalMs: 60000,
  probeUrl: DEFAULT_PROBE_URL,
  selfTestUrl: DEFAULT_SELF_TEST_URL,
  selfTestTimeoutMs: 10000,
  binaryPath: '',
  dataDir: '',
  fallbackToDirect: true,
  logLevel: 'warning',
  fetchTimeoutMs: 30000,
  autoStartDelayMs: 3000,
  // 系统代理（Windows WinINET）：接管成功后是否同时把系统代理指向插件 mixed 端口。
  systemProxy: false,
  // 停用/卸载/退出时是否精确还原用户原系统代理（false 时退化为安全关闭 ProxyEnable）。
  systemProxyRestoreOnStop: true,
})

const MAX_TIMER = 24 * 60 * 60 * 1000

function toInt(value, fallback, min = 0, max = MAX_TIMER) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1' || value === 1) return true
  if (value === 'false' || value === '0' || value === 0) return false
  return fallback
}

function toStr(value, fallback = '') {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return fallback
  return String(value)
}

function toPort(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n < 0 || n > 65535) return 0
  return n
}

function toUrl(value, fallback) {
  const s = toStr(value, '').trim()
  if (!s) return fallback
  try {
    const parsed = new URL(s)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback
    return s
  } catch {
    return fallback
  }
}

/**
 * 归一化插件 Config（raw 来自 cordis patch；已由 Schema 校验过，但这里做防御）。
 * 不会抛错：非法值一律回退默认值。
 */
export function normalizeConfig(raw, env = process.env) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULT_CONFIG }
  cfg.subscriptionUrl = toStr(input.subscriptionUrl, '').trim()
  cfg.enabled = toBool(input.enabled, DEFAULT_CONFIG.enabled)
  cfg.mode = MODES.includes(input.mode) ? input.mode : DEFAULT_CONFIG.mode
  cfg.preferredNode = toStr(input.preferredNode, '').trim()
  cfg.proxyPort = toPort(input.proxyPort)
  cfg.controllerPort = toPort(input.controllerPort)
  cfg.healthIntervalMs = toInt(input.healthIntervalMs, DEFAULT_CONFIG.healthIntervalMs, 1000)
  cfg.failureThreshold = toInt(input.failureThreshold, DEFAULT_CONFIG.failureThreshold, 1, 100)
  cfg.retryIntervalMs = toInt(input.retryIntervalMs, DEFAULT_CONFIG.retryIntervalMs, 2000)
  cfg.probeUrl = toUrl(input.probeUrl, DEFAULT_CONFIG.probeUrl)
  cfg.selfTestUrl = toUrl(input.selfTestUrl, DEFAULT_CONFIG.selfTestUrl)
  cfg.selfTestTimeoutMs = toInt(input.selfTestTimeoutMs, DEFAULT_CONFIG.selfTestTimeoutMs, 1000, 120000)
  cfg.binaryPath = toStr(input.binaryPath, '').trim()
  cfg.dataDir = toStr(input.dataDir, '').trim()
  cfg.fallbackToDirect = toBool(input.fallbackToDirect, DEFAULT_CONFIG.fallbackToDirect)
  cfg.logLevel = LOG_LEVELS.includes(input.logLevel) ? input.logLevel : DEFAULT_CONFIG.logLevel
  cfg.fetchTimeoutMs = toInt(input.fetchTimeoutMs, DEFAULT_CONFIG.fetchTimeoutMs, 1000, 300000)
  cfg.autoStartDelayMs = toInt(input.autoStartDelayMs, DEFAULT_CONFIG.autoStartDelayMs, 0, 120000)
  cfg.systemProxy = toBool(input.systemProxy, DEFAULT_CONFIG.systemProxy)
  cfg.systemProxyRestoreOnStop = toBool(input.systemProxyRestoreOnStop, DEFAULT_CONFIG.systemProxyRestoreOnStop)
  // 内部字段（不在 Schema 里暴露）：profileDir 用于解析默认 dataDir / binaryPath。
  cfg.profileDir = toStr(env && env.DSH_PROFILE_DIR, '').trim()
  return cfg
}

/**
 * 在 <DSH_HOME>/profiles 下扫描：找包含 `node_modules/dsh-vpn` 的 profile 目录
 * （即插件实际被安装到的 profile；宿主进程 env 里可能既没有 DSH_PROFILE_DIR 也没有 DSH_PROFILE）。
 */
function findInstalledProfileDir(home, fsImpl) {
  const profilesDir = path.join(home, 'profiles')
  let entries = []
  try {
    entries = fsImpl.readdirSync(profilesDir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry) continue
    const isDirectory = typeof entry.isDirectory === 'function' ? entry.isDirectory() : Boolean(entry.isDirectory)
    if (!isDirectory) continue
    const profileDir = path.join(profilesDir, String(entry.name))
    try {
      if (fsImpl.existsSync(path.join(profileDir, 'node_modules', 'dsh-vpn'))) return profileDir
    } catch {
      /* 单个 profile 读不到就跳过 */
    }
  }
  return null
}

function isDirectoryPath(target, fsImpl) {
  try {
    return fsImpl.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * 解析数据目录并给出决策来源（status.dataDirSource 展示用）：
 *   - 'config'：Config.dataDir 显式指定
 *   - 'env'：DSH_PROFILE_DIR，或 DSH_PROFILE 对应的目录确实存在
 *   - 'profile-scan'：扫描 <DSH_HOME>/profiles/*，找包含 node_modules/dsh-vpn 的 profile
 *   - 'fallback'：最后回退 <DSH_HOME>/profiles/<profile|default>/vpn 或 ~/.dsh-vpn
 *
 * @returns {{ dataDir: string, source: 'config'|'env'|'profile-scan'|'fallback', profileDir: string|null }}
 */
export function resolveDataDirInfo(cfg, env = process.env, deps = {}) {
  const fsImpl = deps.fs || fs
  const configured = toStr(cfg && cfg.dataDir, '').trim()
  if (configured) return { dataDir: path.resolve(configured), source: 'config', profileDir: null }

  const profileDirEnv = toStr(env && env.DSH_PROFILE_DIR, '').trim()
  if (profileDirEnv) return { dataDir: path.join(profileDirEnv, 'vpn'), source: 'env', profileDir: profileDirEnv }

  const home = toStr(env && env.DSH_HOME, '').trim()
  if (home) {
    const profile = toStr(env && env.DSH_PROFILE, '').trim()
    if (profile) {
      const candidate = path.join(home, 'profiles', profile)
      if (isDirectoryPath(candidate, fsImpl)) return { dataDir: path.join(candidate, 'vpn'), source: 'env', profileDir: candidate }
    }
    const found = findInstalledProfileDir(home, fsImpl)
    if (found) return { dataDir: path.join(found, 'vpn'), source: 'profile-scan', profileDir: found }
    return { dataDir: path.join(home, 'profiles', profile || 'default', 'vpn'), source: 'fallback', profileDir: null }
  }
  return { dataDir: path.join(os.homedir(), '.dsh-vpn'), source: 'fallback', profileDir: null }
}

/** 解析默认 dataDir（详见 resolveDataDirInfo）。 */
export function defaultDataDir(env = process.env, deps = {}) {
  return resolveDataDirInfo({ dataDir: '' }, env, deps).dataDir
}

export function resolveDataDir(cfg, env = process.env, deps = {}) {
  return resolveDataDirInfo(cfg, env, deps).dataDir
}

export function statePath(dataDir) {
  return path.join(dataDir, 'state.json')
}

export function subscriptionCachePath(dataDir) {
  return path.join(dataDir, 'subscription.yaml')
}

export function runtimeConfigPath(dataDir) {
  return path.join(dataDir, 'runtime.yaml')
}

export function killSwitchPath(dataDir) {
  return path.join(dataDir, KILL_SWITCH_FILE)
}

/**
 * kill-switch 是否生效。任一命中即生效：
 *   - 环境变量 DSH_VPN_DISABLED=1 / true
 *   - <dataDir>/disable.flag 存在
 */
export function isKillSwitchActive(cfg, options = {}) {
  const env = options.env || process.env
  const fsImpl = options.fs || fs
  const value = env && env[KILL_SWITCH_ENV]
  if (value === '1' || String(value).toLowerCase() === 'true') {
    return { active: true, reason: 'env ' + KILL_SWITCH_ENV + '=' + String(value) }
  }
  const dataDir = toStr(cfg && cfg.dataDir, '').trim()
  if (dataDir) {
    const flag = killSwitchPath(dataDir)
    try {
      if (fsImpl.existsSync(flag)) return { active: true, reason: 'flag file ' + flag }
    } catch {
      /* 读不到就当没命中，绝不能因为 kill-switch 检查让 apply 抛错 */
    }
  }
  return { active: false, reason: null }
}

/** 默认持久化状态（enabled 默认 false，保证绝不自动接管）。 */
export function defaultState(overrides) {
  return {
    version: 1,
    enabled: false,
    subscriptionUrl: '',
    preferredNode: '',
    mode: 'rule',
    // 系统代理：systemProxy = 用户意图；systemProxyOriginal = 首次 apply 时的原值快照
    systemProxy: null,
    systemProxyApplied: false,
    systemProxyOriginal: null,
    systemProxyAppliedAt: null,
    updatedAt: null,
    ...(overrides && typeof overrides === 'object' ? overrides : {}),
  }
}

/** 校验/清洗从磁盘读到的 state 对象。 */
export function normalizeState(raw) {
  const out = defaultState()
  if (!raw || typeof raw !== 'object') return out
  out.enabled = toBool(raw.enabled, false)
  out.subscriptionUrl = toStr(raw.subscriptionUrl, '').trim()
  out.preferredNode = toStr(raw.preferredNode, '').trim()
  out.mode = MODES.includes(raw.mode) ? raw.mode : 'rule'
  // null = 从未设置过（首次运行回退 Config.systemProxy）
  out.systemProxy = typeof raw.systemProxy === 'boolean' ? raw.systemProxy : null
  out.systemProxyApplied = toBool(raw.systemProxyApplied, false)
  out.systemProxyOriginal = raw.systemProxyOriginal && typeof raw.systemProxyOriginal === 'object' ? raw.systemProxyOriginal : null
  out.systemProxyAppliedAt =
    typeof raw.systemProxyAppliedAt === 'number' && Number.isFinite(raw.systemProxyAppliedAt) ? raw.systemProxyAppliedAt : null
  out.updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null
  return out
}

/**
 * 读取 state.json，永不抛错：
 *   - 文件不存在 → { exists:false, state: 默认, warning:null }
 *   - JSON 损坏/读失败 → { exists:false, state: 默认 disabled, warning:原因 }
 */
export function loadStateSync(dataDir, options = {}) {
  const fsImpl = options.fs || fs
  const file = statePath(dataDir)
  let raw
  try {
    raw = fsImpl.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, state: defaultState(), warning: null, path: file }
    return { exists: false, state: defaultState(), warning: 'state.json 读取失败: ' + errorMessage(error), path: file }
  }
  try {
    const parsed = JSON.parse(raw)
    return { exists: true, state: normalizeState(parsed), warning: null, path: file }
  } catch (error) {
    return { exists: false, state: defaultState(), warning: 'state.json 损坏，已回退默认 disabled: ' + errorMessage(error), path: file }
  }
}

/** 原子写 state.json（tmp + rename）；失败时抛错由调用方决定是否忽略。 */
export function saveStateSync(dataDir, state, options = {}) {
  const fsImpl = options.fs || fs
  const file = statePath(dataDir)
  const next = normalizeState(state)
  const payload = { ...next, version: 1, updatedAt: Date.now() }
  fsImpl.mkdirSync(dataDir, { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fsImpl.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  fsImpl.renameSync(tmp, file)
  return { path: file, state: payload }
}

/** 把持久化状态合并进运行配置（state 中非空值优先于 patch 里的静态 config）。 */
export function mergeStateIntoConfig(cfg, state) {
  const merged = { ...cfg }
  const s = normalizeState(state)
  if (s.subscriptionUrl) merged.subscriptionUrl = s.subscriptionUrl
  if (s.preferredNode) merged.preferredNode = s.preferredNode
  if (s.mode) merged.mode = s.mode
  return merged
}

/** 脱敏订阅 URL（token/密码/query 里的密钥）——给 UI / 日志展示用。 */
export function maskUrl(url) {
  const s = toStr(url, '')
  if (!s) return ''
  try {
    const parsed = new URL(s)
    if (parsed.username) parsed.username = '***'
    if (parsed.password) parsed.password = '***'
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/token|key|pass|secret|auth|sign/i.test(key)) parsed.searchParams.set(key, '***')
    }
    return parsed.toString()
  } catch {
    return s.replace(/(token|key|pass|secret|auth|sign)=[^&\s]+/gi, '$1=***')
  }
}

/** 从 Clash YAML 文本里数 proxies（伪节点由关键词过滤）。 */
const PSEUDO_NODE_RE = /(剩余流量|套餐到期|距离下次重置|到期时间|流量重置|官网|导航|群组|订阅)/i
const PROXY_NAME_LINE_RE = /^\s*-\s*\{?\s*name\s*:/gm

/** 伪节点（剩余流量/套餐到期/导航页）判定。 */
export function isPseudoNodeName(name) {
  return PSEUDO_NODE_RE.test(String(name ?? ''))
}

/**
 * 只从 `proxies:` 段里提取节点名（不误抓 proxy-groups 的 name）。
 * 同时支持 flow-mapping（`- { name: 'x', ... }`）与 block 风格（`- name: x`）。
 */
export function extractProxyNames(yaml) {
  const text = typeof yaml === 'string' ? yaml : ''
  const lines = text.split(/\r?\n/)
  const names = []
  let inProxies = false
  for (const line of lines) {
    if (/^proxies\s*:/.test(line)) {
      inProxies = true
      continue
    }
    if (/^\S/.test(line)) {
      if (inProxies) break
      continue
    }
    if (!inProxies) continue
    const trimmed = line.trim()
    if (!trimmed.startsWith('-')) continue
    const match = /^-\s*\{?\s*name\s*:\s*(?:'([^']*)'|"([^"]*)"|([^,}\r\n]+))/.exec(trimmed)
    if (!match) continue
    const name = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (name) names.push(name)
  }
  return names
}

export function extractNodeNames(yaml) {
  const names = []
  if (!yaml || typeof yaml !== 'string') return names
  const re = /name\s*:\s*'((?:[^'\\]|\\.)*)'|name\s*:\s*"((?:[^"\\]|\\.)*)"|name\s*:\s*([^,}\r\n]+)/g
  let match
  while ((match = re.exec(yaml)) !== null) {
    const name = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (!name) continue
    if (/^(name|type)$/i.test(name)) continue
    names.push(name)
  }
  return names
}

/**
 * 订阅摘要：优先进 engine fetchSubscription 返回的 info，缺失字段从 YAML 文本正则兜底。
 * 返回 { nodeCount, remainingTraffic, expireDate, expireAtIso, resetIn, totalBytes, landingPage, domains }
 */
export function summarizeYaml(yaml, info) {
  const summary = {
    nodeCount: null,
    remainingTraffic: null,
    expireDate: null,
    expireAtIso: null,
    resetIn: null,
    totalBytes: null,
    updateIntervalHours: null,
    landingPage: null,
  }
  if (info && typeof info === 'object') {
    if (Number.isFinite(info.nodeCount)) summary.nodeCount = info.nodeCount
    if (info.remainingTraffic) summary.remainingTraffic = String(info.remainingTraffic)
    if (info.expireDate) summary.expireDate = String(info.expireDate)
    if (info.expireAtIso) summary.expireAtIso = String(info.expireAtIso)
    if (Number.isFinite(info.totalBytes)) summary.totalBytes = info.totalBytes
    if (Number.isFinite(info.updateIntervalHours)) summary.updateIntervalHours = info.updateIntervalHours
    if (info.landingPage) summary.landingPage = String(info.landingPage)
  }
  const text = typeof yaml === 'string' ? yaml : ''
  if (text) {
    if (summary.nodeCount === null) {
      const names = extractProxyNames(text)
      if (names.length > 0) {
        summary.nodeCount = names.filter((name) => !PSEUDO_NODE_RE.test(name)).length
      } else {
        const fallbackNames = extractNodeNames(text)
        summary.nodeCount = fallbackNames.filter((name) => !PSEUDO_NODE_RE.test(name)).length
      }
    }
    if (!summary.remainingTraffic) {
      const m = /剩余流量\s*[：:]\s*([0-9.]+\s*[KMGTP]?i?B)/i.exec(text)
      if (m) summary.remainingTraffic = m[1].replace(/\s+/g, ' ')
    }
    if (!summary.expireDate) {
      const m = /(?:套餐到期|到期时间|到期日)\s*[：:]\s*([0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2})/.exec(text)
      if (m) summary.expireDate = m[1]
    }
    if (!summary.resetIn) {
      const m = /(?:距离下次重置剩余|下次重置|重置剩余)\s*[：:]\s*([0-9]+\s*(?:天|日|小时))/.exec(text)
      if (m) summary.resetIn = m[1].replace(/\s+/g, ' ')
    }
    if (!summary.landingPage) {
      // 只从订阅伪节点（如「导航页：https://...」「官网：...」）里提取落地页，
      // 不在整份 YAML 里随便抓 URL（否则会误抓 dns.nameserver 之类的地址）。
      const names = extractProxyNames(text)
      const candidates = names.filter((name) => /https?:\/\//.test(name) && /导航|官网|网址|登陆|登录|订阅/.test(name))
      for (const candidate of candidates) {
        const matched = /(https?:\/\/[0-9A-Za-z.-]+(?::[0-9]+)?\/?[^\s'"}\]，,]*)/.exec(candidate)
        if (matched) {
          summary.landingPage = matched[1]
          break
        }
      }
    }
  }
  return summary
}

/** 订阅摘要的一句话展示。 */
export function describeSummary(summary) {
  if (!summary || typeof summary !== 'object') return '无订阅信息'
  const parts = []
  if (Number.isFinite(summary.nodeCount)) parts.push(summary.nodeCount + ' 个节点')
  if (summary.remainingTraffic) parts.push('剩余流量 ' + summary.remainingTraffic)
  if (summary.expireDate) parts.push('到期 ' + summary.expireDate)
  if (summary.resetIn) parts.push('距重置 ' + summary.resetIn)
  if (!parts.length) return '无订阅信息'
  return parts.join('，')
}

/** 兼容 engine.health() / probeThroughProxy() 两种返回值：boolean | {ok,status} | ms number。 */
export function isProbeOk(value) {
  if (value === true) return true
  if (typeof value === 'number') return Number.isFinite(value) && value > 0
  if (!value || typeof value !== 'object') return false
  if (value.ok === true) return true
  if (Number.isFinite(value.status)) return value.status >= 200 && value.status < 500 && value.status !== 407
  return false
}

/** 探测耗时（ms），拿不到返回 null。 */
export function probeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object') return null
  if (Number.isFinite(value.ms)) return value.ms
  if (Number.isFinite(value.elapsedMs)) return value.elapsedMs
  return null
}

/** 探测失败原因（字符串）。 */
export function describeProbe(value) {
  if (value === true) return 'ok'
  if (typeof value === 'number') return 'ms=' + value
  if (!value || typeof value !== 'object') return 'no result'
  if (value.error) return String(value.error)
  if (Number.isFinite(value.status)) return 'HTTP ' + value.status
  return value.ok === true ? 'ok' : 'unknown failure'
}

export function errorMessage(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message) return error.message
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}

export function truncateText(text, max = 4000) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return s.slice(0, max) + '…（已截断）'
}

export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return (Math.round(value * 100) / 100).toFixed(2).replace(/\.00$/, '') + ' ' + units[index]
}

/** 生成随机 secret（mihomo external-controller 认证用）。 */
export function randomSecret(length = 24) {
  const alphabet = 'abcdef0123456789'
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

export { PROXY_NAME_LINE_RE }
