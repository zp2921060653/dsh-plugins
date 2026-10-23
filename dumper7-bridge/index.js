// dsh-dumper7 — Dumper-7 bridge: inject the UE SDK dumper into a running game and inspect the SDK.
//
// Why a plugin instead of an MCP server: Dumper-7 ships a bare DLL with no IPC surface,
// so the only agent-operable interface is "inject + read the generated SDK".
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dumper7-bridge'
export const inject = ['tools']

const DEFAULT_PY = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python313\\python.exe'

export const Config = Schema.object({
  dllPath: Schema.string().default('C:\\tools\\Dumper-7\\Dumper-7.dll'),
  pythonBin: Schema.string().default(''),
  outputDir: Schema.string().default('C:\\Dumper-7'),
  defaultTimeoutMs: Schema.number().default(180000),
})

// ── helpers ────────────────────────────────────────────────────────────────

function pythonBin(config) {
  const c = (config.pythonBin || '').trim()
  if (c) return c
  if (fs.existsSync(DEFAULT_PY)) return DEFAULT_PY
  return 'python'
}

function run(cmd, args, opts) {
  const o = opts || {}
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) { reject(err); return }
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = o.timeoutMs ? setTimeout(() => {
      if (done) return
      done = true
      try { child.kill() } catch { /* ignore */ }
      resolve({ exitCode: -1, stdout, stderr, timedOut: true })
    }, o.timeoutMs) : null
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (err) => { if (done) return; done = true; if (timer) clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve({ exitCode: code, stdout, stderr, timedOut: false })
    })
  })
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function listProcesses() {
  const r = await run('tasklist', ['/FO', 'CSV', '/NH'], { timeoutMs: 20000 })
  const rows = []
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line)
    if (m) rows.push({ name: m[1], pid: Number(m[2]) })
  }
  return rows
}

function looksLikeUe(name) {
  return /-(Win64|Win32)-(Shipping|Debug|Test)/i.test(name) || /Shipping/i.test(name)
}

function newestDir(parent) {
  let best = null
  try {
    for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const full = path.join(parent, e.name)
      const st = fs.statSync(full)
      if (!best || st.mtimeMs > best.mtimeMs) best = { dir: full, name: e.name, mtimeMs: st.mtimeMs }
    }
  } catch { return null }
  return best
}

function walk(dir, limit, out) {
  const acc = out || []
  if (acc.length >= limit) return acc
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    if (acc.length >= limit) break
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, limit, acc)
    else acc.push(full)
  }
  return acc
}

const OUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    note: { type: 'string' },
    pid: { type: 'integer' },
    process: { type: 'string' },
    dll: { type: 'string' },
    sdkDir: { type: 'string' },
    files: { type: 'integer' },
    classes: { type: 'integer' },
    headers: { type: 'json' },
    classes_sample: { type: 'json' },
    source: { type: 'string' },
    python: { type: 'string' },
    outputDir: { type: 'string' },
    lastSdk: { type: 'string' },
    games: { type: 'json' },
  },
}

function render(_a, v) {
  const lines = []
  if (!v.ok) lines.push('失败: ' + (v.error || 'unknown'))
  if (v.note) lines.push(v.note)
  if (v.sdkDir) lines.push('SDK: ' + v.sdkDir)
  if (v.files != null) lines.push('文件: ' + v.files + (v.classes != null ? '，类/结构体: ' + v.classes : ''))
  if (v.headers) lines.push('头文件: ' + (Array.isArray(v.headers) ? v.headers.slice(0, 20).join(', ') : String(v.headers)))
  if (v.classes_sample) lines.push('类样例: ' + (Array.isArray(v.classes_sample) ? v.classes_sample.join(', ') : ''))
  if (v.source) lines.push('源码:\n' + v.source)
  if (v.games) lines.push('候选进程: ' + (v.games.length ? v.games.map((g) => g.name + '(' + g.pid + ')').join(', ') : '（无）'))
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}

// ── plugin ─────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const script = fileURLToPath(new URL('lib/inject_dll.py', import.meta.url))

  ctx.tools.register(defineTool({
    name: 'dumper7_status',
    description: '检查 Dumper-7 注入环境：DLL 是否存在、Python 解释器、默认输出目录、以及当前可能为 UE 游戏的进程（*Win64-Shipping 之类）。注入前先跑这个。',
    parameters: {},
    output: { schema: OUT, render },
    async execute() {
      const dll = config.dllPath
      const py = pythonBin(config)
      const out = {
        ok: true,
        dll,
        python: py,
        outputDir: config.outputDir,
      }
      if (!fs.existsSync(dll)) {
        out.ok = false
        out.error = '未找到 Dumper-7.dll: ' + dll + '（把 DLL 放到该路径，或在插件配置里改 dllPath）'
      }
      try {
        const v = await run(py, ['--version'], { timeoutMs: 20000 })
        out.python = py + ' -> ' + (v.stdout || v.stderr).trim()
        if (v.exitCode !== 0) { out.ok = false; out.error = 'Python 不可用: ' + out.python }
      } catch (err) {
        out.ok = false
        out.error = 'Python 不可用: ' + err.message
      }
      const last = newestDir(config.outputDir)
      if (last) out.lastSdk = last.dir
      try {
        const procs = await listProcesses()
        out.games = procs.filter((p) => looksLikeUe(p.name)).slice(0, 15)
        if (out.games.length === 0) out.note = '没发现 UE 游戏进程；先启动游戏再注入。'
      } catch { /* ignore */ }
      return out
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dumper7_dump',
    description: '把 Dumper-7.dll 注入到指定游戏进程，等待 SDK 生成完成。process 支持进程名（如 Game-Win64-Shipping.exe）或 PID。DLL 会以 LoadLibrary 方式加载，游戏必须以普通权限运行（注入器与被注入进程位数一致）。',
    parameters: {
      process: { type: 'string', required: true, description: '进程名（Game-Win64-Shipping.exe，可省略 .exe）或 PID' },
      dllPath: { type: 'string', description: '覆盖 DLL 路径' },
      outputDir: { type: 'string', description: '覆盖 SDK 输出目录（默认 C:\\Dumper-7）' },
      timeoutMs: { type: 'integer', description: '等待 SDK 生成的超时（毫秒）' },
    },
    output: { schema: OUT, render },
    async execute(args) {
      const dll = args.dllPath || config.dllPath
      if (!fs.existsSync(dll)) return { ok: false, error: '未找到 DLL: ' + dll }
      let pid = 0
      let procName = ''
      const raw = String(args.process || '').trim()
      try {
        if (/^\d+$/.test(raw)) {
          pid = Number(raw)
          procName = raw
        } else {
          const want = raw.toLowerCase().replace(/\.exe$/, '')
          const procs = (await listProcesses()).filter((p) => p.name.toLowerCase().replace(/\.exe$/, '') === want)
          if (procs.length === 0) return { ok: false, error: '未找到进程: ' + raw }
          if (procs.length > 1) return { ok: false, error: '同名进程有 ' + procs.length + ' 个，请用 PID: ' + procs.map((p) => p.pid).join(', ') }
          pid = procs[0].pid
          procName = procs[0].name
        }
      } catch (err) {
        return { ok: false, error: '枚举进程失败: ' + err.message }
      }

      const py = pythonBin(config)
      const before = newestDir(args.outputDir || config.outputDir)
      const r = await run(py, [script, String(pid), dll], { timeoutMs: 60000 })
      let parsed = null
      try {
        const line = r.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()
        parsed = line ? JSON.parse(line) : null
      } catch { /* ignore */ }
      if (!parsed || !parsed.ok) {
        return {
          ok: false,
          pid,
          process: procName,
          dll,
          error: (parsed && parsed.error) || (r.stderr || '').trim() || '注入失败（退出码 ' + r.exitCode + '）',
        }
      }

      // Dumper-7 写出 SDK 需要时间：等待输出目录出现新目录
      const outDir = args.outputDir || config.outputDir
      const deadline = Date.now() + Math.min(args.timeoutMs || config.defaultTimeoutMs, config.defaultTimeoutMs)
      let found = null
      while (Date.now() < deadline) {
        const now = newestDir(outDir)
        if (now && (!before || now.dir !== before.dir)) { found = now; break }
        if (now && before && now.dir === before.dir) {
          const st = fs.statSync(now.dir)
          if (st.mtimeMs > before.mtimeMs) { found = now; break }
        }
        await sleep(1500)
      }
      if (!found) {
        return {
          ok: false,
          pid,
          process: procName,
          dll,
          outputDir: outDir,
          error: '注入成功，但等待超时仍未见 SDK 输出。检查游戏内是否弹窗/崩溃，或看 ' + outDir,
        }
      }
      const files = walk(found.dir, 5000)
      return {
        ok: true,
        pid,
        process: procName,
        dll,
        sdkDir: found.dir,
        files: files.length,
        note: 'SDK 已生成到 ' + found.dir,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dumper7_sdk',
    description: '列出一个 Dumper-7 SDK 目录的结构：文件数、头文件、类/结构体名（抽样）。sdkDir 省略时取输出目录里最新的一个。',
    parameters: {
      sdkDir: { type: 'string', description: 'SDK 目录；省略则取 outputDir 下最新目录' },
      limit: { type: 'integer', description: '最多扫描文件数，缺省 5000' },
    },
    output: { schema: OUT, render },
    async execute(args) {
      let dir = args.sdkDir
      if (!dir) {
        const last = newestDir(config.outputDir)
        if (!last) return { ok: false, error: '输出目录里没有 SDK: ' + config.outputDir }
        dir = last.dir
      }
      if (!fs.existsSync(dir)) return { ok: false, error: '目录不存在: ' + dir }
      const files = walk(dir, Math.min(args.limit || 5000, 20000))
      const headers = files.filter((f) => /\.(hpp|h)$/i.test(f)).map((f) => path.relative(dir, f))
      const samples = []
      let classes = 0
      for (const rel of headers.slice(0, 400)) {
        let text = ''
        try { text = fs.readFileSync(path.join(dir, rel), 'utf8') } catch { continue }
        const re = /^(?:class|struct)\s+(?:[A-Za-z_]\w*\s+)*([A-Za-z_]\w*)\s*(?::|\{|$)/gm
        let m
        while ((m = re.exec(text)) !== null) {
          classes++
          if (samples.length < 100) samples.push(m[1])
        }
      }
      return { ok: true, sdkDir: dir, files: files.length, classes, headers: headers.slice(0, 60), classes_sample: samples }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dumper7_class',
    description: '从一个 Dumper-7 SDK 里取出某个类/结构体的完整声明（含成员与偏移注释），常用于写外部 ESP/读内存代码。',
    parameters: {
      name: { type: 'string', required: true, description: '类名，如 PlayerController 或 APlayerController' },
      sdkDir: { type: 'string', description: 'SDK 目录；省略则取最新' },
    },
    output: { schema: OUT, render },
    async execute(args) {
      let dir = args.sdkDir
      if (!dir) {
        const last = newestDir(config.outputDir)
        if (!last) return { ok: false, error: '输出目录里没有 SDK: ' + config.outputDir }
        dir = last.dir
      }
      const want = String(args.name || '').trim()
      if (!want) return { ok: false, error: 'name 不能为空' }
      const files = walk(dir, 20000).filter((f) => /\.(hpp|h)$/i.test(f))
      const needle = new RegExp('(?:class|struct)\\s+(?:[A-Za-z_]\\w*\\s+)*(' + want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\b')
      for (const file of files) {
        let text = ''
        try { text = fs.readFileSync(file, 'utf8') } catch { continue }
        const m = needle.exec(text)
        if (!m) continue
        const start = m.index
        const open = text.indexOf('{', start)
        if (open < 0) continue
        let depth = 0
        let end = -1
        for (let i = open; i < text.length; i++) {
          const ch = text[i]
          if (ch === '{') depth++
          else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break } }
        }
        if (end < 0) continue
        const block = text.slice(start, Math.min(end, start + 20000))
        return { ok: true, sdkDir: dir, classes: 1, source: block }
      }
      return { ok: false, error: '在 ' + dir + ' 里没有找到 ' + want }
    },
  }))
}
