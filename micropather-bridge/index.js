// dsh-micropather — MicroPather (C++ A*) as a DSH tool.
//
// MicroPather is a library, not a program: there is no IPC surface to drive, so this plugin
// ships a tiny CLI built from the very same micropather.cpp and marshals the grid through it.
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'micropather-bridge'
export const inject = ['tools']

export const Config = Schema.object({
  solverBin: Schema.string().default(''),
  defaultTimeoutMs: Schema.number().default(60000),
})

function bundledBin() {
  return fileURLToPath(new URL('bin/micropather_solve.exe', import.meta.url))
}

function solverPath(config) {
  const c = (config.solverBin || '').trim()
  return c || bundledBin()
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

// start/goal accept "x,y", [x,y] or {x,y}
function parsePoint(value, label) {
  if (Array.isArray(value) && value.length >= 2) return { x: Number(value[0]), y: Number(value[1]) }
  if (value !== null && typeof value === 'object') return { x: Number(value.x), y: Number(value.y) }
  if (typeof value === 'string') {
    const parts = value.split(/[,\s]+/).filter(Boolean)
    if (parts.length >= 2) return { x: Number(parts[0]), y: Number(parts[1]) }
  }
  throw new Error(label + ' 需要 "x,y"、[x,y] 或 {x,y}')
}

// 工具输出要过 JSON 校验：undefined 不是合法 JSON，这里直接裁掉
function compact(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out
}

const OUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    cost: { type: 'number' },
    steps: { type: 'integer' },
    path: { type: 'json' },
    same: { type: 'boolean' },
    ms: { type: 'integer' },
    solver: { type: 'string' },
    note: { type: 'string' },
  },
}

function render(_a, v) {  if (!v.ok) return [{ type: 'text', text: '寻路失败: ' + (v.error || 'unknown') }]
  const head = 'ok cost=' + v.cost + ' steps=' + v.steps + (v.ms != null ? ' (' + v.ms + 'ms)' : '')
  const pts = Array.isArray(v.path) ? v.path.map((p) => '(' + p[0] + ',' + p[1] + ')').join(' ') : ''
  return [{ type: 'text', text: head + '\n' + pts }]
}

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'micropather_solve',
    description: '用 MicroPather（A*）在网格上找路。grid 是字符串数组，每个字符一格："." 可走，"#" 阻挡（也接受别的字符作为可走，# 始终是障碍）。start/goal 写 "x,y"（x=列，y=行，从 0 开始）。diagonal=true 时允许八方向（不会切角）。返回路径点序列与总代价。',
    parameters: {
      grid: {
        type: 'array',
        required: true,
        description: '网格行，例如 ["....#", "..#..", "....."]',
        items: { type: 'string' },
      },
      start: { type: 'json', required: true, description: '起点 "x,y" / [x,y] / {x,y}' },
      goal: { type: 'json', required: true, description: '终点，同上' },
      diagonal: { type: 'boolean', description: '是否允许八方向（默认 false）' },
      timeoutMs: { type: 'integer', description: '超时（毫秒）' },
    },
    output: { schema: OUT, render },
    async execute(args) {
      const solver = solverPath(config)
      const started = Date.now()
      if (!fs.existsSync(solver)) {
        return { ok: false, error: '找不到 micropather 求解器: ' + solver, solver }
      }
      const rows = Array.isArray(args.grid) ? args.grid.map((r) => String(r)) : []
      if (rows.length === 0) return { ok: false, error: 'grid 不能为空', solver }
      const w = rows[0].length
      if (w === 0) return { ok: false, error: 'grid 行不能为空', solver }
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].length !== w) return { ok: false, error: '第 ' + i + ' 行长度 ' + rows[i].length + '，与第一行 ' + w + ' 不一致', solver }
      }
      let s, g
      try {
        s = parsePoint(args.start, 'start')
        g = parsePoint(args.goal, 'goal')
      } catch (err) {
        return { ok: false, error: err.message, solver }
      }
      if (!Number.isInteger(s.x) || !Number.isInteger(s.y) || !Number.isInteger(g.x) || !Number.isInteger(g.y)) {
        return { ok: false, error: 'start/goal 必须是整数坐标', solver }
      }
      if (s.x < 0 || s.y < 0 || g.x < 0 || g.y < 0 || s.x >= w || s.y >= rows.length || g.x >= w || g.y >= rows.length) {
        return { ok: false, error: 'start/goal 超出网格范围 (' + w + 'x' + rows.length + ')', solver }
      }

      const spec = [w + ' ' + rows.length]
        .concat(rows)
        .concat([[s.x, s.y, g.x, g.y].join(' ')])
        .concat([args.diagonal ? '1' : '0'])
        .join('\n') + '\n'
      const tmp = path.join(os.tmpdir(), 'micropather-' + process.pid + '-' + Date.now() + '.txt')
      try {
        fs.writeFileSync(tmp, spec, 'utf8')
        const r = await run(solver, [tmp], { timeoutMs: args.timeoutMs || config.defaultTimeoutMs })
        const line = r.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()
        let parsed = null
        try { parsed = line ? JSON.parse(line) : null } catch { /* ignore */ }
        if (!parsed) {
          return { ok: false, error: (r.stderr || '').trim() || '求解器没有返回 JSON（退出码 ' + r.exitCode + '）', solver, ms: Date.now() - started }
        }
        return compact({
          ok: !!parsed.ok,
          error: parsed.error,
          cost: parsed.cost,
          steps: parsed.steps,
          path: parsed.path,
          same: parsed.same,
          solver,
          ms: Date.now() - started,
        })
      } finally {
        try { fs.unlinkSync(tmp) } catch { /* ignore */ }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'micropather_info',
    description: '检查 MicroPather 求解器是否就绪：二进制路径、能否跑通一个 3x3 自检。',
    parameters: {},
    output: { schema: OUT, render },
    async execute() {
      const solver = solverPath(config)
      if (!fs.existsSync(solver)) return { ok: false, error: '找不到求解器: ' + solver, solver }
      const spec = '3 3\n...\n.#.\n...\n0 0 2 2\n0\n'
      const tmp = path.join(os.tmpdir(), 'micropather-info-' + Date.now() + '.txt')
      try {
        fs.writeFileSync(tmp, spec, 'utf8')
        const r = await run(solver, [tmp], { timeoutMs: 20000 })
        const line = r.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()
        let p = null
        try { p = line ? JSON.parse(line) : null } catch { /* ignore */ }
        if (!p || !p.ok) return { ok: false, error: (p && p.error) || (r.stderr || '').trim() || '自检失败', solver }
        return { ok: true, solver, steps: p.steps, cost: p.cost, path: p.path, note: '自检通过' }
      } finally {
        try { fs.unlinkSync(tmp) } catch { /* ignore */ }
      }
    },
  }))
}
