// Browser lifecycle: locate a Chromium binary, launch it with a persistent
// profile, attach over CDP, and keep a per-page model of navigation, network
// traffic, console output and dialogs.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CdpConnection, CdpError, sleep } from './cdp.js'

const SKIP_URL = /^(devtools:\/\/|chrome-devtools:\/\/|edge:\/\/devtools|about:blank$)/
const TEXTUAL_MIME = /^(text\/|application\/(json|javascript|ecmascript|xhtml\+xml|xml|graphql|x-www-form-urlencoded|ld\+json)|image\/svg\+xml)/i

/** Resolve the browser profile directory used for the persistent session. */
export function defaultProfileDir() {
  const base = process.env.DSH_PROFILE_DIR
    ? path.join(process.env.DSH_PROFILE_DIR, '.browser-profile')
    : path.join(os.homedir(), '.dsh', 'browser-profile')
  return base
}

function exists(p) {
  try { return fs.existsSync(p) } catch { return false }
}

function listDir(p) {
  try { return fs.readdirSync(p) } catch { return [] }
}

function versionedChildren(dir) {
  const found = []
  for (const name of listDir(dir)) {
    const full = path.join(dir, name)
    const m = /(\d+(?:\.\d+)*)$/.exec(name)
    found.push({ full, version: m ? m[1].split('.').map(Number) : [0] })
  }
  found.sort((a, b) => {
    const len = Math.max(a.version.length, b.version.length)
    for (let i = 0; i < len; i++) {
      const d = (a.version[i] || 0) - (b.version[i] || 0)
      if (d !== 0) return d
    }
    return 0
  })
  return found.map((f) => f.full)
}

/**
 * Candidate Chromium executables for this platform, best first.
 * @returns {Array<{path: string, source: string}>}
 */
export function browserCandidates() {
  const out = []
  const add = (p, source) => { if (p) out.push({ path: p, source }) }
  const addIfExists = (p, source) => { if (p && exists(p)) add(p, source) }

  if (process.env.DSH_BROWSER_PATH) addIfExists(process.env.DSH_BROWSER_PATH, 'env DSH_BROWSER_PATH')
  if (process.env.CHROME_PATH) addIfExists(process.env.CHROME_PATH, 'env CHROME_PATH')

  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    addIfExists(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome')
    addIfExists(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome x86')
    addIfExists(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome local')
    addIfExists(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Edge')
    addIfExists(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Edge x86')
    addIfExists(path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'Brave')
    addIfExists(path.join(local, 'Chromium', 'Application', 'chrome.exe'), 'Chromium')
    // Playwright keeps downloaded Chromium builds here. They are clean automation
    // builds, so prefer them over vendor bundles such as EdgeCore, which can carry
    // a bundled homepage/affiliate redirect.
    for (const dir of versionedChildren(path.join(local, 'ms-playwright')).reverse()) {
      addIfExists(path.join(dir, 'chrome-win64', 'chrome.exe'), 'Playwright Chromium')
      addIfExists(path.join(dir, 'chrome-win', 'chrome.exe'), 'Playwright Chromium')
    }
    for (const dir of versionedChildren(path.join(pf86, 'Microsoft', 'EdgeCore')).reverse()) {
      addIfExists(path.join(dir, 'msedge.exe'), 'Edge Core')
      if (out.length) break
    }
    for (const dir of versionedChildren(path.join(pf, 'Microsoft', 'EdgeCore')).reverse()) {
      addIfExists(path.join(dir, 'msedge.exe'), 'Edge Core')
      if (out.length) break
    }
  } else if (process.platform === 'darwin') {
    addIfExists('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Chrome')
    addIfExists('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Edge')
    addIfExists('/Applications/Chromium.app/Contents/MacOS/Chromium', 'Chromium')
    const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    for (const dir of versionedChildren(cache).reverse()) addIfExists(path.join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'), 'Playwright Chromium')
  } else {
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium']) addIfExists(p, 'system')
    const cache = path.join(os.homedir(), '.cache', 'ms-playwright')
    for (const dir of versionedChildren(cache).reverse()) addIfExists(path.join(dir, 'chrome-linux', 'chrome'), 'Playwright Chromium')
  }
  return out
}

/** First existing browser executable, or undefined. */
export function findBrowserExecutable(config = {}) {
  const configured = (config.browserPath || '').trim()
  if (configured) {
    if (!exists(configured)) throw new Error('配置的 browserPath 不存在: ' + configured)
    return { path: configured, source: 'config.browserPath' }
  }
  const candidates = browserCandidates()
  return candidates[0]
}

async function httpJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

/** Read the DevToolsActivePort file Chromium writes into --user-data-dir. */
function readPortFile(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    const port = Number(lines[0])
    if (!Number.isInteger(port) || port <= 0) return null
    return { port, wsPath: (lines[1] || '').trim() }
  } catch {
    return null
  }
}

const MARKER_FILE = 'dsh-browser.json'

function readMarker(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8')) } catch { return null }
}

function writeMarker(dir, data) {
  try { fs.writeFileSync(path.join(dir, MARKER_FILE), JSON.stringify(data, null, 2)) } catch { /* best effort */ }
}

/** Same executable path, tolerating case and separator differences on Windows. */
function samePath(a, b) {
  if (!a || !b) return false
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+/g, '/').toLowerCase()
  return norm(a) === norm(b)
}

/** Ask a foreign browser instance to shut down, so the profile can be relaunched. */
async function closeBrowserAt(wsUrl) {
  try {
    const conn = await CdpConnection.open(wsUrl, { timeoutMs: 4000 })
    await conn.send('Browser.close', {}, { timeoutMs: 4000 })
    conn.close()
  } catch { /* already gone */ }
}

/** Wait until nothing answers on the DevToolsActivePort endpoint any more. */
async function waitEndpointGone(portFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = readPortFile(portFile)
    if (!info) return true
    try {
      await httpJson(`http://127.0.0.1:${info.port}/json/version`, 800)
    } catch {
      return true
    }
    await sleep(200)
  }
  return false
}

async function waitForEndpoint(portFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = readPortFile(portFile)
    if (info) {
      try {
        const version = await httpJson(`http://127.0.0.1:${info.port}/json/version`, 2000)
        if (version && version.webSocketDebuggerUrl) return version
      } catch { /* keep polling */ }
    }
    await sleep(120)
  }
  throw new CdpError('浏览器启动超时：未在 ' + timeoutMs + 'ms 内打开调试端口')
}

/** One attached page target. */
export class Page {
  constructor(browser, targetInfo, sessionId) {
    this.browser = browser
    this.sessionId = sessionId
    this.targetId = targetInfo.targetId
    this.url = targetInfo.url || 'about:blank'
    this.title = targetInfo.title || ''
    this.type = targetInfo.type || 'page'
    this.attachedAt = Date.now()
    this.detached = false
    this.initError = null
    this.ready = null
    /** @type {Map<string, object>} */
    this.requests = new Map()
    /** @type {string[]} */
    this.requestOrder = []
    /** @type {object[]} */
    this.console = []
    this.pending = 0
    this.bodyBytes = 0
    this.dialogs = 0
  }

  send(method, params = {}, timeoutMs) {
    return this.browser.send(method, params, this.sessionId, timeoutMs)
  }

  async init() {
    const b = this.browser
    const config = b.config
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable', {
      maxTotalBufferSize: Math.max(64 * 1024 * 1024, config.maxBodyTotalBytes * 2),
      maxResourceBufferSize: Math.max(8 * 1024 * 1024, config.maxBodyBytes),
      maxPostDataSize: 64 * 1024,
    }).catch(() => {})
    await this.send('Log.enable').catch(() => {})
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {})
    if (config.downloadDir) {
      await this.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: config.downloadDir,
        eventsEnabled: true,
      }).catch(() => {})
    }
    this._wire()
  }

  _wire() {
    const browser = this.browser
    const off = (method, fn) => {
      const dispose = browser.conn.on(method, (params, sessionId) => {
        if (sessionId === this.sessionId) fn(params)
      })
      browser.effects.push(dispose)
      return dispose
    }
    browser.effects.push(off('Page.frameNavigated', (p) => {
      if (p.frame && !p.frame.parentId) {
        this.url = p.frame.url || this.url
        if (this.url !== 'about:blank') this.browser.touch(this)
      }
    }))
    browser.effects.push(off('Page.javascriptDialogOpening', async (p) => {
      this.dialogs += 1
      this.pushConsole({ type: 'dialog', text: `[${p.type}] ${p.message}` })
      const behavior = browser.config.dialogBehavior || 'accept'
      if (behavior === 'manual') return
      try {
        await this.send('Page.handleJavaScriptDialog', { accept: behavior !== 'dismiss', promptText: p.defaultPrompt || '' })
      } catch { /* page may have closed */ }
    }))
    browser.effects.push(off('Runtime.consoleAPICalled', (p) => {
      const args = (p.args || []).map((a) => {
        if (a.value !== undefined && a.value !== null) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value)
        if (a.unserializableValue !== undefined) return String(a.unserializableValue)
        if (a.description !== undefined) return String(a.description)
        return a.type || ''
      })
      this.pushConsole({ type: p.type, text: args.join(' ') })
    }))
    browser.effects.push(off('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {}
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'Uncaught exception'
      this.pushConsole({ type: 'error', text: String(desc).split('\n')[0] })
    }))
    browser.effects.push(off('Log.entryAdded', (p) => {
      const e = p.entry || {}
      if (!e.text) return
      this.pushConsole({ type: 'log-' + (e.level || 'info'), text: e.text + (e.url ? ' <' + e.url + '>' : '') })
    }))
    browser.effects.push(off('Network.requestWillBeSent', (p) => this._onRequest(p)))
    browser.effects.push(off('Network.responseReceived', (p) => this._onResponse(p)))
    browser.effects.push(off('Network.loadingFinished', (p) => this._onFinished(p)))
    browser.effects.push(off('Network.loadingFailed', (p) => this._onFailed(p)))
  }

  pushConsole(entry) {
    this.console.push({ ...entry, ts: Date.now(), url: this.url })
    if (this.console.length > 400) this.console.splice(0, this.console.length - 400)
  }

  _onRequest(p) {
    const existing = this.requests.get(p.requestId)
    if (existing && p.redirectResponse) {
      existing.redirects = (existing.redirects || 0) + 1
      existing.status = p.redirectResponse.status
      existing.url = p.request.url
      return
    }
    const rec = {
      id: p.requestId,
      url: p.request.url,
      method: p.request.method,
      type: p.type,
      startedAt: Date.now(),
      requestHeaders: p.request.headers,
      postData: p.request.postData ? String(p.request.postData).slice(0, 4000) : undefined,
      status: 0,
      mime: '',
      size: 0,
      done: false,
    }
    this.requests.set(p.requestId, rec)
    this.requestOrder.push(p.requestId)
    if (this.requestOrder.length > this.browser.config.maxRequests) {
      const drop = this.requestOrder.splice(0, this.requestOrder.length - this.browser.config.maxRequests)
      for (const id of drop) {
        const old = this.requests.get(id)
        if (old && old.body) this.bodyBytes -= old.body.length
        this.requests.delete(id)
      }
    }
    this.pending += 1
  }

  _onResponse(p) {
    const rec = this.requests.get(p.requestId)
    if (!rec) return
    rec.status = p.response.status
    rec.mime = p.response.mimeType || ''
    rec.resourceType = p.type
    rec.responseHeaders = p.response.headers
    if (p.response.fromDiskCache || p.response.fromPrefetchCache) rec.cached = true
    if (p.response.remoteIPAddress) rec.ip = p.response.remoteIPAddress
  }

  _onFailed(p) {
    const rec = this.requests.get(p.requestId)
    if (!rec) return
    rec.done = true
    rec.failed = p.errorText || p.blockedReason || 'failed'
    this.pending = Math.max(0, this.pending - 1)
  }

  _onFinished(p) {
    const rec = this.requests.get(p.requestId)
    if (!rec) return
    rec.done = true
    rec.size = p.encodedDataLength || 0
    rec.ms = Date.now() - rec.startedAt
    this.pending = Math.max(0, this.pending - 1)
    const config = this.browser.config
    const interesting = rec.type === 'Document' || rec.type === 'XHR' || rec.type === 'Fetch'
    if (!interesting) return
    if (!TEXTUAL_MIME.test(rec.mime || '')) return
    if (rec.size && rec.size > config.maxBodyBytes) return
    this.captureBody(p.requestId).catch(() => {})
  }

  /** Fetch and cache a response body (base64 decoded to text when possible). */
  async captureBody(requestId) {
    const rec = this.requests.get(requestId)
    if (!rec) throw new Error('没有这个请求: ' + requestId)
    if (rec.body != null) return rec.body
    const r = await this.send('Network.getResponseBody', { requestId }, 15000)
    let body = r.body
    if (r.base64Encoded) {
      const buf = Buffer.from(body, 'base64')
      rec.bodyBase64 = true
      body = buf.toString('utf8')
    }
    rec.body = body
    this.bodyBytes += body.length
    while (this.bodyBytes > this.browser.config.maxBodyTotalBytes) {
      const oldest = this.requestOrder.find((id) => {
        const x = this.requests.get(id)
        return x && x.body != null && id !== requestId
      })
      if (!oldest) break
      const victim = this.requests.get(oldest)
      this.bodyBytes -= victim.body.length
      victim.body = undefined
      victim.bodyEvicted = true
    }
    return body
  }

  async eval(expression, options = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise !== false,
      userGesture: true,
      timeout: options.timeout,
    }, options.timeout ? options.timeout + 2000 : undefined)
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || '页面执行异常'
      throw new Error('页面 JS 异常: ' + String(desc).split('\n').slice(0, 4).join(' '))
    }
    const res = r.result || {}
    if (res.type === 'undefined') return undefined
    if (Object.prototype.hasOwnProperty.call(res, 'value')) return res.value
    if (res.unserializableValue !== undefined) return res.unserializableValue
    return res.description == null ? null : res.description
  }

  /** Wait until the document reaches `until` (and optionally goes network-quiet). */
  async waitForReady(options = {}) {
    const timeoutMs = options.timeoutMs || this.browser.config.defaultTimeoutMs
    const until = options.until || 'load'
    const deadline = Date.now() + timeoutMs
    let stable = 0
    while (Date.now() < deadline) {
      let state = 'loading'
      try {
        state = await this.eval('document.readyState', { awaitPromise: false, timeout: 3000 })
      } catch {
        // execution context destroyed by a navigation; retry
      }
      const loaded = state === 'complete' || (until === 'domcontentloaded' && state === 'interactive')
      const quiet = until === 'networkidle' ? this.pending === 0 : true
      if (loaded && quiet) {
        stable += 1
        if (stable >= 2) return { readyState: state, pendingRequests: this.pending }
      } else {
        stable = 0
      }
      await sleep(100)
    }
    return { readyState: 'timeout', pendingRequests: this.pending }
  }

  /** Compact snapshot used by list/status output. */
  describe() {
    return {
      tab: this.targetId.slice(0, 8),
      title: this.title,
      url: this.url,
      requests: this.requests.size,
      active: this.browser.activeSessionId === this.sessionId,
    }
  }
}

/** Owns one browser process (or attaches to an existing CDP endpoint). */
export class BrowserManager {
  constructor(config) {
    this.config = {
      browserPath: '',
      userDataDir: '',
      headless: false,
      cdpEndpoint: '',
      defaultTimeoutMs: 25000,
      maxBodyBytes: 2 * 1024 * 1024,
      maxBodyTotalBytes: 48 * 1024 * 1024,
      maxRequests: 600,
      dialogBehavior: 'accept',
      downloadDir: '',
      windowSize: '1440x900',
      autoLaunch: true,
      ...config,
    }
    this.conn = null
    this.child = null
    this.version = null
    this.exe = null
    this.exeSource = ''
    this.sessionFile = ''
    this.pages = new Map()
    this.byTargetId = new Map()
    this.activeSessionId = null
    this.effects = []
    this.launching = null
    this.starting = null
    this.stderr = ''
  }

  async send(method, params, sessionId, timeoutMs) {
    await this.ensure()
    return this.conn.send(method, params, { sessionId, timeoutMs })
  }

  async ensure() {
    if (this.conn && !this.conn.closed) return this.conn
    if (!this.launching) {
      this.launching = this._start().finally(() => { this.launching = null })
    }
    await this.launching
    return this.conn
  }

  async _start() {
    const configured = (this.config.cdpEndpoint || '').trim()
    if (configured) {
      const endpoint = configured.includes('/devtools/')
        ? configured
        : (await httpJson(configured.replace(/\/$/, '') + '/json/version')).webSocketDebuggerUrl
      this.sessionFile = ''
      this.exe = 'external'
      this.exeSource = 'cdpEndpoint'
      return this._attach(endpoint)
    }
    if (!this.config.autoLaunch) throw new Error('browser.autoLaunch = false 且未配置 cdpEndpoint，无法连接浏览器')

    const profileDir = (this.config.userDataDir || '').trim() || defaultProfileDir()
    fs.mkdirSync(profileDir, { recursive: true })
    const portFile = path.join(profileDir, 'DevToolsActivePort')
    this.sessionFile = portFile

    const found = findBrowserExecutable(this.config)
    if (!found) {
      const tried = browserCandidates().map((c) => c.path)
      throw new Error('找不到 Chromium 浏览器。已尝试：\n' + (tried.length ? tried.join('\n') : '(无)') + '\n请设置 browserPath 或 DSH_BROWSER_PATH。')
    }
    this.exe = found.path
    this.exeSource = found.source

    // Reuse a browser from a previous plugin generation / session when it is still
    // alive AND was started from the same executable. A profile dir belongs to one
    // browser binary; reusing it across binaries would either fail to launch or
    // silently keep the old browser.
    if (this.config.reuseExisting !== false && readPortFile(portFile)) {
      try {
        const version = await waitForEndpoint(portFile, 2500)
        const marker = readMarker(profileDir)
        const sameBinary = !!(marker && marker.exe && samePath(marker.exe, found.path))
        if (sameBinary) {
          this.exe = marker.exe
          this.exeSource = 'reused session'
          return await this._attach(version.webSocketDebuggerUrl)
        }
        // The profile belongs to a different browser binary: shut it down cleanly.
        await closeBrowserAt(version.webSocketDebuggerUrl)
        await waitEndpointGone(portFile, 8000)
        try { fs.unlinkSync(portFile) } catch { /* ignore */ }
      } catch { /* fall through to a fresh launch */ }
    }

    const [w, h] = String(this.config.windowSize || '1440x900').split('x').map((n) => Number(n) || 0)
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      `--window-size=${w || 1440},${h || 900}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--disable-background-networking',
      '--disable-blink-features=AutomationControlled',
      '--hide-crash-restore-bubble',
      'about:blank',
    ]
    if (this.config.headless) args.unshift('--headless=new')
    try { fs.unlinkSync(portFile) } catch { /* ignore */ }

    this.child = spawn(this.exe, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    // Do not leave a stray browser behind when the Host process exits.
    process.once('exit', () => {
      try { if (this.child) this.child.kill() } catch { /* ignore */ }
    })
    this.child.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-4000)
    })
    this.child.on('exit', () => {
      this.child = null
    })
    const version = await waitForEndpoint(portFile, 30000).catch((err) => {
      throw new CdpError(err.message + (this.stderr ? '\n浏览器 stderr: ' + this.stderr.slice(-800) : ''))
    })
    writeMarker(profileDir, { exe: this.exe, startedAt: new Date().toISOString(), source: this.exeSource })
    return this._attach(version.webSocketDebuggerUrl)
  }

  async _attach(wsUrl) {
    const conn = await CdpConnection.open(wsUrl)
    this.conn = conn
    this.endpointUrl = wsUrl
    this.version = await conn.send('Browser.getVersion').catch(() => null)
    conn.on('Target.attachedToTarget', (p) => this._onAttached(p))
    conn.on('Target.detachedFromTarget', (p) => this._onDetached(p))
    conn.on('Target.targetInfoChanged', (p) => {
      const info = p.targetInfo
      if (!info) return
      const page = this.byTargetId.get(info.targetId)
      if (!page) return
      page.url = info.url || page.url
      page.title = info.title || page.title
    })
    conn.on('Target.targetDestroyed', (p) => {
      const page = this.byTargetId.get(p.targetId)
      if (page) this._forget(page)
    })
    await conn.send('Target.setDiscoverTargets', { discover: true })
    await conn.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    })
    this._ensureExistingPages().catch(() => {})
    return conn
  }

  async _ensureExistingPages() {
    const { targetInfos } = await this.conn.send('Target.getTargets')
    for (const info of targetInfos) {
      if (info.type !== 'page') continue
      if (this.byTargetId.has(info.targetId)) continue
      if (!SKIP_URL.test(info.url || '')) {
        try {
          const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
          if (!this.byTargetId.has(info.targetId)) this._adopt(info, sessionId)
        } catch { /* target may have vanished */ }
      }
    }
  }

  _onAttached(p) {
    const info = p.targetInfo
    if (!info || info.type !== 'page') return
    if (this.byTargetId.has(info.targetId)) return
    this._adopt(info, p.sessionId)
  }

  _adopt(info, sessionId) {
    const page = new Page(this, info, sessionId)
    this.pages.set(sessionId, page)
    this.byTargetId.set(info.targetId, page)
    if (!this.activeSessionId) this.activeSessionId = sessionId
    this.touch(page, { activate: false })
    // autoAttach pauses the target before its first script runs; resume only after
    // Network/Runtime are enabled so the page's very first requests are captured.
    page.ready = (async () => {
      try {
        await page.init()
      } catch (err) {
        page.initError = err && err.message ? err.message : String(err)
      }
      try {
        await this.conn.send('Runtime.runIfWaitingForDebugger', {}, { sessionId })
      } catch { /* target may already be gone */ }
    })()
    return page
  }

  _onDetached(p) {
    const page = this.pages.get(p.sessionId)
    if (page) this._forget(page)
  }

  _forget(page) {
    page.detached = true
    this.pages.delete(page.sessionId)
    this.byTargetId.delete(page.targetId)
    if (this.activeSessionId === page.sessionId) {
      const rest = [...this.pages.keys()]
      this.activeSessionId = rest.length ? rest[rest.length - 1] : null
    }
  }

  touch(page, options = {}) {
    this.activeSessionId = page.sessionId
    if (options.activate !== false) {
      this.conn.send('Target.activateTarget', { targetId: page.targetId }).catch(() => {})
    }
  }

  /** All live pages, in creation order. */
  listPages() {
    return [...this.pages.values()]
  }

  /** Newest user-facing page. */
  get activePage() {
    if (this.activeSessionId) {
      const page = this.pages.get(this.activeSessionId)
      if (page && !page.detached) return page
    }
    const all = this.listPages()
    return all.length ? all[all.length - 1] : null
  }

  /**
   * Resolve a page from a tab selector: target-id prefix, session prefix, URL
   * substring, `active`, or a 1-based index.
   */
  page(tab) {
    const all = this.listPages()
    if (tab == null || tab === '' || tab === 'active') return this.activePage
    const needle = String(tab).trim()
    // Target ids are hex-like but may be all digits, so prefix matches win over indexes.
    let hit = all.find((p) => p.targetId.startsWith(needle) || p.sessionId.startsWith(needle))
    if (hit) return hit
    hit = all.find((p) => (p.url || '').includes(needle) || (p.title || '').includes(needle))
    if (hit) return hit
    if (/^\d+$/.test(needle)) return all[Number(needle) - 1] || null
    return null
  }

  async requirePage(tab) {
    if (!this.conn || this.conn.closed) await this.ensure()
    const page = this.page(tab)
    if (!page) throw new Error('没有可用的标签页，请先调用 browser 的 open 动作')
    if (page.ready) await page.ready
    return page
  }

  /** A blank, still unused tab — reused instead of stacking new ones. */
  findBlankPage() {
    return this.listPages().find((p) => (
      (p.url === 'about:blank' || /^(chrome|edge):\/\/newtab/.test(p.url || ''))
      && p.requests.size === 0
      && p.console.length === 0
    )) || null
  }

  async openPage(url = 'about:blank') {
    await this.ensure()
    let page = this.config.reuseBlank === false ? null : this.findBlankPage()
    if (page) {
      this.touch(page)
    } else {
      const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank', background: false })
      page = await this.waitForPage(targetId, 15000)
      this.touch(page)
    }
    if (page.ready) await page.ready
    if (url && url !== 'about:blank') {
      await page.send('Page.navigate', { url })
      await page.waitForReady({ until: 'load' })
      await sleep(120)
      page.url = await page.eval('location.href', { awaitPromise: false }).catch(() => url)
      page.title = await page.eval('document.title', { awaitPromise: false }).catch(() => page.title)
    }
    return page
  }

  async waitForPage(targetId, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const page = this.byTargetId.get(targetId)
      if (page) return page
      await sleep(60)
    }
    throw new Error('新标签页未在 ' + timeoutMs + 'ms 内就绪')
  }

  async closePage(page) {
    try { await this.conn.send('Target.closeTarget', { targetId: page.targetId }) } catch { /* ignore */ }
    this._forget(page)
  }

  async newPageFor(url) {
    return this.openPage(url)
  }

  status() {
    return {
      running: !!(this.conn && !this.conn.closed),
      exe: this.exe,
      exeSource: this.exeSource,
      browser: this.version ? `${this.version.product} / ${this.version.jsVersion}` : '',
      headless: !!this.config.headless,
      endpoint: this.endpointUrl || '',
      sessionFile: this.sessionFile,
      tabs: this.listPages().map((p) => p.describe()),
    }
  }

  async closeBrowser() {
    try { if (this.conn && !this.conn.closed) await this.conn.send('Browser.close', {}, { timeoutMs: 4000 }) } catch { /* ignore */ }
    await sleep(250)
    if (this.conn) this.conn.close()
    this.conn = null
    this.pages.clear()
    this.byTargetId.clear()
    this.activeSessionId = null
    if (this.child) {
      try { this.child.kill() } catch { /* ignore */ }
      this.child = null
    }
  }

  dispose() {
    for (const off of this.effects) {
      try { off() } catch { /* ignore */ }
    }
    this.effects = []
    if (this.conn) this.conn.close()
    this.conn = null
  }
}
