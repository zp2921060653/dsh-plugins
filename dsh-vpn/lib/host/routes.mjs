// dsh-vpn HTTP API（routes.mjs）。
//
// 通过可选服务 ctx.webServer 暴露同源 JSON API，供客户端 UI（client.js）使用：
//   GET  /dsh-vpn/api/status
//   GET  /dsh-vpn/api/nodes
//   POST /dsh-vpn/api/enable
//   POST /dsh-vpn/api/disable
//   POST /dsh-vpn/api/subscription   { url }
//   POST /dsh-vpn/api/update
//   POST /dsh-vpn/api/mode           { mode: 'rule'|'global' }
//   POST /dsh-vpn/api/select         { node }
//   POST /dsh-vpn/api/test
//
// 约定：
//   - 响应 content-type: application/json; charset=utf-8 + cache-control: no-store
//   - 成功 { ok:true, ... }；失败 HTTP 4xx/5xx + { ok:false, error }（客户端按 body.ok 判定）
//   - 请求体限制 64KB，只接受 JSON 对象
//   - webServer 是可选服务：没有它插件仍可工作（Agent 工具不受影响），只是没有 HTTP API
//
// 本模块只依赖 node 内建能力与 state.mjs 的错误格式化，可被普通 node import 自测。

import { errorMessage } from './state.mjs'

export const API_PREFIX = '/dsh-vpn/api'
const MAX_BODY_BYTES = 64 * 1024

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.extra = extra || null
  }
}

/** 给 status 快照补上 UI 期望的 `state` 别名。 */
function withStateAlias(status) {
  if (!status || typeof status !== 'object') return status
  return { ...status, state: status.state || status.status || null }
}

function sendJson(res, statusCode, payload) {
  let body
  try {
    body = JSON.stringify(payload === undefined ? null : payload)
  } catch (error) {
    body = JSON.stringify({ ok: false, error: '响应序列化失败: ' + errorMessage(error) })
    statusCode = 500
  }
  try {
    res.statusCode = statusCode
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-length', Buffer.byteLength(body))
    res.end(body)
  } catch {
    /* 连接已断开：忽略 */
  }
}

/** 读取并解析 JSON 请求体，限制 64KB。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (status, message) => {
      if (settled) return
      settled = true
      reject(new HttpError(status, message))
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(413, '请求体超过 64KB 限制')
        try {
          req.destroy()
        } catch {
          /* 忽略 */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        return reject(new HttpError(400, '请求体不是合法 JSON: ' + errorMessage(error)))
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(new HttpError(400, '请求体必须是 JSON 对象'))
      }
      resolve(parsed)
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(new HttpError(400, '读取请求体失败: ' + errorMessage(error)))
    })
  })
}

/** 把 webServer 传入的 pathname 归一化成 API 内的相对路径。 */
export function resolveRelativePath(pathname) {
  const clean = String(pathname || '').replace(/\/+$/, '')
  if (clean === API_PREFIX) return '/'
  if (clean.startsWith(API_PREFIX + '/')) return clean.slice(API_PREFIX.length)
  // 有些 carrier 在 prefix 路由里会传已剥离前缀的 pathname（如 '/status'）。
  if (clean.startsWith('/') && !clean.startsWith('//')) return clean
  return null
}

function requireOk(result, defaults) {
  if (result && result.ok === false) {
    const error = result.error || (defaults && defaults.error) || '操作失败'
    const extra = result.status ? { status: withStateAlias(result.status) } : undefined
    throw new HttpError((defaults && defaults.status) || 400, error, extra)
  }
  return result || {}
}

function subscriptionSummary(subscription) {
  if (!subscription || typeof subscription !== 'object') return null
  const source = subscription.summary && typeof subscription.summary === 'object' ? subscription.summary : subscription
  return {
    nodeCount: typeof source.nodeCount === 'number' ? source.nodeCount : null,
    remainingTraffic: source.remainingTraffic ?? null,
    expireDate: source.expireDate ?? null,
    expireAtIso: source.expireAtIso ?? null,
    totalBytes: source.totalBytes ?? null,
    updateIntervalHours: typeof source.updateIntervalHours === 'number' ? source.updateIntervalHours : null,
  }
}

// ---------------------------------------------------------------------------
// 各端点
// ---------------------------------------------------------------------------

function statusPayload(service, query) {
  const debug = query && (query.get('debug') === '1' || query.get('logs') === '1')
  const snapshot = service.status()
  const status = withStateAlias(snapshot)
  if (!debug) {
    delete status.logs
    delete status.engineLogs
  }
  return { ok: true, status }
}

async function nodesPayload(service) {
  const result = await service.listNodes()
  if (!result || result.ok === false) {
    throw new HttpError(500, (result && result.error) || '读取节点失败')
  }
  const status = service.status()
  return {
    ok: true,
    nodes: Array.isArray(result.nodes) ? result.nodes : [],
    current: result.current ?? null,
    mode: status.mode,
    running: Boolean(result.running),
    source: result.source || 'none',
    groups: Array.isArray(result.groups) ? result.groups : [],
  }
}

function actionPayload(service, result, extra) {
  if (!result || result.ok === false) {
    const error = (result && result.error) || '操作失败'
    const extraError = result && result.status ? { status: withStateAlias(result.status) } : undefined
    throw new HttpError(400, error, extraError)
  }
  const payload = { ok: true, ...(extra || {}) }
  if (result.status) payload.status = withStateAlias(result.status)
  if (result.warning) payload.warning = result.warning
  return payload
}

/** 端点表：path + method + handler({ req, service, query })。 */
const ROUTES = [
  {
    method: 'GET',
    path: '/status',
    handler: async ({ service, query }) => statusPayload(service, query),
  },
  {
    method: 'GET',
    path: '/nodes',
    handler: async ({ service }) => nodesPayload(service),
  },
  {
    method: 'POST',
    path: '/enable',
    handler: async ({ service }) => {
      const result = await service.enable({ source: 'http' })
      return actionPayload(service, result)
    },
  },
  {
    method: 'POST',
    path: '/disable',
    handler: async ({ service }) => {
      const result = await service.disable()
      return actionPayload(service, result)
    },
  },
  {
    method: 'POST',
    path: '/subscription',
    handler: async ({ req, service }) => {
      const body = await readJsonBody(req)
      const url = body.url ?? body.subscriptionUrl
      const result = await service.setSubscription(url)
      return actionPayload(service, result, { subscription: result.subscription, summary: subscriptionSummary(result.subscription), applied: result.applied ?? null })
    },
  },
  {
    method: 'POST',
    path: '/update',
    handler: async ({ service }) => {
      const result = await service.updateSubscription()
      return actionPayload(service, result, { subscription: result.subscription, summary: subscriptionSummary(result.subscription), applied: result.applied ?? null })
    },
  },
  {
    method: 'POST',
    path: '/mode',
    handler: async ({ req, service }) => {
      const body = await readJsonBody(req)
      const result = await service.setMode(body.mode)
      return actionPayload(service, result, { mode: result.mode ?? null, applied: result.applied ?? null })
    },
  },
  {
    method: 'POST',
    path: '/select',
    handler: async ({ req, service }) => {
      const body = await readJsonBody(req)
      const result = await service.selectNode(body.node ?? body.name)
      return actionPayload(service, result, { node: result.node ?? null })
    },
  },
  {
    method: 'POST',
    path: '/test',
    handler: async ({ service }) => {
      const result = await service.testNodes()
      if (!result || result.ok === false) throw new HttpError(400, (result && result.error) || '测速失败')
      const delays = {}
      for (const item of Array.isArray(result.nodes) ? result.nodes : []) {
        if (!item || typeof item.name !== 'string') continue
        delays[item.name] = item.ok && typeof item.delay === 'number' ? item.delay : null
      }
      return {
        ok: true,
        delays,
        nodes: Array.isArray(result.nodes) ? result.nodes : [],
        available: result.available ?? null,
        total: result.total ?? null,
        testedAt: result.testedAt ?? null,
        concurrency: result.concurrency ?? null,
      }
    },
  },
  {
    method: 'POST',
    path: '/system-proxy',
    handler: async ({ req, service }) => {
      const body = await readJsonBody(req)
      const result = await service.setSystemProxy(body.enabled)
      return actionPayload(service, result, { systemProxy: result.systemProxy ?? null })
    },
  },
]

/**
 * 构造 HTTP handler（原始 IncomingMessage / ServerResponse），与具体 service 实例绑定。
 */
export function createApiHandler(service) {
  return async function dshVpnApiHandler(req, res) {
    let url
    try {
      url = new URL(String(req.url || '/'), 'http://127.0.0.1')
    } catch (error) {
      sendJson(res, 400, { ok: false, error: '非法请求 URL: ' + errorMessage(error) })
      return
    }
    const method = String(req.method || 'GET').toUpperCase()
    const relative = resolveRelativePath(url.pathname)
    if (relative === null) {
      sendJson(res, 404, { ok: false, error: '未知 API 路径: ' + url.pathname })
      return
    }
    const byPath = ROUTES.filter((route) => route.path === relative)
    if (byPath.length === 0) {
      sendJson(res, 404, { ok: false, error: '未知 API 端点: ' + relative })
      return
    }
    const route = byPath.find((candidate) => candidate.method === method)
    if (!route) {
      try {
        res.setHeader('allow', byPath.map((candidate) => candidate.method).join(', '))
      } catch {
        /* 忽略 */
      }
      sendJson(res, 405, { ok: false, error: 'method ' + method + ' 不被 ' + relative + ' 支持' })
      return
    }
    try {
      const payload = await route.handler({ req, res, service, query: url.searchParams })
      sendJson(res, 200, payload)
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { ok: false, error: error.message, ...(error.extra || {}) })
        return
      }
      const message = errorMessage(error)
      try {
        service._log?.('error', 'dsh-vpn: API ' + method + ' ' + relative + ' 失败: ' + message)
      } catch {
        /* 忽略 */
      }
      sendJson(res, 500, { ok: false, error: '服务异常: ' + message })
    }
  }
}

/**
 * 注册 HTTP API。webServer 为可选服务：
 *   - 已可用 → 直接 register（注册在插件 ctx 的 effect 上，unload 自动移除）
 *   - 尚不可用 → ctx.inject(['webServer'], ...) 等它就绪
 *   - 不存在 → 只记日志，插件其余能力照常工作
 */
export function attachRoutes(ctx, service) {
  const install = (scope, webServerOverride) => {
    if (!scope) return
    const webServer = webServerOverride || scope.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      try {
        service._log?.('warning', 'dsh-vpn: webServer 服务不可用，HTTP API 未注册（Agent 工具仍可用）')
      } catch {
        /* 忽略 */
      }
      return
    }
    try {
      const handler = createApiHandler(service)
      scope.effect(() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }))
      service._log?.('info', 'dsh-vpn: HTTP API 已注册: ' + API_PREFIX + '/*')
    } catch (error) {
      try {
        service._log?.('error', 'dsh-vpn: 注册 HTTP API 失败（Agent 工具仍可用）: ' + errorMessage(error))
      } catch {
        /* 忽略 */
      }
    }
  }

  try {
    const existing = typeof ctx.get === 'function' ? ctx.get('webServer') : null
    if (existing) {
      install(ctx, existing)
      return
    }
  } catch {
    /* 可选服务探测失败：走 inject 路径 */
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scope) => install(scope))
    } else {
      service._log?.('warning', 'dsh-vpn: 无法注入 webServer（无 ctx.inject），HTTP API 未注册')
    }
  } catch (error) {
    try {
      service._log?.('warning', 'dsh-vpn: 等待 webServer 服务失败: ' + errorMessage(error))
    } catch {
      /* 忽略 */
    }
  }
}

export default attachRoutes
