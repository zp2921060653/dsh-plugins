// dsh-vpn engine — mihomo lifecycle management.
//
// Spawns the bundled mihomo binary with a generated runtime config, waits until
// both the external controller API and the mixed proxy port are ready, exposes
// the controller API as async methods, and guarantees that stop() leaves no
// mihomo process behind (POST /shutdown first, taskkill /T /F fallback).
//
// IMPORTANT: child stdio is wired to a log *file descriptor*, never a pipe.
// Piped stdio is blocked in some sandboxed environments (EPERM), and file based
// logging is what the host UI displays via logs() anyway.
//
// No external dependencies, only node: built-ins.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

import { PLUGIN_ROOT } from './config.mjs'
import { probeThroughProxy } from './probe.mjs'

export const DEFAULT_PROBE_URL = 'http://www.gstatic.com/generate_204'
export const START_TIMEOUT_MS = 20000

const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'])
const BUILTIN_PROXIES = new Set(['GLOBAL', 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'])
const LOG_TAIL_BYTES = 256 * 1024

/**
 * Manage one mihomo process.
 */
export class MihomoEngine {
  /**
   * @param {{ binaryPath?: string, dataDir?: string, configPath?: string,
   *           log?: (line: string) => void }} [opts]
   */
  constructor({ binaryPath, dataDir, configPath, log } = {}) {
    this.binaryPath = binaryPath ? path.resolve(binaryPath) : null
    this.dataDir = dataDir ? path.resolve(dataDir) : null
    this.configPath = configPath
      ? path.resolve(configPath)
      : this.dataDir
        ? path.join(this.dataDir, 'config.yaml')
        : null
    this.logPath = this.dataDir ? path.join(this.dataDir, 'mihomo.log') : null
    this.log = typeof log === 'function' ? log : () => {}

    this.child = null
    this.mixedPort = null
    this.controllerPort = null
    this.secret = ''
    this.mode = 'rule'
    this.version = null
    this.startedAt = null

    this._exitWaiters = []
    this._exited = true
    this._exitCode = null
    this._lastError = null
    this._lastExit = null
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Write the config, spawn mihomo and wait until the controller API and the
   * mixed port are reachable (max 20s).
   * @param {string} configYaml
   * @returns {Promise<object>} status()
   */
  async start(configYaml) {
    if (this.isRunning()) throw new Error('mihomo 已在运行，先调用 stop()')
    if (typeof configYaml !== 'string' || configYaml.trim() === '') {
      throw new Error('start(configYaml): configYaml 不能为空')
    }
    if (!this.binaryPath) throw new Error('start: 缺少 binaryPath（可先用 resolvePaths() 解析）')
    if (!this.dataDir) throw new Error('start: 缺少 dataDir（可先用 resolvePaths() 解析）')
    if (!this.configPath) throw new Error('start: 缺少 configPath')
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`start: 找不到 mihomo 可执行文件: ${this.binaryPath}`)
    }

    this._prepareDataDir()
    writeFileAtomic(this.configPath, ensureTrailingNewline(configYaml))
    this._applyConfig(configYaml)

    // Log file: mihomo's stdout+stderr are redirected into it by fd, so no pipe
    // is ever created. The host reads it back through logs().
    fs.writeFileSync(this.logPath, `# dsh-vpn mihomo log ${new Date().toISOString()}\n`, 'utf8')

    this._exitWaiters = []
    this._exited = false
    this._exitCode = null
    this._lastError = null
    this._lastExit = null
    this.startedAt = Date.now()

    this._appendEngineLine(`启动 mihomo: ${this.binaryPath}（dataDir=${this.dataDir}）`)
    this.log(`[dsh-vpn] 启动 mihomo: ${this.binaryPath}（dataDir=${this.dataDir}）`)

    let logFd = null
    let child
    try {
      logFd = fs.openSync(this.logPath, 'a')
      child = spawn(this.binaryPath, ['-f', this.configPath, '-d', this.dataDir], {
        cwd: this.dataDir,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', logFd, logFd],
      })
    } finally {
      if (logFd != null) {
        try {
          fs.closeSync(logFd)
        } catch {
          /* ignore */
        }
      }
    }
    this.child = child
    child.once('exit', (code, signal) => this._onExit(code, signal))
    child.once('error', (err) => {
      this._exited = true
      this._lastError = `spawn error: ${err.code || err.message}`
      this._appendEngineLine(this._lastError)
      this.log(`[dsh-vpn] ${this._lastError}`)
      const waiters = this._exitWaiters.splice(0)
      for (const resolve of waiters) resolve(true)
    })

    try {
      await this._waitReady(START_TIMEOUT_MS)
    } catch (err) {
      this._lastError = err.message
      try {
        await this.stop()
      } catch {
        /* best-effort cleanup */
      }
      throw err
    }

    this._appendEngineLine(`就绪 pid=${child.pid} version=${this.version ?? '?'} mixed=${this.mixedPort} controller=${this.controllerPort}`)
    this.log(
      `[dsh-vpn] mihomo 已就绪 pid=${child.pid} 版本=${this.version ?? '?'} mixed=${this.mixedPort} controller=${this.controllerPort}`,
    )
    return this.status()
  }

  /**
   * Stop mihomo. Tries the graceful controller shutdown first, then
   * `taskkill /PID <pid> /T /F` on Windows. Throws if the process survives.
   * @returns {Promise<{ stopped: boolean, pid: number|null, forced: boolean, exitCode: number|null }>}
   */
  async stop() {
    const child = this.child
    const pid = child?.pid ?? null
    if (!child || pid == null) {
      this._resetProcessState()
      return { stopped: false, pid: null, forced: false, exitCode: this._exitCode }
    }

    this.log(`[dsh-vpn] 停止 mihomo pid=${pid}…`)
    this._appendEngineLine(`停止 mihomo pid=${pid}`)

    // 1) graceful shutdown via controller API. mihomo v1.19.33 does NOT expose
    //    /shutdown (404 page not found), but other builds might, so try it.
    try {
      const res = await this._httpRequest('POST', '/shutdown', null, 1500)
      if (res.status >= 400) {
        this._appendEngineLine(`POST /shutdown -> HTTP ${res.status}（当前 mihomo 版本不支持 API 关闭）`)
      }
    } catch {
      /* controller not reachable — fall through to process termination */
    }
    let exited = await this._waitExit(2000)
    let forced = false

    // 2) terminate our own child. `child.kill()` works even in sandboxed agent
    //    environments where spawning `taskkill` is denied.
    if (!exited) {
      forced = true
      this.log(`[dsh-vpn] API 关闭不可用，结束 mihomo 进程 PID ${pid}`)
      this._appendEngineLine(`结束 PID ${pid}`)
      try {
        child.kill('SIGKILL')
      } catch {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* ignore */
        }
      }
      exited = await this._waitExit(5000)
    }

    // 3) last resort: taskkill on the process tree (production; taskkill may be
    //    denied inside sandboxes, so it is only the final fallback).
    if (!exited) {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch {
        /* ignore */
      }
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* ignore */
      }
      exited = await this._waitExit(3000)
    }

    // Final grace period: on Windows a just-terminated child can make
    // process.kill(pid, 0) report true for a short while (handle not reaped
    // yet), and the 'exit' event can arrive a moment later. Poll instead of
    // declaring a false failure.
    if (!this._exited) {
      for (let i = 0; i < 25 && !this._exited; i += 1) {
        await sleep(200)
        if (!this._exited && !this._procExists(pid)) break
      }
    }
    const stillAlive = !this._exited && this._procExists(pid)
    const exitCode = this._exitCode
    this._resetProcessState()
    if (stillAlive) {
      const message = `stop: mihomo 进程未能结束，PID ${pid} 仍存活`
      this._lastError = message
      throw new Error(message)
    }
    this._appendEngineLine(`已停止 pid=${pid}${forced ? '（强制）' : ''}`)
    this.log(`[dsh-vpn] mihomo 已停止 pid=${pid}${forced ? '（强制结束）' : ''}`)
    return { stopped: true, pid, forced, exitCode }
  }

  /** @returns {boolean} */
  isRunning() {
    return Boolean(this.child && !this._exited && this.child.exitCode === null)
  }

  /** @returns {object} */
  status() {
    const pid = this.child?.pid ?? null
    return {
      running: this.isRunning(),
      pid,
      mixedPort: this.mixedPort,
      controllerPort: this.controllerPort,
      mode: this.mode,
      version: this.version,
      configPath: this.configPath,
      dataDir: this.dataDir,
      logPath: this.logPath,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      uptimeMs: this.isRunning() && this.startedAt ? Date.now() - this.startedAt : 0,
      exitCode: this._exitCode,
      lastError: this._lastError,
    }
  }

  /* ---------------------------------------------------------------- */
  /* controller API                                                    */
  /* ---------------------------------------------------------------- */

  /** @param {string} apiPath */
  async apiGet(apiPath) {
    this._assertRunning()
    const res = await this._httpRequest('GET', apiPath)
    if (res.status >= 400) {
      throw new Error(`mihomo API GET ${apiPath} -> HTTP ${res.status}: ${truncate(res.text, 300)}`)
    }
    return parseMaybeJson(res.text)
  }

  /**
   * @param {string} apiPath
   * @param {unknown} body JS object (JSON encoded) or raw string
   */
  async apiPut(apiPath, body) {
    this._assertRunning()
    const res = await this._httpRequest('PUT', apiPath, body)
    if (res.status >= 400) {
      throw new Error(`mihomo API PUT ${apiPath} -> HTTP ${res.status}: ${truncate(res.text, 300)}`)
    }
    return parseMaybeJson(res.text)
  }

  /**
   * @returns {Promise<{ groups: Array<{name:string,type:string,now:string|null,all:string[]}>,
   *                    nodes: Array<{name:string,type:string}>, global: { now: string|null } }>}
   */
  async proxies() {
    const data = await this.apiGet('/proxies')
    const all = data && typeof data === 'object' && data.proxies && typeof data.proxies === 'object' ? data.proxies : {}
    const groups = []
    const nodes = []
    for (const [name, info] of Object.entries(all)) {
      if (!info || typeof info !== 'object') continue
      const type = String(info.type ?? '')
      if (GROUP_TYPES.has(type)) {
        groups.push({
          name,
          type,
          now: info.now == null ? null : String(info.now),
          all: Array.isArray(info.all) ? info.all.map(String) : [],
        })
        continue
      }
      if (BUILTIN_PROXIES.has(name)) continue
      nodes.push({ name, type })
    }
    const globalInfo = all.GLOBAL
    return {
      groups,
      nodes,
      global: { now: globalInfo && globalInfo.now != null ? String(globalInfo.now) : null },
    }
  }

  /**
   * Switch the GLOBAL selector (only meaningful in mode: global).
   * @param {string} name
   */
  async selectGlobal(name) {
    if (typeof name !== 'string' || name === '') throw new Error('selectGlobal: name 不能为空')
    await this.apiPut('/proxies/GLOBAL', { name })
    return { ok: true, name }
  }

  /**
   * Switch a selector/url-test group to a specific member.
   * @param {string} group
   * @param {string} name
   */
  async selectInGroup(group, name) {
    if (typeof group !== 'string' || group === '') throw new Error('selectInGroup: group 不能为空')
    if (typeof name !== 'string' || name === '') throw new Error('selectInGroup: name 不能为空')
    await this.apiPut(`/proxies/${encodeURIComponent(group)}`, { name })
    return { ok: true, group, name }
  }

  /**
   * Measure a node delay. Resolves with `{ ok:false, error }` on failure instead
   * of throwing (a dead node is an expected outcome).
   * @param {string} name
   * @param {string} [url]
   * @param {number} [timeoutMs]
   * @returns {Promise<{ ok:boolean, name:string, url:string, delay?:number, error?:string }>}
   */
  async delay(name, url = DEFAULT_PROBE_URL, timeoutMs = 8000) {
    if (typeof name !== 'string' || name === '') throw new Error('delay: name 不能为空')
    const probeUrl = url || DEFAULT_PROBE_URL
    const timeout = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 8000
    const apiPath = `/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(probeUrl)}&timeout=${timeout}`
    try {
      const data = await this.apiGet(apiPath)
      const delay = data && typeof data === 'object' && Number.isFinite(Number(data.delay)) ? Number(data.delay) : null
      if (delay == null) return { ok: false, name, url: probeUrl, error: '响应中没有 delay' }
      return { ok: true, name, url: probeUrl, delay }
    } catch (err) {
      return { ok: false, name, url: probeUrl, error: err.message }
    }
  }

  /**
   * Reload mihomo from a new config (written to configPath first).
   * @param {string} configYaml
   */
  async reload(configYaml) {
    this._assertRunning()
    if (typeof configYaml !== 'string' || configYaml.trim() === '') {
      throw new Error('reload(configYaml): configYaml 不能为空')
    }
    writeFileAtomic(this.configPath, ensureTrailingNewline(configYaml))
    this._applyConfig(configYaml)
    const body = { path: this.configPath }
    try {
      await this.apiPut('/configs?force=true', body)
    } catch (err) {
      const forwardSlashed = this.configPath.replace(/\\/g, '/')
      if (forwardSlashed !== this.configPath) {
        await this.apiPut('/configs?force=true', { path: forwardSlashed })
      } else {
        throw err
      }
    }
    this._appendEngineLine('配置已重载')
    this.log('[dsh-vpn] 配置已重载')
    return { ok: true, configPath: this.configPath }
  }

  /**
   * Probe connectivity through the mixed port.
   * @param {string} [probeUrl]
   * @param {number} [timeoutMs]
   * @returns {Promise<{ ok:boolean, ms:number, status:number|null, error?:string }>}
   */
  async health(probeUrl = DEFAULT_PROBE_URL, timeoutMs = 8000) {
    if (!this.isRunning() || this.mixedPort == null) {
      return { ok: false, ms: 0, status: null, error: 'mihomo 未运行' }
    }
    const result = await probeThroughProxy(this.mixedPort, probeUrl || DEFAULT_PROBE_URL, timeoutMs)
    const out = { ok: Boolean(result.ok), ms: result.ms, status: result.status }
    if (!out.ok) out.error = result.error ?? `HTTP ${result.status}`
    return out
  }

  /**
   * Recent mihomo log lines (mihomo stdout/stderr + engine events, oldest
   * first, newest last).
   * @param {number} [limit]
   * @returns {string[]}
   */
  logs(limit = 200) {
    const n = Number.isFinite(Number(limit)) ? Math.max(1, Math.trunc(Number(limit))) : 200
    return this._logTail(n)
  }

  /* ---------------------------------------------------------------- */
  /* internals                                                         */
  /* ---------------------------------------------------------------- */

  _prepareDataDir() {
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
    const sourceDir = path.join(PLUGIN_ROOT, 'data')
    let entries = []
    try {
      entries = fs.readdirSync(sourceDir)
    } catch {
      entries = []
    }
    for (const name of entries) {
      if (!/\.(mmdb|dat|metadb)$/i.test(name)) continue
      const source = path.join(sourceDir, name)
      const target = path.join(this.dataDir, name)
      if (fs.existsSync(target)) continue
      try {
        fs.copyFileSync(source, target)
        this.log(`[dsh-vpn] 已复制 geo 数据 ${name} -> ${this.dataDir}`)
      } catch (err) {
        this.log(`[dsh-vpn] 复制 geo 数据 ${name} 失败: ${err.message}`)
      }
    }
  }

  _applyConfig(configYaml) {
    const mixed = /^mixed-port\s*:\s*(\d+)\s*$/m.exec(configYaml)
    const controller = /^external-controller\s*:\s*['"]?([^'"\s#]+)/m.exec(configYaml)
    const mode = /^mode\s*:\s*['"]?([A-Za-z]+)/m.exec(configYaml)
    const secretMatch = /^secret\s*:\s*(.*)$/m.exec(configYaml)
    if (!mixed) throw new Error('start: 运行配置缺少 mixed-port')
    if (!controller) throw new Error('start: 运行配置缺少 external-controller')
    const controllerAddress = controller[1]
    const colon = controllerAddress.lastIndexOf(':')
    const controllerPort = colon >= 0 ? Number(controllerAddress.slice(colon + 1)) : NaN
    if (!Number.isInteger(controllerPort) || controllerPort < 1 || controllerPort > 65535) {
      throw new Error(`start: 无法解析 external-controller 端口: ${controllerAddress}`)
    }
    this.mixedPort = Number(mixed[1])
    this.controllerPort = controllerPort
    this.secret = secretMatch ? unquoteConfigValue(secretMatch[1]) : ''
    this.mode = mode ? mode[1].toLowerCase() : 'rule'
  }

  _assertRunning() {
    if (!this.isRunning()) throw new Error('mihomo 未运行')
  }

  async _waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let controllerReady = false
    let mixedReady = false
    let lastError = null
    while (Date.now() < deadline) {
      if (!this.isRunning()) {
        const detail = this._lastError ? `（${this._lastError}）` : ''
        throw new Error(`mihomo 启动失败${detail}，日志尾部: ${this._logTail(8).join(' | ')}`)
      }
      if (!controllerReady) {
        try {
          const res = await this._httpRequest('GET', '/version', null, 2500)
          if (res.status === 200) {
            const data = parseMaybeJson(res.text)
            this.version = data && typeof data === 'object' ? (data.version ?? null) : null
            controllerReady = true
          } else {
            lastError = new Error(`/version -> HTTP ${res.status}`)
          }
        } catch (err) {
          lastError = err
        }
      }
      if (!mixedReady) mixedReady = await tcpReachable('127.0.0.1', this.mixedPort, 700)
      if (controllerReady && mixedReady) return
      await sleep(200)
    }
    throw new Error(
      `mihomo 启动超时（${timeoutMs}ms）：controller=${controllerReady ? 'ok' : `fail(${lastError?.message ?? '?'})`} ` +
        `mixedPort=${this.mixedPort}:${mixedReady ? 'ok' : 'fail'}；日志尾部: ${this._logTail(8).join(' | ')}`,
    )
  }

  _httpRequest(method, apiPath, body, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (this.controllerPort == null) {
        reject(new Error('mihomo controller 端口未知'))
        return
      }
      const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body)
      const headers = {
        authorization: `Bearer ${this.secret}`,
        accept: 'application/json',
      }
      if (payload != null) {
        headers['content-type'] = 'application/json'
        headers['content-length'] = Buffer.byteLength(payload)
      }
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.controllerPort,
          path: apiPath,
          method,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          )
        },
      )
      req.once('timeout', () => req.destroy(new Error(`controller API 超时（${method} ${apiPath}）`)))
      req.once('error', reject)
      if (payload != null) req.write(payload)
      req.end()
    })
  }

  _appendEngineLine(line) {
    if (!this.logPath) return
    try {
      fs.appendFileSync(this.logPath, `${new Date().toISOString()} [engine] ${line}\n`, 'utf8')
    } catch {
      /* ignore */
    }
  }

  _logTail(lines = 200) {
    if (!this.logPath) return []
    let fd = null
    try {
      fd = fs.openSync(this.logPath, 'r')
      const stat = fs.fstatSync(fd)
      const size = Math.min(stat.size, LOG_TAIL_BYTES)
      const buffer = Buffer.alloc(size)
      fs.readSync(fd, buffer, 0, size, stat.size - size)
      let text = buffer.toString('utf8')
      if (size === LOG_TAIL_BYTES) {
        const newline = text.indexOf('\n')
        if (newline >= 0) text = text.slice(newline + 1)
      }
      const out = text.split(/\r?\n/).filter((line) => line.trim() !== '')
      return out.slice(-Math.max(1, lines))
    } catch {
      return []
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd)
        } catch {
          /* ignore */
        }
      }
    }
  }

  _onExit(code, signal) {
    this._exited = true
    this._exitCode = code
    this._lastExit = { code, signal: signal ?? null, at: new Date().toISOString() }
    this._appendEngineLine(`mihomo exited code=${code} signal=${signal ?? 'none'}`)
    const waiters = this._exitWaiters.splice(0)
    for (const resolve of waiters) resolve(true)
  }

  _waitExit(timeoutMs) {
    if (!this.child || this._exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        resolve(false)
      }, timeoutMs)
      this._exitWaiters.push(() => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  _resetProcessState() {
    this.child = null
    this._exited = true
    this.startedAt = null
    this._exitWaiters = []
  }

  _procExists(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, filePath)
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`
}

function unquoteConfigValue(rawValue) {
  const value = String(rawValue ?? '').trim()
  if (value.startsWith("'")) {
    const end = value.lastIndexOf("'")
    if (end > 0) return value.slice(1, end).replace(/''/g, "'")
    return value.slice(1)
  }
  if (value.startsWith('"')) {
    const end = value.lastIndexOf('"')
    if (end > 0) {
      try {
        return JSON.parse(value.slice(0, end + 1))
      } catch {
        return value.slice(1, end)
      }
    }
    return value.slice(1)
  }
  const comment = value.indexOf(' #')
  return comment >= 0 ? value.slice(0, comment).trim() : value
}

function parseMaybeJson(text) {
  if (text == null || text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function tcpReachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
