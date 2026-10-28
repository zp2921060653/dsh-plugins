// dsh-vpn 进程级代理策略接管（policy.mjs）。
//
// 这个模块是整个插件的核心：把 DSH 宿主进程的全局 dispatcher 切到本地 mihomo 的
// mixed 端口（127.0.0.1:<port>），从而让进程内所有 fetch（含 LLM API）走插件自己的
// 代理内核，不再依赖用户机器上的 Clash Verge。
//
// 设计要点：
//   1. 首选通路：动态 import DSH 自带的 `@deepseek-ai/dsh-http-proxy`，调用
//      `installProxyFromEnvironment(env, report)`。它内部会 setGlobalDispatcher，
//      并且把 http_proxy/https_proxy/no_proxy 同步进 process.env（对子进程也生效）。
//      `env` 只需要有 `get(name) -> {value} | undefined`，我们传一个伪造 env 对象，
//      这样完全不依赖宿主进程当前环境变量，也不会去读用户的 7897 配置。
//   2. 兜底通路：动态 import `undici`，照抄 dsh-http-proxy 的
//      `createPolicyDispatcher` / `installGlobalProxy` 写法（Agent + per-origin
//      factory：proxied origin 用 ProxyAgent，其余 Pool），同时写
//      `setGlobalDispatcher(agent)` 与 `globalThis[Symbol.for('undici.globalDispatcher.1')]`
//      —— 后者是 Node 内建 fetch 读取全局 dispatcher 的位置，缺一个都可能不生效。
//   3. 两条通路都不可用 → 抛 PolicyUnavailableError。调用方（service）必须降级为
//      "不接管、明确报错"，绝不能让 apply/进程崩掉。
//   4. 所有安装/恢复操作串行化（内部 promise 队列），幂等；restore() 沿 disposer 链
//      回到 launcher 启动时安装的原始 dispatcher（可能是用户已死的 7897），
//      需要"安全网直连"时由 service 紧接着调用 installDirect()。
//
// 本模块在普通 node 下可 import（dsh 包只在使用时才动态 import），便于纯逻辑自测。

import { errorMessage } from './state.mjs'

/** Node 内建 fetch（undici）读取全局 dispatcher 的 symbol 键（undici v6+ 与 Node 共用）。 */
export const UNDICI_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1')

/** 与 @deepseek-ai/dsh-http-proxy 的 LOOPBACK_NO_PROXY 对齐。 */
export const NO_PROXY_LIST = 'localhost,127.0.0.1,::1,[::1]'

/** 策略接管不可用（两条通路都失败）：必须被调用方捕获并降级，而不是让进程崩掉。 */
export class PolicyUnavailableError extends Error {
  constructor(message, options) {
    super(message)
    this.name = 'PolicyUnavailableError'
    this.code = 'POLICY_UNAVAILABLE'
    if (options && options.cause !== undefined) this.cause = options.cause
  }
}

function noopLog() {}

function asLog(log) {
  return typeof log === 'function' ? log : noopLog
}

/** 构造 dsh-http-proxy 期望的伪 env（`get(name) -> {value} | undefined`）。 */
export function createFakeEnv(values) {
  const source = values && typeof values === 'object' ? values : {}
  return {
    get(name) {
      const value = source[name]
      if (value === undefined || value === null || value === '') return undefined
      return { value: String(value) }
    },
  }
}

/** 全空的伪 env：dsh-http-proxy 会把它解析为 DIRECT_POLICY。 */
export function createDirectEnv() {
  return createFakeEnv({})
}

// ---------------------------------------------------------------------------
// 模块加载（缓存失败结果，成功结果缓存；两条通路都探测一次就够）
// ---------------------------------------------------------------------------

let httpProxyModulePromise
let undiciModulePromise

/**
 * 动态加载 @deepseek-ai/dsh-http-proxy。
 * 返回模块或 null（不可用）；永不抛错。
 */
export async function loadHttpProxyModule(log) {
  if (httpProxyModulePromise === undefined) {
    httpProxyModulePromise = import('@deepseek-ai/dsh-http-proxy')
      .then((mod) => {
        if (mod && typeof mod.installProxyFromEnvironment === 'function') return mod
        asLog(log)('warn', 'dsh-vpn: @deepseek-ai/dsh-http-proxy 已加载但缺少 installProxyFromEnvironment，改用 undici 兜底')
        return null
      })
      .catch((error) => {
        asLog(log)('warn', 'dsh-vpn: 无法加载 @deepseek-ai/dsh-http-proxy（' + errorMessage(error) + '），改用 undici 兜底')
        return null
      })
  }
  return httpProxyModulePromise
}

/** 动态加载 undici；返回模块或 null；永不抛错。 */
export async function loadUndiciModule(log) {
  if (undiciModulePromise === undefined) {
    undiciModulePromise = import('undici')
      .then((mod) => {
        if (mod && typeof mod.Agent === 'function') return mod
        asLog(log)('warn', 'dsh-vpn: undici 已加载但缺少 Agent，策略接管不可用')
        return null
      })
      .catch((error) => {
        asLog(log)('warn', 'dsh-vpn: 无法加载 undici（' + errorMessage(error) + '），策略接管不可用')
        return null
      })
  }
  return undiciModulePromise
}

/** 仅供自测/诊断：清空模块探测缓存。 */
export function resetModuleProbes() {
  httpProxyModulePromise = undefined
  undiciModulePromise = undefined
}

// ---------------------------------------------------------------------------
// 兜底通路：直接使用 undici（照抄 dsh-http-proxy 的路由语义）
// ---------------------------------------------------------------------------

function normalizeHostname(hostname) {
  return String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
}

function isLoopbackHostname(hostname) {
  const host = normalizeHostname(hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  if (/^127\./.test(host)) return true
  const mapped = /^::ffff:(.+)$/.exec(host)
  if (mapped) return /^127\./.test(mapped[1])
  return false
}

function splitHostPort(entry) {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']')
    if (close !== -1) {
      const rest = entry.slice(close + 1)
      const host = entry.slice(1, close)
      return rest.startsWith(':') ? { host, port: rest.slice(1) } : { host }
    }
  }
  const colon = entry.indexOf(':')
  if (colon !== -1 && entry.indexOf(':', colon + 1) === -1) {
    return { host: entry.slice(0, colon), port: entry.slice(colon + 1) }
  }
  return { host: entry }
}

function bypassesNoProxy(noProxy, url) {
  const host = normalizeHostname(url.hostname)
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
  const entries = String(noProxy || '').split(/[,\s]+/)
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const split = splitHostPort(entry)
    if (split.port !== undefined && split.port !== port) continue
    const candidate = split.host.replace(/^\*?\./, '').replace(/\.$/, '')
    if (candidate === '') continue
    if (host === candidate || host.endsWith('.' + candidate)) return true
  }
  return false
}

/** 与 dsh-http-proxy `proxyForUrl` 等价的最小实现。 */
export function proxyForUrlFallback(policy, url) {
  const target = url instanceof URL ? url : new URL(String(url))
  const proxy = target.protocol === 'https:' ? policy.httpsProxy : target.protocol === 'http:' ? policy.httpProxy : undefined
  if (proxy === undefined) return undefined
  if (isLoopbackHostname(target.hostname)) return undefined
  return bypassesNoProxy(policy.noProxy, target) ? undefined : proxy
}

/**
 * 构造 undici 的进程级 dispatcher（照抄 @deepseek-ai/dsh-http-proxy createPolicyDispatcher）。
 */
export async function createUndiciPolicyDispatcher(undici, policy) {
  const { Agent, Pool, ProxyAgent } = undici
  if (typeof Agent !== 'function') throw new Error('undici 缺少 Agent')
  return new Agent({
    factory(origin, options) {
      const proxied = proxyForUrlFallback(policy, new URL(origin.toString()))
      if (proxied !== undefined) {
        if (typeof ProxyAgent !== 'function') return new Pool(origin, options)
        return new ProxyAgent({ ...options, uri: proxied })
      }
      return new Pool(origin, options)
    },
  })
}

async function installUndiciDispatcher(undici, { proxyUrl, noProxy }, log) {
  const { getGlobalDispatcher, setGlobalDispatcher, Agent } = undici
  const previous = typeof getGlobalDispatcher === 'function' ? getGlobalDispatcher() : globalThis[UNDICI_GLOBAL_DISPATCHER]
  let agent
  if (proxyUrl) {
    agent = await createUndiciPolicyDispatcher(undici, {
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy: noProxy || NO_PROXY_LIST,
    })
  } else {
    if (typeof Agent !== 'function') throw new Error('undici 缺少 Agent，无法安装直连 dispatcher')
    agent = new Agent()
  }
  let setThroughApi = false
  if (typeof setGlobalDispatcher === 'function') {
    setGlobalDispatcher(agent)
    setThroughApi = true
  }
  // Node 内建 fetch 与 npm undici 共用这个 symbol；两条都写，保证一定生效。
  globalThis[UNDICI_GLOBAL_DISPATCHER] = agent
  asLog(log)('info', 'dsh-vpn: 已通过 undici 兜底通路安装 ' + (proxyUrl ? '代理' : '直连') + ' dispatcher')
  return {
    via: 'undici',
    dispose: async () => {
      try {
        if (setThroughApi && typeof setGlobalDispatcher === 'function') setGlobalDispatcher(previous)
      } finally {
        if (previous === undefined) delete globalThis[UNDICI_GLOBAL_DISPATCHER]
        else globalThis[UNDICI_GLOBAL_DISPATCHER] = previous
      }
      try {
        if (agent && typeof agent.close === 'function') await agent.close()
      } catch {
        /* 关闭旧 agent 失败不影响恢复 */
      }
    },
  }
}

// ---------------------------------------------------------------------------
// PolicyManager：串行、幂等的策略 lifecycle
// ---------------------------------------------------------------------------

export class PolicyManager {
  /**
   * @param {{ log?: (level: string, message: string) => void, env?: NodeJS.ProcessEnv }} options
   */
  constructor(options = {}) {
    this.log = asLog(options.log)
    this.env = options.env || process.env
    this._queue = Promise.resolve()
    this._active = null
    this._lastError = null
    this._takeoverAvailable = null
    this._moduleAvailability = { httpProxy: null, undici: null }
    this._baseline = {
      capturedAt: Date.now(),
      httpProxyEnv: this.env.http_proxy || this.env.HTTP_PROXY || null,
      httpsProxyEnv: this.env.https_proxy || this.env.HTTPS_PROXY || null,
      noProxyEnv: this.env.no_proxy || this.env.NO_PROXY || null,
      note: 'restore() 通过 installProxyFromEnvironment 返回的 disposer 链恢复 launcher 启动时的 dispatcher/env',
    }
  }

  /** 串行队列：所有安装/恢复动作按调用顺序执行。 */
  _enqueue(operation) {
    const run = this._queue.then(operation, operation)
    this._queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  _setActive(active) {
    this._active = active
    if (active) this._takeoverAvailable = true
  }

  /** 内部（队列内调用）：卸载当前策略，恢复到上一层状态。 */
  async _disposeActiveLocked() {
    const active = this._active
    this._active = null
    if (!active) return false
    try {
      await active.dispose()
      return true
    } catch (error) {
      this._lastError = '恢复 dispatcher 失败: ' + errorMessage(error)
      this.log('warn', 'dsh-vpn: ' + this._lastError)
      return false
    }
  }

  /** 首选通路：@deepseek-ai/dsh-http-proxy。返回 install 描述或 null（不可用时）。 */
  async _installPreferred(values) {
    const mod = await loadHttpProxyModule(this.log)
    if (!mod) {
      this._moduleAvailability.httpProxy = false
      return null
    }
    const disposer = await mod.installProxyFromEnvironment(createFakeEnv(values), (message) => {
      this.log('warn', 'dsh-vpn: dsh-http-proxy: ' + String(message))
    })
    if (typeof disposer !== 'function') throw new Error('installProxyFromEnvironment 未返回 disposer')
    this._moduleAvailability.httpProxy = true
    return {
      via: 'dsh-http-proxy',
      dispose: async () => {
        await disposer()
      },
    }
  }

  /** 两条通路安装策略；都不可用抛 PolicyUnavailableError。 */
  async _install(values, { proxyUrl, noProxy } = {}) {
    let preferredError = null
    try {
      const preferred = await this._installPreferred(values)
      if (preferred) return preferred
    } catch (error) {
      preferredError = error
      this._moduleAvailability.httpProxy = false
      this.log('warn', 'dsh-vpn: dsh-http-proxy 安装失败（' + errorMessage(error) + '），尝试 undici 兜底')
    }
    const undici = await loadUndiciModule(this.log)
    if (!undici) {
      this._moduleAvailability.undici = false
      this._takeoverAvailable = false
      const suffix = preferredError ? '；首选通路错误: ' + errorMessage(preferredError) : ''
      throw new PolicyUnavailableError(
        '无法接管进程代理：@deepseek-ai/dsh-http-proxy 与 undici 均不可用。工具/UI 仍可查看状态，但代理接管不可用' + suffix,
        { cause: preferredError || undefined },
      )
    }
    this._moduleAvailability.undici = true
    const installed = await installUndiciDispatcher(undici, { proxyUrl, noProxy: noProxy || NO_PROXY_LIST }, this.log)
    return installed
  }

  /**
   * 安装代理策略：把进程内 fetch 指向 http://127.0.0.1:<port>。
   * 幂等：若当前已是指向同端口的代理策略，直接返回诊断信息（不重复安装）。
   */
  installProxy(port, options = {}) {
    const numericPort = Number(port)
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      return Promise.reject(new Error('installProxy: 非法端口 ' + String(port)))
    }
    const noProxy = options.noProxy || NO_PROXY_LIST
    const proxyUrl = 'http://127.0.0.1:' + numericPort
    return this._enqueue(async () => {
      if (this._active && this._active.kind === 'proxy' && this._active.proxyUrl === proxyUrl) {
        return this.current()
      }
      await this._disposeActiveLocked()
      const values = { http_proxy: proxyUrl, https_proxy: proxyUrl, no_proxy: noProxy }
      try {
        const installed = await this._install(values, { proxyUrl, noProxy })
        this._setActive({ kind: 'proxy', proxyUrl, noProxy, via: installed.via, installedAt: Date.now(), dispose: installed.dispose })
        this._lastError = null
        this.log('info', 'dsh-vpn: 已接管进程代理 -> ' + proxyUrl + '（通路: ' + installed.via + '）')
      } catch (error) {
        this._lastError = errorMessage(error)
        throw error
      }
      return this.current()
    })
  }

  /**
   * 安装直连策略（watchdog 的安全网）：卸载代理策略后装一个显式直连 dispatcher，
   * 保证 DSH 至少能直连出网，而不是回落到可能已死的旧代理。
   */
  installDirect(options = {}) {
    return this._enqueue(async () => {
      if (this._active && this._active.kind === 'direct') return this.current()
      await this._disposeActiveLocked()
      try {
        const installed = await this._install(createDirectEnvValues(), { proxyUrl: null, noProxy: NO_PROXY_LIST })
        this._setActive({ kind: 'direct', proxyUrl: null, noProxy: NO_PROXY_LIST, via: installed.via, installedAt: Date.now(), dispose: installed.dispose })
        this._lastError = null
        this.log('info', 'dsh-vpn: 已安装直连策略（通路: ' + installed.via + '）')
      } catch (error) {
        this._lastError = '安装直连策略失败: ' + errorMessage(error)
        this._takeoverAvailable = false
        throw error
      }
      return this.current()
    })
  }

  /** 恢复到 launcher 启动时的原始 dispatcher（危险时由 service 紧接着 installDirect）。 */
  restore() {
    return this._enqueue(async () => {
      const restored = await this._disposeActiveLocked()
      if (restored) this.log('info', 'dsh-vpn: 已恢复 launcher 原始 dispatcher')
      return this.current()
    })
  }

  /** 插件卸载 / 进程清理时调用；永不抛错。 */
  async dispose() {
    try {
      await this.restore()
    } catch (error) {
      this.log('warn', 'dsh-vpn: dispose 时恢复 dispatcher 失败: ' + errorMessage(error))
    }
  }

  /** 诊断快照（同步，不改变状态）。 */
  current() {
    const active = this._active
    return {
      active: active
        ? {
            kind: active.kind,
            via: active.via,
            proxyUrl: active.proxyUrl || null,
            noProxy: active.noProxy || null,
            installedAt: active.installedAt || null,
          }
        : null,
      direct: active ? active.kind === 'direct' : null,
      proxied: active ? active.kind === 'proxy' : null,
      proxyUrl: active && active.kind === 'proxy' ? active.proxyUrl : null,
      takeoverAvailable: this._takeoverAvailable,
      moduleAvailability: { ...this._moduleAvailability },
      lastError: this._lastError,
      baseline: { ...this._baseline },
    }
  }
}

/** DIRECT_POLICY 的伪造 env 值：全空。 */
function createDirectEnvValues() {
  return {}
}

export default PolicyManager
