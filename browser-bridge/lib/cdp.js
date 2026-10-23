// Minimal Chrome DevTools Protocol client built on Node's global WebSocket.
//
// No third-party dependency on purpose: the plugin must load inside the DSH Host
// process, whose module resolution only guarantees Node built-ins.

/** Error raised for protocol-level or transport-level failures. */
export class CdpError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'CdpError'
    this.code = code
  }
}

/**
 * One WebSocket connection to a CDP endpoint (a browser or a page target).
 *
 * Flat-session multiplexing: every command may carry a `sessionId`, and every
 * event carries the session it belongs to. Listeners registered for a method
 * receive `(params, sessionId)`; the `'*'` listener receives `(method, params, sessionId)`.
 */
export class CdpConnection {
  constructor(url) {
    this.url = url
    this.ws = null
    this.closed = false
    this.nextId = 1
    /** @type {Map<number, {resolve: Function, reject: Function, method: string, timer: any}>} */
    this.pending = new Map()
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map()
    this.defaultTimeoutMs = 30000
    this.lastError = null
  }

  /**
   * Open a connection.
   * @param {string} url websocket debugger URL.
   * @param {{timeoutMs?: number}} [options]
   */
  static async open(url, options = {}) {
    const conn = new CdpConnection(url)
    await conn._connect(options.timeoutMs || 15000)
    return conn
  }

  _connect(timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      }
      const timer = setTimeout(() => {
        try { this.ws && this.ws.close() } catch { /* ignore */ }
        finish(new CdpError('CDP 连接超时: ' + this.url))
      }, timeoutMs)
      let ws
      try {
        ws = new WebSocket(this.url)
      } catch (err) {
        finish(new CdpError('无法创建 CDP WebSocket: ' + (err && err.message ? err.message : String(err))))
        return
      }
      this.ws = ws
      ws.addEventListener('open', () => finish(null))
      ws.addEventListener('error', () => {
        finish(new CdpError('CDP WebSocket 连接失败: ' + this.url))
      })
      ws.addEventListener('message', (ev) => this._onMessage(ev.data))
      ws.addEventListener('close', () => {
        this.closed = true
        const err = new CdpError('CDP 连接已关闭: ' + this.url)
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer)
          entry.reject(err)
        }
        this.pending.clear()
        this._emit('__closed__', {}, undefined)
      })
    })
  }

  _onMessage(data) {
    let text
    if (typeof data === 'string') text = data
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8')
    else if (data && typeof data === 'object' && typeof data.text === 'function') text = data.text()
    else text = String(data)
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (msg.id != null) {
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error) {
        entry.reject(new CdpError(`${entry.method}: ${msg.error.message || 'CDP error'}${msg.error.code ? ' (' + msg.error.code + ')' : ''}`, msg.error.code))
      } else {
        entry.resolve(msg.result || {})
      }
      return
    }
    if (msg.method) this._emit(msg.method, msg.params || {}, msg.sessionId)
  }

  _emit(method, params, sessionId) {
    const set = this.handlers.get(method)
    if (set) {
      for (const fn of [...set]) {
        try {
          fn(params, sessionId)
        } catch { /* listener errors must not break the transport */ }
      }
    }
    const all = this.handlers.get('*')
    if (all) {
      for (const fn of [...all]) {
        try {
          fn(method, params, sessionId)
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Subscribe to one CDP event method (or `'*'` for all).
   * @param {string} method event name.
   * @param {Function} fn listener.
   * @returns {() => void} unsubscribe.
   */
  on(method, fn) {
    let set = this.handlers.get(method)
    if (!set) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(fn)
    return () => set.delete(fn)
  }

  /**
   * Send one command and await its result.
   * @param {string} method CDP method.
   * @param {object} [params]
   * @param {{sessionId?: string, timeoutMs?: number}} [options]
   */
  send(method, params = {}, options = {}) {
    if (this.closed) return Promise.reject(new CdpError('CDP 连接已关闭，无法发送 ' + method))
    const id = this.nextId++
    const payload = { id, method, params }
    if (options.sessionId) payload.sessionId = options.sessionId
    const timeoutMs = options.timeoutMs || this.defaultTimeoutMs
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id)
          reject(new CdpError(`CDP ${method} 超时 (${timeoutMs}ms)`))
        }, timeoutMs)
        : null
      this.pending.set(id, { resolve, reject, method, timer })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (err) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(new CdpError('CDP 发送失败: ' + (err && err.message ? err.message : String(err))))
      }
    })
  }

  close() {
    this.closed = true
    try { this.ws && this.ws.close() } catch { /* ignore */ }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
