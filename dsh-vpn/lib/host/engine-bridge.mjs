// dsh-vpn 引擎门面桥接（engine-bridge.mjs）。
//
// 把 `../engine/index.mjs` 的加载、能力校验与调用细节收在一处，service.mjs 只面向
// 这个稳定的小接口。引擎模块是**惰性动态 import** 的：
//   - engine 还没写完 / 写坏时，Host 插件仍能 apply、仍能返回 status，不会因为静态
//     import 失败导致整个插件装不上；
//   - 普通 node 下可以 import 本模块做纯逻辑自测（只有真正调用引擎能力时才加载）。
//
// 引擎契约（task-1，engine-dev 提供）：
//   resolvePaths({profileDir, dataDir}) -> {binaryPath, dataDir}
//   fetchSubscription(url, {timeoutMs, log}) -> {raw, format, clashYaml, nodes, groups, info}
//   parseClashYaml(yaml) -> {proxies, groups, rules}
//   buildRuntimeConfig({yaml, mixedPort, controllerPort, secret, mode, logLevel}) -> string
//   pickFreePort(start, end) -> Promise<number>
//   class MihomoEngine { start(configYaml), stop(), isRunning(), status(), proxies(),
//     selectGlobal(name), selectInGroup(group, name), delay(name, url, timeoutMs),
//     reload(configYaml), health(probeUrl, timeoutMs), logs() }
//   probeThroughProxy(port, url, timeoutMs)
//   readCachedSubscription(path) -> string|null
//   writeCachedSubscription(path, raw) -> path
//   subscriptionCachePath(dataDir) -> string

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { errorMessage, isProbeOk, probeMs, isPseudoNodeName } from './state.mjs'

/** 引擎门面模块 URL（相对本文件解析）。 */
export const ENGINE_MODULE_URL = new URL('../engine/index.mjs', import.meta.url)

/** 默认 mihomo 二进制（<plugin>/bin/mihomo.exe）。 */
export const DEFAULT_BINARY_URL = new URL('../../bin/mihomo.exe', import.meta.url)

const REQUIRED_EXPORTS = [
  'resolvePaths',
  'fetchSubscription',
  'parseClashYaml',
  'buildRuntimeConfig',
  'pickFreePort',
  'MihomoEngine',
  'probeThroughProxy',
]

let engineModulePromise

/**
 * 惰性加载引擎模块；失败后清空缓存以便下次重试（例如 engine-dev 刚补完文件）。
 * @returns {Promise<any>} 引擎模块命名空间
 */
export async function loadEngineModule(log) {
  if (engineModulePromise) return engineModulePromise
  engineModulePromise = (async () => {
    let mod
    try {
      mod = await import(ENGINE_MODULE_URL.href)
    } catch (error) {
      throw new Error('VPN 引擎模块加载失败（' + ENGINE_MODULE_URL.pathname + '）: ' + errorMessage(error))
    }
    const missing = REQUIRED_EXPORTS.filter((name) => mod[name] === undefined)
    if (missing.length) throw new Error('VPN 引擎模块缺少导出: ' + missing.join(', '))
    if (typeof mod.MihomoEngine !== 'function') throw new Error('VPN 引擎模块的 MihomoEngine 不是构造函数')
    return mod
  })().catch((error) => {
    engineModulePromise = undefined
    if (typeof log === 'function') log('warn', 'dsh-vpn: ' + errorMessage(error))
    throw error
  })
  return engineModulePromise
}

/** 引擎模块是否已经成功加载过（诊断用）。 */
export function isEngineModuleLoaded() {
  return engineModulePromise !== undefined
}

// ---------------------------------------------------------------------------
// 探测 / 健康结果归一化
// ---------------------------------------------------------------------------

/** 把 health()/probeThroughProxy() 的任意合理返回形状归一化成 {ok, ms, status, error}。 */
export function normalizeProbeResult(value) {
  if (value === true) return { ok: true, ms: null, status: null, error: null }
  if (value === false) return { ok: false, ms: null, status: null, error: 'probe returned false' }
  if (typeof value === 'number') return { ok: Number.isFinite(value) && value > 0, ms: value, status: null, error: null }
  if (!value || typeof value !== 'object') return { ok: false, ms: null, status: null, error: 'empty probe result' }
  const status = Number.isFinite(value.status) ? value.status : null
  const ms = probeMs(value)
  const error = value.error ? String(value.error) : null
  const ok = value.ok === true || (status !== null && status >= 200 && status < 500 && status !== 407)
  return { ok, ms, status, error }
}

/** 通过本地 mixed 端口做一次 HTTP 探测（不依赖全局 dispatcher）。永不抛错。 */
export async function probeThroughProxy(mod, port, url, timeoutMs) {
  try {
    const result = await mod.probeThroughProxy(port, url, timeoutMs)
    return normalizeProbeResult(result)
  } catch (error) {
    return { ok: false, ms: null, status: null, error: errorMessage(error) }
  }
}

/** engine.health() 包装：归一化且永不抛错。 */
export async function probeEngineHealth(engine, probeUrl, timeoutMs) {
  try {
    const result = await engine.health(probeUrl, timeoutMs)
    return normalizeProbeResult(result)
  } catch (error) {
    return { ok: false, ms: null, status: null, error: errorMessage(error) }
  }
}

// ---------------------------------------------------------------------------
// 路径 / 配置 / 引擎实例
// ---------------------------------------------------------------------------

/**
 * 解析 mihomo 二进制路径并校验存在。
 * @returns {string} 绝对路径
 */
export function resolveBinaryPath(mod, options = {}) {
  const configured = typeof options.configured === 'string' ? options.configured.trim() : ''
  if (configured) {
    if (!fs.existsSync(configured)) throw new Error('配置的 mihomo 二进制不存在: ' + configured)
    return configured
  }
  let fromEngine
  if (mod && typeof mod.resolvePaths === 'function') {
    try {
      const paths = mod.resolvePaths({ profileDir: options.profileDir, dataDir: options.dataDir })
      if (paths && typeof paths.binaryPath === 'string' && paths.binaryPath) fromEngine = paths.binaryPath
    } catch (error) {
      if (typeof options.log === 'function') options.log('warn', 'dsh-vpn: resolvePaths() 失败: ' + errorMessage(error))
    }
  }
  const candidate = fromEngine || fileURLToPath(DEFAULT_BINARY_URL)
  if (!fs.existsSync(candidate)) throw new Error('找不到 mihomo 二进制: ' + candidate)
  return candidate
}

/** 创建 MihomoEngine 实例（不启动）。 */
export function createEngine(mod, options) {
  if (!options || !options.binaryPath) throw new Error('createEngine: 缺少 binaryPath')
  const engine = new mod.MihomoEngine({
    binaryPath: options.binaryPath,
    dataDir: options.dataDir,
    configPath: options.configPath,
    log: options.log,
  })
  return engine
}

/** 调用 buildRuntimeConfig 并校验返回非空字符串。 */
export function buildRuntimeConfig(mod, params) {
  const yaml = mod.buildRuntimeConfig(params)
  if (typeof yaml !== 'string' || yaml.trim() === '') throw new Error('buildRuntimeConfig 返回了空配置')
  return yaml
}

/** 选空闲端口（排除列表内的端口时重试）。 */
export async function pickFreePort(mod, start, end, log) {
  let lastError = null
  for (let i = 0; i < 5; i += 1) {
    try {
      const port = await mod.pickFreePort(start, end)
      if (Number.isInteger(port) && port > 0) return port
      lastError = new Error('pickFreePort 返回非法端口: ' + String(port))
    } catch (error) {
      lastError = error
    }
  }
  throw new Error('无法分配空闲端口 ' + start + '-' + end + ': ' + errorMessage(lastError))
}

// ---------------------------------------------------------------------------
// 订阅缓存 / 节点列表
// ---------------------------------------------------------------------------

/** 读取订阅缓存（优先用引擎 helper，缺失时读文件）。无缓存返回 null，永不抛错。 */
export function readCachedSubscription(mod, cachePath, log) {
  if (mod && typeof mod.readCachedSubscription === 'function') {
    try {
      const raw = mod.readCachedSubscription(cachePath)
      if (typeof raw === 'string' && raw.trim()) return raw
      return null
    } catch (error) {
      if (typeof log === 'function') log('warn', 'dsh-vpn: readCachedSubscription 失败: ' + errorMessage(error))
    }
  }
  try {
    const raw = fs.readFileSync(cachePath, 'utf8')
    return raw.trim() ? raw : null
  } catch {
    return null
  }
}

/** 原子写订阅缓存（优先用引擎 helper）。失败抛错，由调用方决定是否忽略。 */
export function writeCachedSubscription(mod, cachePath, raw, log) {
  if (mod && typeof mod.writeCachedSubscription === 'function') {
    try {
      return mod.writeCachedSubscription(cachePath, raw)
    } catch (error) {
      if (typeof log === 'function') log('warn', 'dsh-vpn: writeCachedSubscription 失败，回退 fs: ' + errorMessage(error))
    }
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  const tmp = cachePath + '.tmp-' + process.pid
  fs.writeFileSync(tmp, raw, 'utf8')
  fs.renameSync(tmp, cachePath)
  return cachePath
}

/**
 * 从 Clash YAML 解析节点/分组（用于未运行时也能给 UI 展示节点列表）。
 * 伪节点（剩余流量/套餐到期/导航页等）会被过滤：优先用 engine 导出的
 * isPseudoNodeName（与 fetchSubscription 内部一致），否则退回本地实现。
 */
export function parseNodesFromYaml(mod, yaml) {
  const parsed = mod.parseClashYaml(yaml)
  const isPseudo = typeof mod.isPseudoNodeName === 'function' ? mod.isPseudoNodeName : isPseudoNodeName
  const proxies = Array.isArray(parsed && parsed.proxies) ? parsed.proxies : []
  const groups = Array.isArray(parsed && parsed.groups) ? parsed.groups : []
  const nodes = proxies
    .filter((proxy) => proxy && typeof proxy.name === 'string' && proxy.name)
    .filter((proxy) => {
      try {
        return !isPseudo(proxy.name)
      } catch {
        return true
      }
    })
    .map((proxy) => ({ name: proxy.name, type: proxy.type || 'unknown' }))
  const mappedGroups = groups
    .filter((group) => group && typeof group.name === 'string' && group.name)
    .map((group) => {
      const members = Array.isArray(group.members)
        ? group.members
        : Array.isArray(group.proxies)
          ? group.proxies
          : Array.isArray(group.all)
            ? group.all
            : []
      return {
        name: group.name,
        type: group.type || 'unknown',
        members,
      }
    })
  return { nodes, groups: mappedGroups }
}

/**
 * 显式关闭 mihomo 的 profile 持久化（store-selected / store-fake-ip），避免它往数据目录
 * 写 cache.db（只读/受限 profile 目录会刷 `[CacheFile] can't open cache file ... Access is denied`）。
 *
 * - 幂等：若配置里已经有顶层 `profile:` 段（例如 engine 侧以后自己加了），原样返回。
 * - 追加在文件末尾，作为独立顶层 key，不影响订阅原有内容。
 */
export function ensureProfileStoreDisabled(yaml) {
  if (typeof yaml !== 'string' || yaml.trim() === '') return yaml
  if (/^profile\s*:/m.test(yaml)) return yaml
  const trimmed = yaml.replace(/\s+$/, '')
  return (
    trimmed +
    '\n# dsh-vpn: 关闭 mihomo profile 持久化（cache.db），避免受限数据目录写失败告警\n' +
    'profile:\n' +
    '  store-selected: false\n' +
    '  store-fake-ip: false\n'
  )
}

/** engine.logs() 尾部摘要（诊断用，永不抛错）。 */
export function engineLogsTail(engine, count = 20) {
  try {
    if (!engine || typeof engine.logs !== 'function') return []
    const logs = engine.logs()
    if (!Array.isArray(logs)) return []
    return logs.slice(-count)
  } catch {
    return []
  }
}
