// dsh-vpn engine — HTTP/HTTPS probing through the local mihomo mixed port.
//
// Deliberately does NOT rely on any global dispatcher, env proxy or fetch():
// - HTTP  : plain TCP + absolute-URI request line
// - HTTPS : CONNECT tunnel over TCP + node:tls
//
// No external dependencies, only node: built-ins.

import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'

/**
 * Perform one HTTP(S) request through an HTTP proxy (mihomo mixed port).
 *
 * Never throws: network failures are returned as `{ ok: false, error }`.
 *
 * @param {number} port proxy port on 127.0.0.1
 * @param {string} url absolute target URL
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<{ ok: boolean, status: number|null, ms: number, error?: string,
 *                     headers?: Record<string,string>, head?: string }>}
 */
export async function probeThroughProxy(port, url, timeoutMs = 15000) {
  const started = Date.now()
  const proxyPort = Number(port)
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    return { ok: false, status: null, ms: 0, error: `非法代理端口: ${port}` }
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch (err) {
    return { ok: false, status: null, ms: 0, error: `非法 URL: ${err.message}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, status: null, ms: 0, error: `仅支持 http(s) URL，收到 ${parsed.protocol}` }
  }

  const host = stripBrackets(parsed.hostname)
  const defaultPort = parsed.protocol === 'https:' ? 443 : 80
  const targetPort = parsed.port ? Number(parsed.port) : defaultPort
  const hostHeader = parsed.port ? `${host}:${parsed.port}` : host
  const requestPath = `${parsed.pathname || '/'}${parsed.search}`
  const absoluteUrl = `${parsed.protocol}//${parsed.host}${requestPath}`

  return await new Promise((resolve) => {
    let settled = false
    const sockets = []
    const timer = setTimeout(() => finish({ ok: false, status: null, error: `超时（${timeoutMs}ms）` }), timeoutMs)

    function cleanup() {
      clearTimeout(timer)
      for (const sock of sockets) {
        try {
          sock.destroy()
        } catch {
          /* ignore */
        }
      }
    }

    function finish(result) {
      if (settled) return
      settled = true
      cleanup()
      resolve({ ...result, ms: Date.now() - started })
    }

    function track(sock) {
      sockets.push(sock)
      return sock
    }

    if (parsed.protocol === 'http:') {
      const sock = track(net.connect({ host: '127.0.0.1', port: proxyPort }))
      sock.setTimeout(timeoutMs)
      sock.once('connect', () => {
        sock.write(
          `GET ${absoluteUrl} HTTP/1.1\r\n` +
            `Host: ${hostHeader}\r\n` +
            'User-Agent: dsh-vpn-probe\r\n' +
            'Accept: */*\r\n' +
            'Proxy-Connection: keep-alive\r\n' +
            'Connection: close\r\n\r\n',
        )
      })
      let raw = ''
      sock.on('data', (chunk) => {
        raw += chunk.toString('latin1')
        const head = tryParseResponseHead(raw)
        if (head) finish({ ...head, head: raw.slice(0, 256) })
      })
      sock.once('timeout', () => finish({ ok: false, status: null, error: 'TCP 超时' }))
      sock.once('error', (err) => finish({ ok: false, status: null, error: err.code || err.message }))
      sock.once('close', () => {
        if (!settled) finish({ ok: false, status: null, error: '连接在收到响应前关闭' })
      })
      return
    }

    // HTTPS: CONNECT tunnel then TLS
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${hostHeader}:${targetPort}`,
      headers: {
        host: `${hostHeader}:${targetPort}`,
        'proxy-connection': 'keep-alive',
      },
      timeout: timeoutMs,
    })
    req.once('connect', (res, socket) => {
      track(socket)
      if (res.statusCode !== 200) {
        finish({ ok: false, status: res.statusCode, error: `CONNECT 被拒绝：HTTP ${res.statusCode}` })
        return
      }
      const tlsSocket = track(tls.connect({ socket, servername: host, rejectUnauthorized: true }))
      tlsSocket.setTimeout(timeoutMs)
      tlsSocket.once('secureConnect', () => {
        tlsSocket.write(
          `GET ${requestPath} HTTP/1.1\r\n` +
            `Host: ${hostHeader}\r\n` +
            'User-Agent: dsh-vpn-probe\r\n' +
            'Accept: */*\r\n' +
            'Connection: close\r\n\r\n',
        )
      })
      let raw = ''
      tlsSocket.on('data', (chunk) => {
        raw += chunk.toString('latin1')
        const head = tryParseResponseHead(raw)
        if (head) finish({ ...head, head: raw.slice(0, 256) })
      })
      tlsSocket.once('timeout', () => finish({ ok: false, status: null, error: 'TLS 超时' }))
      tlsSocket.once('error', (err) => finish({ ok: false, status: null, error: `TLS ${err.code || err.message}` }))
      tlsSocket.once('close', () => {
        if (!settled) finish({ ok: false, status: null, error: 'TLS 连接在收到响应前关闭' })
      })
    })
    req.once('timeout', () => finish({ ok: false, status: null, error: 'CONNECT 超时' }))
    req.once('error', (err) => finish({ ok: false, status: null, error: err.code || err.message }))
    req.end()
  })
}

/** @returns {{ ok:boolean, status:number, headers:Record<string,string> }|null} */
function tryParseResponseHead(raw) {
  let end = raw.indexOf('\r\n\r\n')
  if (end < 0) end = raw.indexOf('\n\n')
  if (end < 0) return null
  const headText = raw.slice(0, end)
  const lines = headText.split(/\r?\n/)
  const statusLine = lines.shift() ?? ''
  const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(statusLine)
  if (!m) return null
  const status = Number(m[1])
  const headers = {}
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
  }
  return { ok: status >= 200 && status < 400, status, headers }
}

function stripBrackets(host) {
  const value = String(host ?? '')
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}
