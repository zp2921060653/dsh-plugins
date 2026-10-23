// dsh-browser — a real Chromium browser as a DSH tool surface.
//
// The Host process launches (or attaches to) a Chromium-based browser, speaks CDP
// over its DevTools WebSocket, and exposes two model-facing tools:
//   browser      — lifecycle, navigation, interaction, screenshots, JS evaluation
//   browser_read — rendered content, network responses, console, cookies, fetch
//
// Deliberately free of imports: a linked workspace bundle cannot rely on the Host's
// internal `@deepseek-ai/*` packages being resolvable, so this file carries its own
// parameter-spec → JSON-Schema conversion (what `defineTool` normally does) and its
// own config normalization.

import { BrowserManager } from './lib/browser.js'
import { runBrowserAction, runReadAction } from './lib/actions.js'

export const name = 'browser-bridge'
export const inject = ['tools']

// ---------------------------------------------------------------------------
// Tool definition helpers
// ---------------------------------------------------------------------------

/**
 * Convert one property of the DSH parameter spec into JSON Schema.
 * `required` is hoisted by {@link toJsonSchema}; `enum` is intentionally not
 * emitted — the model provider rejected enum-bearing properties, and the
 * allowed values are documented in each description instead.
 */
function convertParam(spec) {
  const source = spec && typeof spec === 'object' ? spec : {}
  const out = {}
  if (source.description != null) out.description = String(source.description)
  const type = source.type
  if (!type || type === 'json') return out
  out.type = type
  if (type === 'array') {
    const items = source.items
    if (items && typeof items === 'object') {
      if (items.type === 'object' && items.properties) {
        const nested = toJsonSchema(items.properties)
        if (items.additionalProperties != null) nested.additionalProperties = items.additionalProperties
        out.items = nested
      } else {
        out.items = convertParam(items)
      }
    } else {
      out.items = {}
    }
  } else if (type === 'object' && source.properties) {
    const nested = toJsonSchema(source.properties)
    out.properties = nested.properties
    if (nested.required) out.required = nested.required
  }
  return out
}

/** Convert a DSH parameter-spec map into the JSON Schema the model API accepts. */
function toJsonSchema(parameters) {
  const properties = {}
  const required = []
  const entries = parameters && typeof parameters === 'object' ? Object.entries(parameters) : []
  for (const [key, raw] of entries) {
    const spec = raw && typeof raw === 'object' ? { ...raw } : {}
    const isRequired = spec.required === true
    delete spec.required
    if (isRequired) required.push(key)
    properties[key] = convertParam(spec)
  }
  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return schema
}

/** Register-ready tool definition: parameters converted, nothing else added. */
function defineTool(definition) {
  return { ...definition, parameters: toJsonSchema(definition.parameters) }
}

/**
 * Tool results are validated as JSON, where `undefined` and non-finite numbers
 * are not legal values. Deep-copy the result with those removed.
 */
function lossless(value) {
  if (value === undefined) return null
  if (value === null) return null
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return value
  if (kind === 'number') return Number.isFinite(value) ? value : null
  if (kind !== 'object') return null
  if (Array.isArray(value)) return value.map(lossless)
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  const out = {}
  for (const [key, inner] of Object.entries(value)) {
    const innerKind = typeof inner
    if (inner === undefined || innerKind === 'function' || innerKind === 'symbol') continue
    out[key] = lossless(inner)
  }
  return out
}

const DEFAULTS = {
  browserPath: '',
  userDataDir: '',
  headless: false,
  cdpEndpoint: '',
  autoLaunch: true,
  reuseExisting: true,
  reuseBlank: true,
  defaultTimeoutMs: 25000,
  maxBodyBytes: 2097152,
  maxBodyTotalBytes: 50331648,
  maxRequests: 600,
  dialogBehavior: 'accept',
  downloadDir: '',
  windowSize: '1440x900',
}

/** Coerce the row's `config` into the shapes BrowserManager expects. */
function normalizeConfig(raw) {
  const config = { ...DEFAULTS }
  if (!raw || typeof raw !== 'object') return config
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) continue
    const fallback = DEFAULTS[key]
    if (typeof fallback === 'number') config[key] = Number(value) || fallback
    else if (typeof fallback === 'boolean') config[key] = value === true || value === 'true'
    else config[key] = String(value)
  }
  return config
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const TAB_DESC = '目标标签页：targetId 前缀 / URL 片段 / 序号(从1开始)；省略=当前活动标签页。'

const BROWSER_PARAMS = {
  action: {
    type: 'string',
    required: true,
    description:
      '必填，取值：status | open | goto | back | forward | reload | tabs | activate | close | click | type | press | hover | scroll | wait | eval | screenshot | viewport | selectOption | close_browser。' +
      'status=浏览器状态与标签页；open=打开URL(默认新标签)；goto=当前标签导航；back/forward/reload=历史与刷新；' +
      'tabs=列出标签页；activate=切换标签；close=关闭标签；click=点击；type=输入；press=按键；hover=悬停；scroll=滚动；' +
      'wait=等待元素/文本/URL/网络空闲/毫秒；eval=在页面执行JS并取回值；screenshot=截图存盘；viewport=设置视口；' +
      'selectOption=选择下拉项；close_browser=关闭整个浏览器。',
  },
  url: { type: 'string', description: 'open/goto/wait 使用的 URL。' },
  tab: { type: 'string', description: TAB_DESC },
  selector: { type: 'string', description: 'CSS 选择器或 XPath（// 开头）。click/type/hover/scroll/screenshot/selectOption 都可用。' },
  text: { type: 'string', description: '按可见文本定位元素（替代 selector）：click/type/hover/scroll/wait。' },
  index: { type: 'integer', description: '按 text 定位时取第几个匹配（0 开始，默认 0）。' },
  key: { type: 'string', description: 'press 的按键，如 Enter / Tab / Escape / ArrowDown / a。' },
  times: { type: 'integer', description: 'press 重复次数（默认 1）。' },
  script: { type: 'string', description: 'eval 执行的 JS 表达式或语句；返回最后一个表达式的值（支持 await）。' },
  path: { type: 'string', description: 'screenshot 输出路径（默认 <cwd>/browser-shots/shot-<时间>.png）。' },
  format: { type: 'string', description: 'screenshot 格式：png（默认）或 jpeg。' },
  quality: { type: 'integer', description: 'jpeg 质量 1-100（默认 80）。' },
  fullPage: { type: 'boolean', description: 'screenshot 截整页（含滚动区域）。' },
  force: { type: 'boolean', description: 'click 时用 DOM click() 而不是真实鼠标事件（可绕过遮挡层）。' },
  double: { type: 'boolean', description: 'click 双击。' },
  button: { type: 'string', description: 'click 鼠标键：left（默认）/ right / middle。' },
  submit: { type: 'boolean', description: 'type 之后按 Enter。' },
  clear: { type: 'boolean', description: 'type 前清空输入框（默认 true）。' },
  delay: { type: 'integer', description: 'type 逐字输入间隔毫秒（默认一次写入）。' },
  dy: { type: 'integer', description: 'scroll 纵向像素，正数向下（默认 600）。' },
  dx: { type: 'integer', description: 'scroll 横向像素。' },
  to: { type: 'string', description: 'scroll 目标：top 或 bottom。' },
  ms: { type: 'integer', description: 'wait 固定等待毫秒。' },
  width: { type: 'integer', description: 'viewport 宽度。' },
  height: { type: 'integer', description: 'viewport 高度。' },
  scale: { type: 'number', description: 'viewport 设备像素比。' },
  mobile: { type: 'boolean', description: 'viewport 模拟移动端。' },
  values: { type: 'json', description: 'selectOption 要选中的 value 或文本数组。' },
  waitUntil: { type: 'string', description: '导航后等待的时机：load（默认）/ domcontentloaded / networkidle。' },
  noCache: { type: 'boolean', description: 'reload 时忽略缓存。' },
  settleMs: { type: 'integer', description: '动作后额外等待毫秒。' },
  timeoutMs: { type: 'integer', description: '本次动作超时毫秒。' },
}

const READ_PARAMS = {
  action: {
    type: 'string',
    required: true,
    description:
      '必填，取值：read | network | console | cookies | storage | fetch。' +
      'read=读取页面渲染后的内容；network=页面发出的请求与响应体；console=控制台日志；' +
      'cookies=读取/写入/清空 cookie；storage=localStorage/sessionStorage；fetch=在页面内发请求(带登录态)。',
  },
  mode: {
    type: 'string',
    description:
      'read 的模式：main（默认，正文区域转 Markdown）/ markdown（整页 Markdown）/ text（纯文本）/ html（HTML 源码）/ ' +
      'link（所有链接）/ meta（标题/描述/OG）/ interactive（可点击元素清单，带 selector）/ ax（无障碍树）。',
  },
  selector: { type: 'string', description: '只读取该 CSS/XPath 元素的内容。' },
  maxChars: { type: 'integer', description: '返回内容上限字符（默认 read 12000 / network-body 40000）。' },
  limit: { type: 'integer', description: 'network/console/interactive/ax 的最大条数。' },
  filter: { type: 'string', description: 'network/console 的 URL 或文本子串过滤。' },
  type: { type: 'string', description: 'network 按资源类型过滤：xhr / fetch / document / script / image / all。' },
  status: { type: 'integer', description: 'network 按 HTTP 状态码过滤。' },
  id: { type: 'string', description: 'network 取某个请求的响应体（network 列表里给出的 id，支持前缀）。' },
  level: { type: 'string', description: 'console 按级别过滤：error / warning / log / info / debug / dialog。' },
  clear: { type: 'boolean', description: 'network/console 读取后清空缓冲。' },
  op: { type: 'string', description: 'cookies/storage 的操作：get（默认）/ set / clear。' },
  key: { type: 'string', description: 'storage 的键；省略则列出全部。' },
  value: { type: 'json', description: 'storage set 的值（对象会被 JSON 序列化）。' },
  store: { type: 'string', description: 'storage 区域：local（默认）或 session。' },
  cookies: { type: 'json', description: 'cookies set 时的数组：{name,value,domain|url,path,httpOnly,secure}。' },
  url: { type: 'string', description: 'cookies 作用域 / fetch 目标 URL（相对路径按当前页面解析）。' },
  method: { type: 'string', description: 'fetch 的 HTTP 方法（默认 GET）。' },
  headers: { type: 'json', description: 'fetch 的请求头对象。' },
  body: { type: 'json', description: 'fetch 的请求体（对象会被 JSON 序列化）。' },
  credentials: { type: 'string', description: 'fetch 是否携带 cookie：include（默认）/ same-origin / omit。' },
  tab: { type: 'string', description: TAB_DESC },
}

const OUT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    text: { type: 'string' },
  },
}

const BROWSER_DESCRIPTION =
  '用真实 Chromium 浏览器操作网页（CDP 驱动，不是无头 HTML 抓取）。' +
  '典型流程：open 打开页面 → browser_read.read 读渲染后的正文（比截图省很多 token）→ click/type 交互 → ' +
  'browser_read.network 直接读接口 JSON 响应。' +
  '优先用 selector 或 text 定位元素；先 browser_read.read 的 mode=interactive 可拿到带 selector 的可点击元素清单。' +
  '截图只在需要看视觉布局时用，返回的是已存盘的图片路径。' +
  '浏览器首次调用时自动启动，之后保持运行，登录态保存在持久化 profile 里。'

const READ_DESCRIPTION =
  '读取浏览器里已经发生的事实：页面渲染后的内容（Markdown/纯文本/可交互元素/无障碍树）、' +
  '页面发出的网络请求与响应体（包括 XHR/fetch 的 JSON）、控制台日志、cookie 与 storage，' +
  '以及在页面上下文里发请求（自动携带登录态）。' +
  '判断页面数据时优先用它，而不是截图猜。'

function renderBrowser(_args, value) {
  if (!value || typeof value !== 'object') return [{ type: 'text', text: String(value) }]
  if (value.ok === false) return [{ type: 'text', text: '浏览器操作失败: ' + (value.error || 'unknown') }]
  const text = typeof value.text === 'string' ? value.text : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

function renderRead(_args, value) {
  if (!value || typeof value !== 'object') return [{ type: 'text', text: String(value) }]
  if (value.ok === false) return [{ type: 'text', text: '读取失败: ' + (value.error || 'unknown') }]
  const head = value.mode
    ? `[${value.mode}] ${value.title || ''}${value.title ? ' — ' : ''}${value.url || ''}${value.chars != null ? ' · ' + value.chars + ' 字符' : ''}\n`
    : ''
  const body = typeof value.text === 'string' ? value.text : JSON.stringify(value, null, 2)
  return [{ type: 'text', text: head + body }]
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const manager = new BrowserManager(normalizeConfig(config))

  ctx.effect(() => () => {
    try { manager.dispose() } catch { /* ignore */ }
  })

  function cwdFor(exec) {
    try {
      const wd = ctx.get('workingDirectory')
      if (wd && exec && exec.agent && exec.agent.session) {
        const dir = wd.get(exec.agent.session)
        if (dir) return dir
      }
    } catch { /* optional service */ }
    return process.cwd()
  }

  ctx.tools.register(defineTool({
    name: 'browser',
    description: BROWSER_DESCRIPTION,
    parameters: BROWSER_PARAMS,
    output: { schema: OUT, render: renderBrowser },
    async execute(args, exec) {
      const context = { manager, cwd: cwdFor(exec) }
      try {
        return lossless(await runBrowserAction(String((args && args.action) || 'status'), args || {}, context))
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_read',
    description: READ_DESCRIPTION,
    parameters: READ_PARAMS,
    output: { schema: OUT, render: renderRead },
    async execute(args, exec) {
      const context = { manager, cwd: cwdFor(exec) }
      try {
        return lossless(await runReadAction(String((args && args.action) || 'read'), args || {}, context))
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) }
      }
    },
  }))
}
