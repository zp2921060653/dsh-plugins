// dsh-vpn 系统代理（Windows WinINET）开关 —— 快照 / 应用 / 精确还原。
//
// 目标：插件 running 时把 Windows 应用层系统代理（HKCU Internet Settings，浏览器/Electron/
// 大多数桌面软件读的那份）一键指向插件自己的 mihomo mixed 端口；关闭/停用/降级/卸载/退出时
// **精确还原用户原值**（例如用户 Clash Verge 的 127.0.0.1:7897），绝不把系统代理留在指向
// 已停止插件端口的状态。
//
// 设计：
//   - Runner 抽象（依赖注入）：真实实现用 reg.exe + powershell.exe；测试用内存 runner，
//     绝不触碰真实注册表。
//   - 所有子进程都用**文件 fd**（`stdio: ['ignore', outFd, errFd]`）捕获输出：本环境沙箱禁止
//     pipe stdio，真实宿主里文件 fd 同样最稳；输出写临时文件再读回，进程结束即清理。
//   - 快照在**首次 apply 时**由调用方（service）决定并持久化到 state.json：
//       { proxyEnable, proxyServer, proxyOverride, autoConfigUrl } + capturedAt + autoConfigUrlCleared
//     apply({port, snapshot}) 传了 snapshot 就沿用（换端口不重新快照），没传则按防呆规则尝试捕获。
//   - 防呆：端口必须 1024-65535；当前 ProxyServer 已在插件端口段（127.0.0.1:18000-19999）且没有
//     快照时，**不把我们自己的端口记成"原值"**（快照为 null，还原时退化为安全关闭 ProxyEnable）。
//   - 幂等：已经精确指向目标时 apply 直接返回 changed:false。
//   - 失败回滚：写注册表/清 PAC/发 WinINET 通知/读回校验任一步失败 → 回滚到操作前的实际值，
//     返回 { ok:false, error, rolledBack:true }。
//   - WinINET 通知：powershell -NoProfile -NonInteractive -Command 内 Add-Type P/Invoke
//     InternetSetOptionW(NULL, INTERNET_OPTION_SETTINGS_CHANGED=39 / REFRESH=37)，让浏览器等
//     已运行进程立即感知（失败按规格视为 apply 失败并回滚）。
//
// 本模块不 import dsh 包，普通 node 可直接 import 做纯逻辑自测。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { errorMessage } from './state.mjs'

/** HKCU 下的 Internet Settings 键（WinINET 系统代理）。 */
export const REG_KEY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** 我们关心的四个值（只修改前三个；AutoConfigURL 仅在需要时暂存/临时清空）。 */
export const SNAPSHOT_VALUE_NAMES = ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL']

/** 插件自动分配的端口段（mixed 18000-18999 / controller 19000-19999）。 */
export const PLUGIN_PORT_MIN = 18000
export const PLUGIN_PORT_MAX = 19999

/** 必须保证的 bypass 条目（其余保留用户原条目）。 */
export const REQUIRED_BYPASS_TOKENS = ['localhost', '127.*', '::1', '<local>']

const DEFAULT_TYPE = { ProxyEnable: 'REG_DWORD', ProxyServer: 'REG_SZ', ProxyOverride: 'REG_SZ', AutoConfigURL: 'REG_SZ' }

const PS_REFRESH_SCRIPT = [
  "$sig = '[DllImport(\"wininet.dll\", SetLastError = true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);'",
  'try {',
  "  $t = Add-Type -MemberDefinition $sig -Name 'DshVpnWinINet' -Namespace 'DshVpn' -PassThru -ErrorAction Stop",
  '  [void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)',
  '  [void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)',
  "  Write-Output 'REFRESH_OK'",
  '} catch {',
  '  Write-Error $_.Exception.Message',
  '  exit 1',
  '}',
].join('\n')

/** 平台是否支持系统代理开关。 */
export function isSupported(platform = process.platform) {
  return platform === 'win32'
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 退化为忙等（极少走到） */
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* spin */
    }
  }
}

function safeReadFile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function truncate(text, max = 400) {
  const value = String(text || '').trim()
  return value.length <= max ? value : value.slice(0, max) + '…'
}

/**
 * 同步运行一个子进程，stdout/stderr 走**文件 fd**（不用 pipe）。
 * 返回 { status, signal, error, stdout, stderr }。
 */
export function runCapturedSync(command, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
  const env = options.env || process.env
  let tmpDir = null
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vpn-sysproxy-'))
    const outPath = path.join(tmpDir, 'out.log')
    const errPath = path.join(tmpDir, 'err.log')
    let outFd = null
    let errFd = null
    let result
    try {
      outFd = fs.openSync(outPath, 'w')
      errFd = fs.openSync(errPath, 'w')
      result = spawnSync(command, args, {
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
        timeout: timeoutMs,
        env,
      })
    } finally {
      try {
        if (outFd !== null) fs.closeSync(outFd)
      } catch {
        /* ignore */
      }
      try {
        if (errFd !== null) fs.closeSync(errFd)
      } catch {
        /* ignore */
      }
    }
    return {
      status: typeof result.status === 'number' ? result.status : null,
      signal: result.signal || null,
      error: result.error || null,
      stdout: safeReadFile(outPath),
      stderr: safeReadFile(errPath),
    }
  } catch (error) {
    return { status: null, signal: null, error, stdout: '', stderr: '' }
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

function resolveSystemExe(candidates, fallback) {
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return fallback
}

function regExe() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return resolveSystemExe([path.join(root, 'System32', 'reg.exe'), 'C:\\Windows\\System32\\reg.exe'], 'reg.exe')
}

function powershellExe() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return resolveSystemExe(
    [path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'powershell.exe'],
    'powershell.exe',
  )
}

/** 解析 `reg query` 输出为 { name: { type, data } }（跳过 (Default)）。 */
export function parseRegQueryOutput(text) {
  const values = {}
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const re = /^\s{4,}(\S.*?)\s{2,}(REG_[A-Z0-9_]+)(?:\s{2,}(.*))?$/
  for (const line of lines) {
    const match = re.exec(line)
    if (!match) continue
    const name = match[1].trim()
    if (!name || name === '(Default)') continue
    values[name] = { type: match[2], data: match[3] === undefined ? '' : match[3] }
  }
  return values
}

/**
 * 真实 Windows runner：reg.exe 读写 + powershell.exe WinINET 通知。
 * 所有子进程输出走文件 fd（不用 pipe），符合沙箱限制。
 */
export function createRegRunner(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const platform = options.platform || process.platform
  return {
    platform,
    readValues() {
      const res = runCapturedSync(regExe(), ['query', REG_KEY_PATH], { timeoutMs: options.timeoutMs || 10000 })
      if (res.error && res.error.code === 'ENOENT') {
        return { ok: false, error: 'reg.exe 不可用: ' + errorMessage(res.error) }
      }
      if (res.status !== 0) {
        // 键/值不存在时 reg 返回非 0，但内容是 "unable to find"——视为空值，不是错误
        if (/unable to find|找不到|ERROR: The system was unable/i.test(res.stderr || '')) {
          return { ok: true, values: {} }
        }
        return { ok: false, error: 'reg query 失败（exit ' + String(res.status) + '）: ' + truncate(res.stderr || res.stdout) }
      }
      return { ok: true, values: parseRegQueryOutput(res.stdout) }
    },
    writeValue(name, type, data) {
      const res = runCapturedSync(
        regExe(),
        ['add', REG_KEY_PATH, '/v', name, '/t', type || DEFAULT_TYPE[name] || 'REG_SZ', '/d', String(data ?? ''), '/f'],
        { timeoutMs: options.timeoutMs || 10000 },
      )
      if (res.status === 0) return { ok: true }
      return { ok: false, error: 'reg add ' + name + ' 失败（exit ' + String(res.status) + '）: ' + truncate(res.stderr || res.stdout) }
    },
    deleteValue(name) {
      const res = runCapturedSync(regExe(), ['delete', REG_KEY_PATH, '/v', name, '/f'], {
        timeoutMs: options.timeoutMs || 10000,
      })
      if (res.status === 0) return { ok: true }
      if (/unable to find|找不到/i.test(res.stderr || res.stdout || '')) return { ok: true, missing: true }
      return { ok: false, error: 'reg delete ' + name + ' 失败（exit ' + String(res.status) + '）: ' + truncate(res.stderr || res.stdout) }
    },
    notify() {
      const res = runCapturedSync(
        powershellExe(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_REFRESH_SCRIPT],
        { timeoutMs: options.notifyTimeoutMs || 20000 },
      )
      if (res.status === 0 && /REFRESH_OK/.test(res.stdout || '')) return { ok: true }
      log('warning', 'dsh-vpn: WinINET 通知失败: ' + truncate(res.stderr || res.stdout || errorMessage(res.error)))
      return { ok: false, error: 'WinINET 通知失败（exit ' + String(res.status) + '）: ' + truncate(res.stderr || res.stdout) }
    },
  }
}

/**
 * 内存 runner（自测用，绝不影响真实注册表）。
 * @param {Record<string, {type?: string, data?: string}>} initial
 */
export function createMemoryRunner(initial = {}, options = {}) {
  const values = new Map()
  for (const [name, entry] of Object.entries(initial || {})) {
    if (!entry) continue
    values.set(name, { type: entry.type || DEFAULT_TYPE[name] || 'REG_SZ', data: String(entry.data ?? '') })
  }
  const calls = []
  const failures = { read: false, write: null, writeSilent: null, delete: null, notify: false }
  const runner = {
    platform: options.platform || 'win32',
    calls,
    values,
    failures,
    failRead(value = true) {
      failures.read = value
    },
    failWrite(name = '*', mode = 'error') {
      if (mode === 'silent') failures.writeSilent = name
      else failures.write = name
    },
    failDelete(name = '*') {
      failures.delete = name
    },
    failNotify(value = true) {
      failures.notify = value
    },
    setValue(name, data, type) {
      values.set(name, { type: type || DEFAULT_TYPE[name] || 'REG_SZ', data: String(data ?? '') })
    },
    getValue(name) {
      return values.get(name) || null
    },
    resetCalls() {
      calls.length = 0
    },
    readValues() {
      calls.push({ op: 'read' })
      if (failures.read) return { ok: false, error: 'fake read failure' }
      const out = {}
      for (const [name, entry] of values.entries()) out[name] = { type: entry.type, data: entry.data }
      return { ok: true, values: out }
    },
    writeValue(name, type, data) {
      calls.push({ op: 'write', name, type, data: String(data ?? '') })
      if (failures.write === name || failures.write === '*') return { ok: false, error: 'fake write failure: ' + name }
      if (failures.writeSilent === name || failures.writeSilent === '*') return { ok: true }
      values.set(name, { type: type || DEFAULT_TYPE[name] || 'REG_SZ', data: String(data ?? '') })
      return { ok: true }
    },
    deleteValue(name) {
      calls.push({ op: 'delete', name })
      if (failures.delete === name || failures.delete === '*') return { ok: false, error: 'fake delete failure: ' + name }
      const existed = values.delete(name)
      return { ok: true, missing: !existed }
    },
    notify() {
      calls.push({ op: 'notify' })
      if (failures.notify) return { ok: false, error: 'fake notify failure' }
      return { ok: true }
    },
  }
  return runner
}

// ---------------------------------------------------------------------------
// 纯函数：端口/ProxyServer 判定、bypass 合并、值归一化
// ---------------------------------------------------------------------------

export function isValidProxyPort(port) {
  return Number.isInteger(Number(port)) && Number(port) >= 1024 && Number(port) <= 65535
}

export function buildTargetProxyServer(port) {
  return '127.0.0.1:' + String(Number(port))
}

/** ProxyServer 形如 "127.0.0.1:18414" 或 "http=127.0.0.1:18000;https=127.0.0.1:18000"。 */
export function parseProxyServerPorts(value) {
  const text = String(value ?? '').trim()
  if (!text) return []
  const candidates = text.includes('=') ? text.split(';').map((part) => String(part).split('=').slice(1).join('=')) : [text]
  const ports = []
  for (const candidate of candidates) {
    const match = /^(?:127\.0\.0\.1|localhost):(\d{1,5})$/i.exec(String(candidate || '').trim())
    if (match) ports.push(Number(match[1]))
  }
  return ports
}

/** 当前 ProxyServer 是否指向插件端口段（127.0.0.1:18000-19999）。 */
export function isPluginProxyServer(value) {
  return parseProxyServerPorts(value).some((port) => port >= PLUGIN_PORT_MIN && port <= PLUGIN_PORT_MAX)
}

/** 把用户原 bypass 与必须条目合并（保留原顺序/条目，大小写不敏感去重）。 */
export function mergeBypass(existing) {
  const tokens = String(existing ?? '')
    .split(';')
    .map((token) => token.trim())
    .filter(Boolean)
  const seen = new Set(tokens.map((token) => token.toLowerCase()))
  for (const required of REQUIRED_BYPASS_TOKENS) {
    if (!seen.has(required.toLowerCase())) {
      tokens.push(required)
      seen.add(required.toLowerCase())
    }
  }
  return tokens.join(';')
}

/** 解析 REG_DWORD 数据（"0x1"/"1"/缺省）。 */
export function parseDword(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16)
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10)
  return null
}

function normalizeValueForCompare(entry) {
  if (!entry || entry.exists === false) return null
  const type = String(entry.type || '').toUpperCase()
  if (type === 'REG_DWORD') return { kind: 'dword', value: parseDword(entry.data) }
  return { kind: 'string', value: String(entry.data ?? '') }
}

function valuesEqual(a, b) {
  const left = normalizeValueForCompare(a)
  const right = normalizeValueForCompare(b)
  if (left === null && right === null) return true
  if (left === null || right === null) return false
  return left.kind === right.kind && left.value === right.value
}

/** 把 readSystemProxy() 的 normalized 值转成 status 展示用的简化对象。 */
export function describeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const pick = (entry) => {
    if (!entry || entry.exists === false) return null
    if (String(entry.type || '').toUpperCase() === 'REG_DWORD') return parseDword(entry.data)
    return String(entry.data ?? '')
  }
  return {
    proxyEnable: pick(snapshot.proxyEnable),
    proxyServer: pick(snapshot.proxyServer),
    proxyOverride: pick(snapshot.proxyOverride),
    autoConfigUrl: pick(snapshot.autoConfigUrl),
    capturedAt: typeof snapshot.capturedAt === 'number' ? snapshot.capturedAt : null,
    autoConfigUrlCleared: Boolean(snapshot.autoConfigUrlCleared),
  }
}

/** 快照形状校验（service 会从 state.json 读回，可能被手改/损坏）。 */
export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, error: '快照不是对象' }
  if (snapshot.version !== 1) return { ok: false, error: '快照版本不支持: ' + String(snapshot.version) }
  if (typeof snapshot.capturedAt !== 'number') return { ok: false, error: '快照缺少 capturedAt' }
  for (const key of ['proxyEnable', 'proxyServer', 'proxyOverride']) {
    const entry = snapshot[key]
    if (!entry || typeof entry !== 'object') return { ok: false, error: '快照缺少 ' + key }
    if (typeof entry.exists !== 'boolean') return { ok: false, error: '快照 ' + key + ' 缺少 exists' }
    if (entry.exists && entry.data === undefined) return { ok: false, error: '快照 ' + key + ' 缺少 data' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// SystemProxyManager
// ---------------------------------------------------------------------------

export class SystemProxyManager {
  /**
   * @param {{ runner?: object, platform?: string, log?: (level: string, message: string) => void }} options
   */
  constructor(options = {}) {
    this.platform = options.platform || process.platform
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.runner = options.runner || (isSupported(this.platform) ? createRegRunner({ log: this.log }) : null)
  }

  get supported() {
    return isSupported(this.platform) && Boolean(this.runner)
  }

  /** 读取当前系统代理。永不抛错：返回 { ok, values, normalized } 或 { ok:false, error }。 */
  readSystemProxy() {
    if (!this.supported) {
      return { ok: false, supported: false, error: '系统代理仅支持 Windows（当前平台: ' + this.platform + '）' }
    }
    const res = this.runner.readValues()
    if (!res || res.ok !== true) {
      return { ok: false, supported: true, error: '读取系统代理失败: ' + ((res && res.error) || 'unknown') }
    }
    const raw = res.values || {}
    const entries = {}
    for (const name of SNAPSHOT_VALUE_NAMES) {
      entries[name] = raw[name]
        ? { exists: true, type: raw[name].type || DEFAULT_TYPE[name] || null, data: raw[name].data === undefined ? '' : raw[name].data }
        : { exists: false, type: null, data: null }
    }
    return {
      ok: true,
      supported: true,
      values: entries,
      normalized: {
        proxyEnable: parseDword(entries.ProxyEnable.data),
        proxyServer: entries.ProxyServer.data,
        proxyOverride: entries.ProxyOverride.data,
        autoConfigUrl: entries.AutoConfigURL.data,
      },
    }
  }

  /** 用一次 read 结果生成快照（首次 apply 时由 service 决定是否采用）。 */
  makeSnapshot(readResult, options = {}) {
    const values = (readResult && readResult.values) || {}
    return {
      version: 1,
      capturedAt: Date.now(),
      proxyEnable: values.ProxyEnable || { exists: false, type: null, data: null },
      proxyServer: values.ProxyServer || { exists: false, type: null, data: null },
      proxyOverride: values.ProxyOverride || { exists: false, type: null, data: null },
      autoConfigUrl: values.AutoConfigURL || { exists: false, type: null, data: null },
      autoConfigUrlCleared: false,
      pluginPort: Number.isInteger(options.port) ? options.port : null,
    }
  }

  _writeOrThrow(name, type, data) {
    const res = this.runner.writeValue(name, type || DEFAULT_TYPE[name] || 'REG_SZ', data)
    if (!res || res.ok !== true) throw new Error('写注册表 ' + name + ' 失败: ' + ((res && res.error) || 'unknown'))
  }

  _deleteOrThrow(name) {
    const res = this.runner.deleteValue(name)
    if (!res || res.ok !== true) throw new Error('删除注册表 ' + name + ' 失败: ' + ((res && res.error) || 'unknown'))
  }

  /** 把四个值精确恢复到 `values`（{name:{exists,type,data}}）；尽力而为，永不抛错。 */
  _rollbackTo(values) {
    const results = []
    for (const name of SNAPSHOT_VALUE_NAMES) {
      const entry = values && values[name] ? values[name] : { exists: false }
      try {
        if (entry.exists) {
          const res = this.runner.writeValue(name, entry.type || DEFAULT_TYPE[name] || 'REG_SZ', entry.data === undefined ? '' : entry.data)
          results.push({ name, ok: Boolean(res && res.ok !== false), error: res && res.error ? String(res.error) : null })
        } else {
          const res = this.runner.deleteValue(name)
          results.push({ name, ok: Boolean(res && res.ok !== false), error: res && res.error ? String(res.error) : null })
        }
      } catch (error) {
        results.push({ name, ok: false, error: errorMessage(error) })
      }
    }
    return results
  }

  _notify() {
    try {
      const res = this.runner.notify()
      return res && res.ok === true ? { ok: true } : { ok: false, error: (res && res.error) || 'WinINET 通知失败' }
    } catch (error) {
      return { ok: false, error: 'WinINET 通知异常: ' + errorMessage(error) }
    }
  }

  /**
   * 把系统代理指向 127.0.0.1:<port>。
   *
   * @param {{ port: number, snapshot?: object|null, notify?: boolean }} options
   *   - snapshot: 首次 apply 由 service 传入（已持久化）；换端口/重接管时沿用同一快照，不会重拍。
   * @returns {{ok:boolean, ...}}
   */
  applySystemProxy(options = {}) {
    const port = Number(options.port)
    if (!isSupported(this.platform)) {
      return { ok: false, supported: false, error: '系统代理仅支持 Windows（当前平台: ' + this.platform + '）' }
    }
    if (!this.runner) return { ok: false, supported: false, error: '注册表 runner 不可用' }
    if (!isValidProxyPort(port)) {
      return { ok: false, error: '系统代理端口非法（需 1024-65535）: ' + String(options.port) }
    }
    const target = buildTargetProxyServer(port)
    const notify = options.notify !== false

    const before = this.readSystemProxy()
    if (!before.ok) return { ok: false, error: before.error, target, port }

    // 幂等：已经精确指向目标 → 不重复写、不重拍快照
    if (Number(before.normalized.proxyEnable) === 1 && String(before.normalized.proxyServer || '').trim() === target) {
      return {
        ok: true,
        applied: true,
        changed: false,
        target,
        port,
        bypass: mergeBypass(before.normalized.proxyOverride),
        snapshot: options.snapshot || null,
        capturedSnapshot: false,
        autoConfigUrlCleared: false,
        readback: before.normalized,
      }
    }

    // 快照：调用方传了就沿用；没传只在“当前不是插件端口段”时捕获（绝不把自己的端口当原值）
    let snapshot = options.snapshot && typeof options.snapshot === 'object' ? options.snapshot : null
    let capturedSnapshot = false
    if (!snapshot) {
      if (!isPluginProxyServer(before.normalized.proxyServer)) {
        snapshot = this.makeSnapshot(before, { port })
        capturedSnapshot = true
      } else {
        this.log(
          'warning',
          'dsh-vpn: 当前系统代理已指向插件端口段（' + String(before.normalized.proxyServer) + '）但没有可用快照，无法精确还原；本次不覆盖原值',
        )
        snapshot = null
      }
    }

    const bypass = mergeBypass(before.normalized.proxyOverride)
    try {
      this._writeOrThrow('ProxyEnable', 'REG_DWORD', '1')
      this._writeOrThrow('ProxyServer', 'REG_SZ', target)
      this._writeOrThrow('ProxyOverride', 'REG_SZ', bypass)

      // PAC（AutoConfigURL）存在时，手动代理通常不会生效 → 暂存原值并临时清空（快照里记录，还原时写回）
      let autoConfigUrlCleared = false
      if (before.values.AutoConfigURL.exists) {
        this._deleteOrThrow('AutoConfigURL')
        autoConfigUrlCleared = true
        if (snapshot) snapshot.autoConfigUrlCleared = true
      }

      if (notify) {
        const notified = this._notify()
        if (!notified.ok) throw new Error(notified.error)
      }

      const after = this.readSystemProxy()
      if (!after.ok) throw new Error('写入后读取校验失败: ' + after.error)
      const ok =
        Number(after.normalized.proxyEnable) === 1 && String(after.normalized.proxyServer || '').trim() === target
      if (!ok) {
        throw new Error(
          '写入后校验失败（ProxyEnable=' +
            String(after.normalized.proxyEnable) +
            ', ProxyServer=' +
            String(after.normalized.proxyServer) +
            '）',
        )
      }
      return {
        ok: true,
        applied: true,
        changed: true,
        target,
        port,
        bypass,
        snapshot,
        capturedSnapshot,
        autoConfigUrlCleared,
        appliedAt: Date.now(),
        readback: after.normalized,
      }
    } catch (error) {
      const rollback = this._rollbackTo(before.values)
      if (notify) this._notify()
      return {
        ok: false,
        applied: false,
        target,
        port,
        error: errorMessage(error),
        rolledBack: true,
        rollback,
        snapshot,
        capturedSnapshot,
      }
    }
  }

  /**
   * 精确还原系统代理。
   *
   * @param {object|null} snapshot 首次 apply 时的快照；null → 安全兜底（只关闭 ProxyEnable）
   * @param {{ notify?: boolean }} options
   */
  restoreSystemProxy(snapshot, options = {}) {
    if (!isSupported(this.platform)) {
      return { ok: false, supported: false, error: '系统代理仅支持 Windows（当前平台: ' + this.platform + '）' }
    }
    if (!this.runner) return { ok: false, supported: false, error: '注册表 runner 不可用' }
    const notify = options.notify !== false

    const before = this.readSystemProxy()
    if (!before.ok) return { ok: false, error: before.error }

    // 无快照 → 安全兜底：只把 ProxyEnable 关掉，绝不留下指向插件端口的指针
    if (snapshot === null || snapshot === undefined) {
      try {
        this._writeOrThrow('ProxyEnable', 'REG_DWORD', '0')
        if (notify) {
          const notified = this._notify()
          if (!notified.ok) throw new Error(notified.error)
        }
        const after = this.readSystemProxy()
        if (!after.ok) throw new Error('还原后读取校验失败: ' + after.error)
        if (Number(after.normalized.proxyEnable) !== 0) throw new Error('还原后 ProxyEnable 仍非 0')
        return { ok: true, restored: true, mode: 'disabled-no-snapshot', readback: after.normalized, warning: '没有原始系统代理快照，已安全关闭系统代理' }
      } catch (error) {
        this._rollbackTo(before.values)
        return { ok: false, error: '安全关闭系统代理失败: ' + errorMessage(error), rolledBack: true, mode: 'disabled-no-snapshot' }
      }
    }

    const shape = validateSnapshot(snapshot)
    if (!shape.ok) return { ok: false, error: '快照形状非法: ' + shape.error }

    try {
      const mapping = [
        ['ProxyEnable', 'proxyEnable'],
        ['ProxyServer', 'proxyServer'],
        ['ProxyOverride', 'proxyOverride'],
      ]
      for (const [regName, key] of mapping) {
        const original = snapshot[key]
        if (original && original.exists) {
          const type = original.type || DEFAULT_TYPE[regName] || 'REG_SZ'
          const data = original.data === undefined || original.data === null ? '' : original.data
          // 空字符串的 REG_SZ 用删除表达（reg add 空数据不可靠；语义等价：没有该条目）
          if (type === 'REG_SZ' && String(data) === '') this._deleteOrThrow(regName)
          else this._writeOrThrow(regName, type, data)
        } else {
          this._deleteOrThrow(regName)
        }
      }
      // AutoConfigURL：原始有就写回；原始没有但被我们清空过就删掉
      if (snapshot.autoConfigUrl && snapshot.autoConfigUrl.exists) {
        this._writeOrThrow('AutoConfigURL', snapshot.autoConfigUrl.type || 'REG_SZ', snapshot.autoConfigUrl.data ?? '')
      } else if (snapshot.autoConfigUrlCleared) {
        this._deleteOrThrow('AutoConfigURL')
      }

      if (notify) {
        const notified = this._notify()
        if (!notified.ok) throw new Error(notified.error)
      }

      const after = this.readSystemProxy()
      if (!after.ok) throw new Error('还原后读取校验失败: ' + after.error)
      const mismatches = []
      for (const [regName, key] of mapping) {
        if (!valuesEqual(after.values[regName], snapshot[key])) mismatches.push(regName)
      }
      if (snapshot.autoConfigUrl && snapshot.autoConfigUrl.exists && !valuesEqual(after.values.AutoConfigURL, snapshot.autoConfigUrl)) {
        mismatches.push('AutoConfigURL')
      }
      if (mismatches.length > 0) throw new Error('还原后校验不一致: ' + mismatches.join(', '))

      return { ok: true, restored: true, mode: 'precise', readback: after.normalized }
    } catch (error) {
      const rollback = this._rollbackTo(before.values)
      if (notify) this._notify()
      return {
        ok: false,
        error: '还原系统代理失败: ' + errorMessage(error),
        rolledBack: true,
        rollback,
        mode: 'precise',
      }
    }
  }

  /** 当前实际状态摘要（不读注册表，仅取最近一次 readback；status 的实时判定由 service 做）。 */
  lastKnown() {
    return {
      supported: this.supported,
      platform: this.platform,
    }
  }
}

// ---------------------------------------------------------------------------
// 便捷单例函数（可选使用；service 使用自己的 SystemProxyManager 实例以便注入 runner）
// ---------------------------------------------------------------------------

let defaultManager = null

function defaultMgr() {
  if (!defaultManager) defaultManager = new SystemProxyManager({ log: () => {} })
  return defaultManager
}

export function readSystemProxy() {
  return defaultMgr().readSystemProxy()
}

export function applySystemProxy(options) {
  return defaultMgr().applySystemProxy(options)
}

export function restoreSystemProxy(snapshot, options) {
  return defaultMgr().restoreSystemProxy(snapshot, options)
}

export default SystemProxyManager
