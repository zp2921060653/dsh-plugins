// dsh-wxapkg - WeChat mini-program (wxapkg) bridge.
// Decompiles cached mini-program packages with a bundled, patched wedecode,
// then analyzes the restored project structure.
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess, killPid } from './lib/run.js'
import { scanPackages, latestPackage, defaultScanRoots } from './lib/scan.js'
import { analyzeProject, renderAnalysis } from './lib/analyze.js'

export const name = 'wxapkg-bridge'
export const inject = ['tools', 'jobs']

// Node 运行时：优先 config.nodeBin；未配置时回退到 DSH 自带运行时
// （Electron 以 ELECTRON_RUN_AS_NODE=1 方式当 node 用），
// 因为官方桌面安装不保证 PATH 里有独立 node。
function nodeRuntime(config) {
  const c = (config.nodeBin || '').trim()
  if (c && c !== 'node') return { cmd: c, env: process.env }
  return { cmd: process.execPath, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) }
}

export const Config = Schema.object({
  wedecodeEntry: Schema.string().default(''),
  nodeBin: Schema.string().default(''),
  extraScanRoots: Schema.string().default(''),
  defaultOutputDir: Schema.string().default(''),
  defaultTimeoutMs: Schema.number().default(900000),
  maxTimeoutMs: Schema.number().default(3600000),
  maxOutputChars: Schema.number().default(200000),
})

function bundledEntry() {
  return fileURLToPath(new URL('vendor/wedecode/dist/wedecode.js', import.meta.url))
}

function resolveEntry(config) {
  const c = (config.wedecodeEntry || '').trim()
  return c || bundledEntry()
}

function extraRoots(config) {
  const raw = (config.extraScanRoots || '').trim()
  if (!raw) return []
  return raw.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)
}

function quickCount(dir) {
  let files = 0
  let bytes = 0
  const stack = [dir]
  let budget = 30000
  while (stack.length && budget > 0) {
    const d = stack.pop()
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (budget-- <= 0) break
      const full = path.join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else { files++; try { bytes += fs.statSync(full).size } catch { /* ignore */ } }
    }
  }
  return { files, bytes }
}

function looksLikeProject(dir) {
  try {
    return fs.statSync(path.join(dir, 'app.json')).isFile() || fs.statSync(path.join(dir, 'app-config.json')).isFile()
  } catch { return false }
}

function findProjects(outDir, sinceMs) {
  // wedecode writes straight into outDir when -o is given explicitly,
  // so outDir itself may be the project rather than a parent of projects.
  if (looksLikeProject(outDir)) {
    try {
      const st = fs.statSync(outDir)
      const c = quickCount(outDir)
      return [{ name: path.basename(outDir), dir: outDir, files: c.files, bytes: c.bytes, mtimeMs: st.mtimeMs, mtime: st.mtime.toISOString() }]
    } catch { /* fall through to subdir scan */ }
  }
  const all = []
  let entries = []
  try { entries = fs.readdirSync(outDir, { withFileTypes: true }) } catch { return all }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const full = path.join(outDir, e.name)
    let st = null
    try { st = fs.statSync(full) } catch { continue }
    const c = quickCount(full)
    all.push({ name: e.name, dir: full, files: c.files, bytes: c.bytes, mtimeMs: st.mtimeMs, mtime: st.mtime.toISOString() })
  }
  const fresh = all.filter((p) => !sinceMs || p.mtimeMs >= sinceMs - 15000)
  return (fresh.length ? fresh : all).sort((a, b) => b.mtimeMs - a.mtimeMs)
}

const OUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string' },
    jobId: { type: 'string' },
    label: { type: 'string' },
    ok: { type: 'boolean' },
    error: { type: 'string' },
    note: { type: 'string' },
    entry: { type: 'string' },
    nodeVersion: { type: 'string' },
    exitCode: { type: 'integer' },
    timedOut: { type: 'boolean' },
    truncated: { type: 'boolean' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    durationMs: { type: 'integer' },
    outDir: { type: 'string' },
    project: { type: 'string' },
    projects: { type: 'json' },
    packages: { type: 'json' },
    total: { type: 'integer' },
    scannedRoots: { type: 'json' },
    analysis: { type: 'json' },
    markdown: { type: 'string' },
    checks: { type: 'json' },
  },
}

function text(s) { return [{ type: 'text', text: s }] }

// DSH validates tool output as LOSSLESS JSON: a key whose value is undefined
// (or NaN/Infinity) fails the round-trip check, so strip them before returning.
function clean(value) {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) {
      const v = clean(value[k])
      if (v !== undefined) out[k] = v
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined
  return value
}

function common(config, args, exec, fallbackMs) {
  return {
    cwd: (args.cwd || '').trim() || process.cwd(),
    timeoutMs: Math.min(args.timeoutMs || fallbackMs || config.defaultTimeoutMs, config.maxTimeoutMs),
    maxOutputChars: config.maxOutputChars,
    signal: exec ? exec.signal : undefined,
  }
}

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'wxapkg_status',
    description: '检查 wxapkg 反编译插件是否就绪：内置 wedecode 入口、node 版本、依赖是否装齐、微信缓存扫描路径与命中数量。用前或排障时先调用它。',
    parameters: {},
    output: { schema: OUT, render: (_a, v) => {
      const L = []
      L.push('内置 wedecode: ' + (v.entry || '(未找到)'))
      L.push('node: ' + (v.nodeVersion || '(未知)'))
      L.push('依赖自检(--help): ' + (v.ok ? 'OK' : 'FAILED') + (v.exitCode !== undefined ? ' (exit=' + v.exitCode + ')' : ''))
      if (v.error) L.push('错误: ' + v.error)
      if (v.stderr) L.push('stderr: ' + String(v.stderr).slice(0, 1500))
      if (v.checks) L.push('检查项: ' + JSON.stringify(v.checks))
      if (v.packages) L.push('缓存包命中: ' + v.total + ' 个')
      if (v.note) L.push('说明: ' + v.note)
      return text(L.join('\n'))
    } },
    async execute(_args, exec) {
      const entry = resolveEntry(config)
      const nr = nodeRuntime(config)
      const res = { entry }
      try {
        const v = String((await runProcess(nr.cmd, ['--version'], { timeoutMs: 20000, maxOutputChars: 4096, env: nr.env })).stdout).trim()
        res.nodeVersion = v + ' (' + nr.cmd + ')'
      } catch (e) { res.nodeVersion = 'error: ' + e.message + ' (' + nr.cmd + ')' }
      res.checks = { entryExists: false, vendorDir: false }
      try { res.checks.entryExists = fs.statSync(entry).isFile() } catch { res.checks.entryExists = false }
      try { res.checks.vendorDir = fs.statSync(path.dirname(entry)).isDirectory() } catch { res.checks.vendorDir = false }
      if (!res.checks.entryExists) {
        res.ok = false
        res.error = '内置 wedecode 入口不存在: ' + entry
        return clean(res)
      }
      try {
        const r = await runProcess(nr.cmd, [entry, '--help'], Object.assign(common(config, {}, exec, 60000), { maxOutputChars: 20000, env: nr.env }))
        res.ok = r.exitCode === 0
        res.exitCode = r.exitCode
        res.stdout = r.stdout
        res.stderr = r.stderr
        res.timedOut = r.timedOut
        if (!res.ok) res.error = 'wedecode --help 退出码 ' + r.exitCode + '（通常是依赖未安装：在插件目录执行 pnpm install）'
      } catch (e) {
        res.ok = false
        res.error = e.message
      }
      try {
        const sc = scanPackages({ extraRoots: extraRoots(config), max: 5 })
        res.packages = sc.packages
        res.total = sc.total
        res.scannedRoots = sc.scannedRoots
        res.note = sc.total ? '缓存中已发现小程序包，可直接 wxapkg_decompile。' : '未发现缓存包：请先在微信里打开目标小程序。默认扫描根: ' + defaultScanRoots().join(' | ')
      } catch (e) {
        res.note = '扫描失败: ' + e.message
      }
      return clean(res)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wxapkg_scan',
    description: '扫描本机微信缓存，列出可反编译的小程序包（appId、包路径、缓存目录、修改时间、大小、分包数），按最近使用倒序。manualPath 可改为扫描指定目录（比如你手工拷出来的 wxapkg）。',
    parameters: {
      manualPath: { type: 'string', description: '改为扫描这个目录（可选）；留空则用微信默认缓存路径' },
      max: { type: 'integer', description: '最多返回条数，缺省 50' },
    },
    output: { schema: OUT, render: (_a, v) => {
      if (!v.ok) return text('扫描失败: ' + (v.error || '未知错误'))
      const L = ['共命中 ' + v.total + ' 个包（显示 ' + (v.packages || []).length + '）']
      for (const p of (v.packages || [])) {
        L.push('- ' + p.appId + '  ' + (p.mtime || '') + '  ' + Math.round(p.dirBytes / 1024) + 'KB/' + p.dirFiles + '文件  分包' + p.subPackageCount)
        L.push('    包: ' + p.wxapkgPath)
        L.push('    目录: ' + p.storagePath)
      }
      if (v.scannedRoots && v.scannedRoots.length) L.push('已扫描根: ' + v.scannedRoots.slice(0, 8).join(' | '))
      return text(L.join('\n'))
    } },
    async execute(args) {
      const manual = (args.manualPath || '').trim()
      const roots = manual ? [manual] : extraRoots(config)
      const r = scanPackages({ extraRoots: roots, max: args.max || 50 })
      const out = {
        ok: true,
        packages: r.packages,
        total: r.total,
        scannedRoots: r.scannedRoots.slice(0, 40),
      }
      if (!r.total) out.note = '未发现小程序包。请先在电脑端微信里打开目标小程序以产生缓存，或用 manualPath 指定 wxapkg 所在目录。'
      return clean(out)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wxapkg_decompile',
    description: '用内置 wedecode 反编译微信小程序包。pkgPath 可为 __APP__.wxapkg 文件或其所在目录；留空则自动取微信缓存中最近使用的小程序。默认同步等待；background=true 时转后台任务（job_output 读增量，job_kill 停止），适合大包。',
    parameters: {
      pkgPath: { type: 'string', description: 'wxapkg 文件或所在目录路径；留空=自动取缓存中最近使用的包' },
      outDir: { type: 'string', description: '产物输出目录，缺省 <cwd>/OUTPUT' },
      background: { type: 'boolean', description: 'true=后台任务流式执行' },
      px: { type: 'boolean', description: '按 px 解析 css（默认 rpx）' },
      unpackOnly: { type: 'boolean', description: '只解包不反编译' },
      wxid: { type: 'string', description: '指定小程序 wxid 以获取包信息' },
      cwd: { type: 'string', description: '工作目录' },
      timeoutMs: { type: 'integer', description: '超时（毫秒）' },
    },
    output: { schema: OUT, render: (_a, v) => {
      if (v.kind === 'background') {
        return text('后台反编译已启动: ' + v.jobId + '\n输出目录: ' + v.outDir + '\n用 job_output 读增量输出（job_kill 可停止）。')
      }
      const L = ['ok=' + v.ok + (v.exitCode !== undefined ? ' exit=' + v.exitCode : '') + (v.timedOut ? ' [超时]' : '')]
      if (v.outDir) L.push('输出目录: ' + v.outDir)
      if (v.error) L.push('错误: ' + v.error)
      if (v.projects && v.projects.length) {
        L.push('产物工程 (' + v.projects.length + '):')
        for (const p of v.projects) L.push('  - ' + p.dir + '  (' + p.files + ' 文件, ' + Math.round(p.bytes / 1024) + ' KB)')
        L.push('提示: 把上面的目录传给 wxapkg_analyze 做结构分析。')
      } else if (v.ok) {
        L.push('未在输出目录发现新工程，请检查 stdout。')
      }
      if (v.durationMs) L.push('耗时: ' + Math.round(v.durationMs / 1000) + 's')
      if (v.stdout) L.push('--- stdout ---\n' + String(v.stdout).slice(-4000))
      if (v.stderr) L.push('--- stderr ---\n' + String(v.stderr).slice(-2000))
      return text(L.join('\n\n'))
    } },
    async execute(args, exec) {
      const entry = resolveEntry(config)
      const outDir = (args.outDir || '').trim() || (config.defaultOutputDir || '').trim() || path.join(process.cwd(), 'OUTPUT')
      const argv = ['--auto', '-o', outDir]
      if (args.px) argv.push('--px')
      if (args.unpackOnly) argv.push('--unpack-only')
      if (args.wxid) argv.push('--wxid', String(args.wxid))
      const pkg = (args.pkgPath || '').trim()
      if (pkg) argv.push(pkg)

      const opts = common(config, args, exec, config.defaultTimeoutMs)

      if (args.background) {
        const label = 'wxapkg: ' + (pkg ? path.basename(pkg) : 'latest-cache')
        const buf = { text: '', pos: 0 }
        const push = (s) => { buf.text = (buf.text + s).slice(-config.maxOutputChars) }
        const started = Date.now()
        const jobId = ctx.jobs.start({
          kind: 'wxapkg',
          label,
          owner: exec && exec.agent ? exec.agent : null,
          outputLimitBytes: config.maxOutputChars,
          run() {
            const nr = nodeRuntime(config)
            const done = (async () => {
              try {
                push('$ ' + nr.cmd + ' ' + entry + ' ' + argv.join(' ') + '\n')
                const r = await runProcess(nr.cmd, [entry].concat(argv), Object.assign({}, opts, { signal: undefined, onData: push, env: nr.env }))
                const projects = findProjects(outDir, started)
                if (r.exitCode === 0) return { status: 'completed', detail: '产物 ' + projects.length + ' 个工程' }
                return { status: 'failed', detail: 'exit=' + r.exitCode + ' ' + String(r.stderr).slice(-300) }
              } catch (e) {
                push('失败: ' + e.message + '\n')
                return { status: 'failed', detail: e.message }
              }
            })()
            return {
              cancel(reason) { push('停止: ' + (reason || '取消') + '\n') },
              done,
              readOutput() {
                const delta = buf.text.slice(buf.pos)
                buf.pos = buf.text.length
                return delta
              },
            }
          },
        })
        return clean({ kind: 'background', jobId, label, outDir })
      }

      const started = Date.now()
      const nr = nodeRuntime(config)
      let r
      try {
        r = await runProcess(nr.cmd, [entry].concat(argv), Object.assign({}, opts, { env: nr.env }))
      } catch (e) {
        return { ok: false, error: e.message, outDir, entry }
      }
      const durationMs = Date.now() - started
      const projects = findProjects(outDir, started)
      const ok = r.exitCode === 0
      const out = {
        ok,
        entry,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        truncated: r.truncated,
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs,
        outDir,
        projects,
      }
      if (projects.length) out.project = projects[0].dir
      if (!ok) out.error = r.timedOut ? '反编译超时（可改用 background=true 或调大 timeoutMs）' : 'wedecode 退出码 ' + r.exitCode
      if (ok && !projects.length) out.note = '命令成功但未发现产物工程，请检查 stdout。'
      return clean(out)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wxapkg_analyze',
    description: '对反编译产物做结构分析：身份/技术栈识别、路由与分包、tabBar、广告位、隐私弹窗、主题色、接口与主机提取、文件分布，并给出还原质量提示（含未被还原的空壳页面）。',
    parameters: {
      path: { type: 'string', required: true, description: '反编译产物工程目录（wxapkg_decompile 返回的 project）' },
      maxFiles: { type: 'integer', description: '最多扫描文件数，缺省 30000' },
    },
    output: { schema: OUT, render: (_a, v) => {
      if (!v.ok) return text('分析失败: ' + (v.error || '未知错误'))
      return text(v.markdown || '')
    } },
    async execute(args) {
      try {
        const a = analyzeProject((args.path || '').trim(), { maxFiles: args.maxFiles })
        return clean({ ok: true, analysis: a, markdown: renderAnalysis(a) })
      } catch (e) {
        return clean({ ok: false, error: e.message })
      }
    },
  }))

  ctx.effect(() => () => { /* nothing persistent to tear down */ })
}
