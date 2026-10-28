// dsh-vpn engine — subscription fetching & parsing.
//
// Fetching ALWAYS prefers a direct node:http(s) connection (no env proxy, no
// global dispatcher) because the host process may have HTTP_PROXY pointing at a
// locally installed Clash Verge that can be dead at any moment. Only if the
// direct attempt fails do we fall back to the global fetch implementation.
//
// Supports two subscription formats:
//   1. Clash / mihomo YAML (contains a top-level `proxies:` block)
//   2. base64 encoded (or plain) list of v2ray share links: ss:// vmess://
//      vless:// trojan:// — converted into a minimal valid Clash config so the
//      engine can still start.
//
// No external dependencies, only node: built-ins.

import dns from 'node:dns'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'

import { parseClashYaml } from './yaml.mjs'

export { parseClashYaml }

/** User-Agent that makes clash-verge compatible subscriptions return Clash YAML. */
export const SUBSCRIPTION_UA = 'clash-verge/2.0.0 (dsh-vpn)'

const SELECT_GROUP = '🔰 节点选择'
const AUTO_GROUP = '♻️ 自动选择'
const DELAY_PROBE_URL = 'http://www.gstatic.com/generate_204'

/** Names used by subscription providers for non-connectable "info" entries. */
const PSEUDO_NODE_RE = /^\s*(剩余流量|套餐到期|导航页|官网|网址|订阅|流量重置|过期时间|到期时间|距离下次|套餐)/u

/**
 * True when a proxy name is a provider decoration ("剩余流量：300 GB" etc.),
 * not a connectable node.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isPseudoNodeName(name) {
  return typeof name === 'string' && PSEUDO_NODE_RE.test(name)
}

/**
 * Fetch + parse a subscription URL.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, log?: (line: string) => void }} [opts]
 * @returns {Promise<{
 *   raw: string,
 *   format: 'clash'|'links',
 *   clashYaml: string,
 *   nodes: Array<{name:string,type:string,server:string,port:number,cipher:string|null}>,
 *   groups: Array<{name:string,type:string,members:string[]}>,
 *   info: Record<string, any>,
 * }>}
 */
export async function fetchSubscription(url, { timeoutMs = 30000, log } = {}) {
  const logger = typeof log === 'function' ? log : () => {}
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('fetchSubscription: 订阅地址不能为空')
  }
  const target = url.trim()
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('fetchSubscription: 订阅地址必须是 http(s) URL')
  }

  const started = Date.now()
  const headers = { 'user-agent': SUBSCRIPTION_UA, accept: '*/*' }

  let res
  try {
    res = await directGet(target, { headers, timeoutMs })
  } catch (directErr) {
    logger(`[dsh-vpn] 直连拉取订阅失败（${directErr.message}），尝试全局 fetch 兜底…`)
    try {
      res = await fetchFallback(target, headers, timeoutMs)
      logger('[dsh-vpn] 全局 fetch 兜底成功')
    } catch (fallbackErr) {
      throw new Error(`订阅拉取失败：直连(${directErr.message})，fetch 兜底(${fallbackErr.message})`)
    }
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`订阅拉取失败：HTTP ${res.status} ${truncate(res.body, 160)}`)
  }
  const raw = res.body
  if (!raw || raw.trim() === '') throw new Error('订阅拉取失败：响应体为空')

  const detected = detectSubscriptionFormat(raw)
  let clashYaml = detected.clashYaml
  let proxies
  let groups

  if (detected.format === 'clash') {
    const parsed = parseClashYaml(clashYaml)
    proxies = parsed.proxies
    groups = parsed.groups.map((g) => ({
      name: typeof g.name === 'string' ? g.name : String(g.name ?? ''),
      type: typeof g.type === 'string' ? g.type : String(g.type ?? ''),
      members: Array.isArray(g.proxies) ? g.proxies.slice() : [],
    }))
  } else {
    proxies = parseShareLinks(detected.linksText)
    const connectable = proxies.filter((p) => !isPseudoNodeName(p.name))
    if (connectable.length === 0) {
      throw new Error('订阅解析失败：分享链接中没有可连接的节点（ss/vmess/vless/trojan）')
    }
    clashYaml = linksToClashYaml(connectable)
    const names = connectable.map((p) => p.name)
    groups = [
      { name: SELECT_GROUP, type: 'select', members: [...names, 'DIRECT'] },
      { name: AUTO_GROUP, type: 'url-test', members: [...names] },
    ]
    proxies = connectable
  }

  const nodes = proxies
    .filter((p) => p && !isPseudoNodeName(p.name))
    .map((p) => ({
      name: String(p.name ?? ''),
      type: String(p.type ?? ''),
      server: p.server == null ? null : String(p.server),
      port: Number.isFinite(Number(p.port)) ? Number(p.port) : null,
      cipher: p.cipher == null ? null : String(p.cipher),
    }))

  if (nodes.length === 0) throw new Error('订阅解析失败：没有解析到任何可连接节点')

  const info = buildInfo({
    url: target,
    status: res.status,
    headers: res.headers,
    format: detected.format,
    proxies,
    nodeCount: nodes.length,
    rawBytes: Buffer.byteLength(raw, 'utf8'),
    elapsedMs: Date.now() - started,
  })

  logger(
    `[dsh-vpn] 订阅解析完成: format=${detected.format}, 可连接节点=${nodes.length}, ` +
      `伪节点=${info.pseudoNodeCount}, 组=${groups.length}, 耗时=${info.elapsedMs}ms`,
  )
  if (detected.format === 'links') logger('[dsh-vpn] 订阅为分享链接格式，已转换为最小 Clash 配置')

  return { raw, format: detected.format, clashYaml, nodes, groups, info }
}

/* ------------------------------------------------------------------ */
/* subscription cache helpers (synchronous on purpose: usable with or  */
/* without await by the host layer; cached payload is the raw Clash    */
/* YAML, never the generated runtime config)                           */
/* ------------------------------------------------------------------ */

/**
 * Canonical cache file location for a subscription: <dataDir>/subscription.yaml
 * @param {string} dataDir
 * @returns {string}
 */
export function subscriptionCachePath(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') {
    throw new Error('subscriptionCachePath: dataDir must be a non-empty string')
  }
  return path.join(dataDir, 'subscription.yaml')
}

/**
 * Read a cached raw Clash subscription YAML.
 * @param {string} filePath
 * @returns {string|null} raw YAML, or null when missing / unreadable / invalid
 */
export function readCachedSubscription(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return null
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    if (!raw || !/(^|\n)proxies\s*:/.test(raw)) return null
    return raw
  } catch {
    return null
  }
}

/**
 * Atomically write a cached raw Clash subscription YAML.
 * @param {string} filePath
 * @param {string} raw
 * @returns {string} filePath
 */
export function writeCachedSubscription(filePath, raw) {
  if (typeof filePath !== 'string' || filePath === '') {
    throw new Error('writeCachedSubscription: filePath must be a non-empty string')
  }
  if (typeof raw !== 'string' || !/(^|\n)proxies\s*:/.test(raw)) {
    throw new Error('writeCachedSubscription: 只接受原始 Clash YAML（必须包含 proxies:）')
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, raw, 'utf8')
  fs.renameSync(tmp, filePath)
  return filePath
}

/* ------------------------------------------------------------------ */
/* format detection                                                    */
/* ------------------------------------------------------------------ */

function detectSubscriptionFormat(raw) {
  const text = stripBom(String(raw)).trim()
  if (text === '') throw new Error('订阅内容为空')
  if (looksLikeClashYaml(text)) return { format: 'clash', clashYaml: text, linksText: null }

  const decoded = tryDecodeBase64Text(text)
  if (decoded) {
    if (looksLikeClashYaml(decoded)) return { format: 'clash', clashYaml: decoded, linksText: null }
    if (decoded.includes('://')) return { format: 'links', clashYaml: null, linksText: decoded }
  }
  if (text.includes('://')) return { format: 'links', clashYaml: null, linksText: text }

  throw new Error(`无法识别的订阅格式（既不是 Clash YAML，也不是 base64/明文分享链接）：${truncate(text, 120)}`)
}

function looksLikeClashYaml(text) {
  return /(^|\n)proxies\s*:/.test(text)
}

function tryDecodeBase64Text(text) {
  let s = text.replace(/\s+/g, '')
  if (s.length < 16) return null
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null
  while (s.length % 4 !== 0) s += '='
  try {
    const out = Buffer.from(s, 'base64').toString('utf8')
    if (!out || out.includes('\uFFFD')) return null
    return out
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* direct + fallback HTTP fetching                                     */
/* ------------------------------------------------------------------ */

async function directGet(url, { headers, timeoutMs, maxRedirects = 5 }) {
  const started = Date.now()
  const deadline = started + timeoutMs

  const visit = async (target, depth) => {
    let parsed
    try {
      parsed = new URL(target)
    } catch {
      throw new Error(`非法 URL: ${target}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`不支持的协议: ${parsed.protocol}`)
    }
    if (depth > maxRedirects) throw new Error(`重定向次数过多: ${target}`)

    const result = await requestAcrossAddresses({ parsed, headers, deadline })
    if (result.status >= 300 && result.status < 400 && result.headers.location) {
      return visit(new URL(result.headers.location, target).toString(), depth + 1)
    }
    return { ...result, elapsedMs: Date.now() - started }
  }

  return visit(url, 0)
}

/**
 * Connect by resolved IP (SNI + Host header stay the original hostname) and try
 * the addresses in order. Subscription providers often resolve to a pool of
 * anti-censorship IPs where individual addresses can be temporarily
 * blackholed; Node's hostname-level Happy Eyeballs only falls back between
 * families, so we iterate addresses ourselves.
 */
async function requestAcrossAddresses({ parsed, headers, deadline }) {
  const isHttps = parsed.protocol === 'https:'
  const hostname = parsed.hostname
  const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80
  const requestPath = `${parsed.pathname}${parsed.search}`
  const hostHeader = parsed.host
  const addresses = await resolveAddresses(hostname)
  if (addresses.length === 0) throw new Error(`DNS 解析失败: ${hostname}`)

  const maxAttempts = Math.min(addresses.length, 6)
  let lastError = null
  for (let i = 0; i < maxAttempts; i += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 800) break
    try {
      return await singleHttpRequest({
        isHttps,
        address: addresses[i],
        hostname,
        port,
        path: requestPath,
        hostHeader,
        headers,
        timeoutMs: Math.min(remaining, 15000),
      })
    } catch (err) {
      lastError = err
    }
  }
  const reason = lastError?.code || lastError?.message || 'unknown'
  throw new Error(`${hostname} 连接失败（已尝试 ${maxAttempts} 个解析地址）: ${reason}`)
}

function resolveAddresses(hostname) {
  const bare = stripBrackets(hostname)
  if (net.isIP(bare)) return Promise.resolve([bare])
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true, verbatim: false }, (err, list) => {
      if (err || !Array.isArray(list) || list.length === 0) {
        resolve([])
        return
      }
      const v4 = list.filter((item) => item.family === 4).map((item) => item.address)
      const v6 = list.filter((item) => item.family === 6).map((item) => item.address)
      resolve([...v4, ...v6])
    })
  })
}

function singleHttpRequest({ isHttps, address, hostname, port, path: requestPath, hostHeader, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : http
    const options = {
      host: address,
      port,
      path: requestPath,
      method: 'GET',
      headers: { host: hostHeader, accept: '*/*', ...headers },
      timeout: timeoutMs,
    }
    if (isHttps) {
      options.servername = stripBrackets(hostname)
      options.rejectUnauthorized = true
      options.agent = false
    }
    const req = mod.request(options, (res) => {
      const status = res.statusCode ?? 0
      let stream = res
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase()
      try {
        if (encoding.includes('gzip')) stream = res.pipe(zlib.createGunzip())
        else if (encoding.includes('deflate')) stream = res.pipe(zlib.createInflate())
        else if (encoding.includes('br')) stream = res.pipe(zlib.createBrotliDecompress())
      } catch {
        stream = res
      }
      const chunks = []
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('end', () =>
        resolve({
          status,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
      stream.on('error', (err) => reject(new Error(`读取订阅响应失败: ${err.message}`)))
    })
    req.once('timeout', () =>
      req.destroy(Object.assign(new Error(`请求超时（${timeoutMs}ms）`), { code: 'ETIMEDOUT' })),
    )
    req.once('error', (err) => reject(err))
    req.end()
  })
}

async function fetchFallback(url, headers, timeoutMs) {
  const started = Date.now()
  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await res.text()
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body,
    url: res.url || url,
    elapsedMs: Date.now() - started,
  }
}

/* ------------------------------------------------------------------ */
/* share-link parsing (ss / vmess / vless / trojan)                    */
/* ------------------------------------------------------------------ */

/**
 * Parse a list of v2ray share links into mihomo proxy objects.
 * Malformed / unsupported links are skipped silently.
 * @param {string} text
 * @returns {Array<Record<string, any>>}
 */
export function parseShareLinks(text) {
  const out = []
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sep = line.indexOf('://')
    if (sep < 0) continue
    const scheme = line.slice(0, sep + 3).toLowerCase()
    let proxy = null
    try {
      if (scheme === 'ss://') proxy = parseSsLink(line)
      else if (scheme === 'vmess://') proxy = parseVmessLink(line)
      else if (scheme === 'vless://') proxy = parseVlessLink(line)
      else if (scheme === 'trojan://') proxy = parseTrojanLink(line)
    } catch {
      proxy = null
    }
    if (proxy && proxy.server && Number.isFinite(proxy.port)) out.push(proxy)
  }
  return dedupeNames(out)
}

/**
 * Build a minimal (but valid) Clash/mihomo YAML config from parsed proxy objects.
 * @param {Array<Record<string, any>>} nodes
 * @returns {string}
 */
export function linksToClashYaml(nodes) {
  const list = (Array.isArray(nodes) ? nodes : []).filter((p) => p && p.name && p.server && !isPseudoNodeName(p.name))
  if (list.length === 0) throw new Error('linksToClashYaml: 没有可用的节点')
  const names = list.map((p) => p.name)
  const lines = ['# Generated by dsh-vpn engine from share links', 'proxies:']
  for (const proxy of list) lines.push(`    - ${flowMap(proxy)}`)
  lines.push('proxy-groups:')
  lines.push(`    - ${flowMap({ name: SELECT_GROUP, type: 'select', proxies: [...names, 'DIRECT'] })}`)
  lines.push(
    `    - ${flowMap({ name: AUTO_GROUP, type: 'url-test', proxies: names, url: DELAY_PROBE_URL, interval: 300 })}`,
  )
  lines.push('rules:')
  lines.push(`    - ${singleQuote(`MATCH,${SELECT_GROUP}`)}`)
  return `${lines.join('\n')}\n`
}

function parseSsLink(uri) {
  let rest = uri.slice('ss://'.length)
  let name = null
  const hash = rest.indexOf('#')
  if (hash >= 0) {
    name = decodeFragment(rest.slice(hash + 1))
    rest = rest.slice(0, hash)
  }
  const query = rest.indexOf('?')
  if (query >= 0) rest = rest.slice(0, query) // plugin/obfs unsupported

  let method
  let password
  let host
  let port
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    const userinfo = decodeBase64(rest.slice(0, at)) ?? rest.slice(0, at)
    const sep = userinfo.indexOf(':')
    if (sep < 0) return null
    method = userinfo.slice(0, sep)
    password = userinfo.slice(sep + 1)
    const hp = splitHostPort(rest.slice(at + 1))
    host = hp.host
    port = hp.port
  } else {
    const decoded = decodeBase64(rest)
    if (!decoded) return null
    const at2 = decoded.lastIndexOf('@')
    if (at2 < 0) return null
    const userinfo = decoded.slice(0, at2)
    const sep = userinfo.indexOf(':')
    if (sep < 0) return null
    method = userinfo.slice(0, sep)
    password = userinfo.slice(sep + 1)
    const hp = splitHostPort(decoded.slice(at2 + 1))
    host = hp.host
    port = hp.port
  }
  if (!host || !Number.isFinite(port) || port <= 0) return null
  return { name: name || `${host}:${port}`, type: 'ss', server: host, port, cipher: method, password, udp: true }
}

function parseVmessLink(uri) {
  const decoded = decodeBase64(uri.slice('vmess://'.length))
  if (!decoded) return null
  let json
  try {
    json = JSON.parse(decoded)
  } catch {
    return null
  }
  if (!json || typeof json !== 'object') return null
  const server = json.add ? String(json.add) : ''
  const port = Number(json.port)
  if (!server || !Number.isFinite(port) || port <= 0) return null
  const proxy = {
    name: json.ps ? String(json.ps) : `${server}:${port}`,
    type: 'vmess',
    server,
    port,
    uuid: String(json.id ?? ''),
    alterId: Number(json.aid ?? 0) || 0,
    cipher: 'auto',
    udp: true,
  }
  const net = String(json.net ?? 'tcp').toLowerCase()
  if (net === 'ws') {
    proxy.network = 'ws'
    proxy['ws-opts'] = {
      path: json.path ? String(json.path) : '/',
      ...(json.host ? { headers: { Host: String(json.host) } } : {}),
    }
  } else if (net && net !== 'tcp') {
    proxy.network = net
  }
  if (String(json.tls ?? '').toLowerCase() === 'tls') {
    proxy.tls = true
    const servername = json.sni || json.host
    if (servername) proxy.servername = String(servername)
  }
  return proxy
}

function parseVlessLink(uri) {
  const u = new URL(uri)
  const server = stripBrackets(u.hostname)
  const port = Number(u.port || 443)
  if (!server || !Number.isFinite(port) || port <= 0) return null
  const q = u.searchParams
  const proxy = {
    name: decodeFragment(u.hash) || `${server}:${port}`,
    type: 'vless',
    server,
    port,
    uuid: decodeURIComponent(u.username),
    udp: true,
    cipher: 'auto',
  }
  const flow = q.get('flow')
  if (flow) proxy.flow = flow
  const fp = q.get('fp')
  if (fp) proxy['client-fingerprint'] = fp
  const security = (q.get('security') || 'none').toLowerCase()
  const sni = q.get('sni') || q.get('servername') || q.get('host') || ''
  if (security === 'tls' || security === 'reality') {
    proxy.tls = true
    if (sni) proxy.servername = sni
  }
  if (security === 'reality') {
    const opts = {}
    const pbk = q.get('pbk')
    const sid = q.get('sid')
    if (pbk) opts['public-key'] = pbk
    if (sid) opts['short-id'] = sid
    proxy['reality-opts'] = opts
  }
  const net = (q.get('type') || 'tcp').toLowerCase()
  if (net === 'ws') {
    proxy.network = 'ws'
    proxy['ws-opts'] = {
      path: q.get('path') || '/',
      ...(q.get('host') ? { headers: { Host: q.get('host') } } : {}),
    }
  } else if (net === 'grpc') {
    proxy.network = 'grpc'
    const serviceName = q.get('serviceName') || q.get('servicename')
    if (serviceName) proxy['grpc-opts'] = { 'grpc-service-name': serviceName }
  } else if (net !== 'tcp') {
    proxy.network = net
  }
  return proxy
}

function parseTrojanLink(uri) {
  const u = new URL(uri)
  const server = stripBrackets(u.hostname)
  const port = Number(u.port || 443)
  if (!server || !Number.isFinite(port) || port <= 0) return null
  const q = u.searchParams
  const proxy = {
    name: decodeFragment(u.hash) || `${server}:${port}`,
    type: 'trojan',
    server,
    port,
    password: decodeURIComponent(u.username),
    udp: true,
  }
  const sni = q.get('sni') || q.get('peer') || q.get('servername')
  if (sni) proxy.sni = sni
  if (q.get('allowInsecure') === '1' || q.get('allow_insecure') === '1') proxy['skip-cert-verify'] = true
  return proxy
}

/* ------------------------------------------------------------------ */
/* info / header parsing                                               */
/* ------------------------------------------------------------------ */

function buildInfo({ url, status, headers, format, proxies, nodeCount, rawBytes, elapsedMs }) {
  const h = normalizeHeaders(headers)
  const userinfo = parseSubscriptionUserInfo(h['subscription-userinfo'])
  const names = proxies.map((p) => String(p?.name ?? ''))
  const pseudoNames = names.filter(isPseudoNodeName)
  const remainingTraffic = findLabel(pseudoNames, /^剩余流量[：:]\s*(.+)$/u)
  const expireDate = findLabel(pseudoNames, /^套餐到期[：:]\s*(.+)$/u)
  const landingLabel = findLabel(pseudoNames, /^导航页[：:]\s*(.+)$/u)
  return {
    url,
    status,
    format,
    fetchedAt: new Date().toISOString(),
    elapsedMs,
    rawBytes,
    contentType: h['content-type'] ?? null,
    server: h['server'] ?? null,
    serverUserAgent: h['user-agent'] ?? null,
    profileWebPageUrl: h['profile-web-page-url'] ?? null,
    userAgent: SUBSCRIPTION_UA,
    totalBytes: userinfo.total ?? null,
    uploadBytes: userinfo.upload ?? null,
    downloadBytes: userinfo.download ?? null,
    expireAt: userinfo.expire ?? null,
    expireAtIso: userinfo.expire ? new Date(userinfo.expire * 1000).toISOString() : null,
    updateIntervalHours: parseUpdateInterval(h['profile-update-interval']),
    nodeCount,
    pseudoNodeCount: Math.max(0, names.length - nodeCount),
    remainingTraffic: remainingTraffic ? remainingTraffic.trim() : null,
    expireDate: expireDate ? expireDate.trim() : null,
    landingPage: normalizeLandingPage(landingLabel),
  }
}

function normalizeHeaders(headers) {
  const out = {}
  if (!headers || typeof headers !== 'object') return out
  for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = value
  return out
}

function parseSubscriptionUserInfo(raw) {
  const out = {}
  if (!raw) return out
  for (const part of String(raw).split(';')) {
    const m = /^\s*([A-Za-z-]+)\s*=\s*(\d+)\s*$/.exec(part)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = Number(m[2])
    if (key === 'upload') out.upload = value
    else if (key === 'download') out.download = value
    else if (key === 'total') out.total = value
    else if (key === 'expire') out.expire = value
  }
  return out
}

function parseUpdateInterval(raw) {
  if (raw == null) return null
  const n = Number.parseInt(String(raw), 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function findLabel(names, re) {
  for (const name of names) {
    const m = re.exec(name)
    if (m && m[1]) return m[1]
  }
  return null
}

function normalizeLandingPage(label) {
  if (!label) return null
  const value = label.trim()
  if (/^https?:\/\//i.test(value)) return value
  if (/^[\w.-]+\.[a-z]{2,}/i.test(value)) return `https://${value}`
  return value
}

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

function flowMap(obj) {
  const parts = []
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue
    parts.push(`${key}: ${flowValue(value)}`)
  }
  return `{ ${parts.join(', ')} }`
}

function flowValue(value) {
  if (Array.isArray(value)) return `[${value.map(flowValue).join(', ')}]`
  if (value !== null && typeof value === 'object') return flowMap(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return singleQuote(value)
}

function singleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function splitHostPort(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end < 0) return { host: '', port: NaN }
    return { host: trimmed.slice(1, end), port: Number(trimmed.slice(end + 1).replace(/^:/, '')) }
  }
  const idx = trimmed.lastIndexOf(':')
  if (idx < 0) return { host: trimmed, port: NaN }
  return { host: trimmed.slice(0, idx), port: Number(trimmed.slice(idx + 1)) }
}

function stripBrackets(host) {
  const value = String(host ?? '')
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

function decodeBase64(text) {
  let s = String(text ?? '')
    .trim()
    .replace(/\s+/g, '')
  if (!s) return null
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null
  while (s.length % 4 !== 0) s += '='
  try {
    const out = Buffer.from(s, 'base64').toString('utf8')
    return out && !out.includes('\uFFFD') ? out : null
  } catch {
    return null
  }
}

function decodeFragment(fragment) {
  const raw = String(fragment ?? '')
    .replace(/^#/, '')
    .replace(/\+/g, ' ')
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function dedupeNames(list) {
  const seen = new Map()
  for (const proxy of list) {
    const base = String(proxy.name || `${proxy.server}:${proxy.port}`)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    proxy.name = n === 1 ? base : `${base} #${n}`
  }
  return list
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
