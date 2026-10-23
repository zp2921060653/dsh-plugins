// dsh-forensics — 取证工具箱：逆向(r2/RetDec) + 抓包(tshark/mitm) + 网页(trafilatura/crawl4ai/single-file/monolith)
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { r2Info, r2Functions, r2Disasm, retdecDecompile } from './lib/adapters/rev.js'
import { tsharkCapture, tsharkRead, tsharkInterfaces, mitmStart } from './lib/adapters/net.js'
import { pageExtract, crawlPage, clonePage } from './lib/adapters/web.js'
import { killPid } from './lib/run.js'

export const name = 'forensics-bridge'
export const inject = ['tools', 'jobs']

export const Config = Schema.object({
  radare2Bin: Schema.string().default(''),
  retdecBin: Schema.string().default(''),
  tsharkBin: Schema.string().default(''),
  mitmdumpBin: Schema.string().default(''),
  trafilaturaBin: Schema.string().default(''),
  singleFileBin: Schema.string().default(''),
  monolithBin: Schema.string().default(''),
  pythonVer: Schema.string().default('3.13'),
  defaultTimeoutMs: Schema.number().default(120000),
  maxTimeoutMs: Schema.number().default(1800000),
  maxOutputChars: Schema.number().default(100000),
})

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
    engine: { type: 'string' },
    url: { type: 'string' },
    exitCode: { type: 'integer' },
    timedOut: { type: 'boolean' },
    truncated: { type: 'boolean' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    parsed: { type: 'json' },
    port: { type: 'integer' },
    outFile: { type: 'string' },
  },
}

function render(_args, value) {
  const parts = []
  if (value.kind === 'background') {
    parts.push('后台任务已启动: ' + value.jobId + '（' + value.label + '）')
    parts.push('增量输出可经 job_output 读取；job_kill 可停止。')
    return [{ type: 'text', text: parts.join('\n') }]
  }
  parts.push('ok=' + value.ok + (value.engine ? ' engine=' + value.engine : '') + (value.url ? ' url=' + value.url : ''))
  if (value.error) parts.push('错误: ' + value.error)
  if (value.note) parts.push('说明: ' + value.note)
  if (value.parsed) {
    if (value.parsed.markdown) parts.push('--- markdown ---\n' + String(value.parsed.markdown).slice(0, 20000))
    else parts.push('--- 结构化结果 ---\n' + JSON.stringify(value.parsed).slice(0, 5000))
  }
  if (value.stdout) parts.push('--- 输出 ---\n' + value.stdout + (value.truncated ? '\n[输出已截断]' : ''))
  if (value.stderr) parts.push('--- stderr ---\n' + value.stderr)
  return [{ type: 'text', text: parts.join('\n\n') }]
}

export function apply(ctx, config) {
  const state = { mitm: null }
  ctx.effect(() => () => { if (state.mitm) { killPid(state.mitm.pid); state.mitm = null } })

  const common = (args, exec) => ({
    config,
    cwd: args.cwd || process.cwd(),
    timeoutMs: Math.min(args.timeoutMs || config.defaultTimeoutMs, config.maxTimeoutMs),
    signal: exec ? exec.signal : undefined,
    maxOutputChars: config.maxOutputChars,
  })

  ctx.tools.register(defineTool({
    name: 'r2_info',
    description: 'radare2 分析二进制文件信息（架构/类型/熵/导入导出等）。返回 r2 的 iI 输出。',
    parameters: {
      binary: { type: 'string', required: true, description: '二进制文件绝对路径' },
      timeoutMs: { type: 'integer', description: '超时（毫秒）' },
    },
    output: { schema: OUT, render },
    async execute(args, exec) { return r2Info(args.binary, common(args, exec)) },
  }))

  ctx.tools.register(defineTool({
    name: 'r2_functions',
    description: 'radare2 列出二进制中的函数（r2 afl 输出：地址/大小/名称）。',
    parameters: {
      binary: { type: 'string', required: true, description: '二进制文件绝对路径' },
      timeoutMs: { type: 'integer', description: '超时（毫秒）' },
    },
    output: { schema: OUT, render },
    async execute(args, exec) { return r2Functions(args.binary, common(args, exec)) },
  }))

  ctx.tools.register(defineTool({
    name: 'r2_disasm',
    description: 'radare2 反汇编：target 为函数名（pdf @ main）或地址（pd N @ 0x140001000）。',
    parameters: {
      binary: { type: 'string', required: true, description: '二进制文件绝对路径' },
      target: { type: 'string', required: true, description: '函数名或地址，如 main 或 0x140001000' },
      count: { type: 'integer', description: '反汇编指令条数（缺省=整函数 pdf）' },
      timeoutMs: { type: 'integer', description: '超时（毫秒）' },
    },
    output: { schema: OUT, render },
    async execute(args, exec) { return r2Disasm(args.binary, args.target, args.count, common(args, exec)) },
  }))

  ctx.tools.register(defineTool({
    name: 'retdec_decompile',
    description: 'RetDec 反编译整个二进制为 C 伪代码（输出 .c 文件）。注意：RetDec v5 Windows 构建在本机可能因缺运行库崩溃，失败时请改用 ghidra_decompile。',
    parameters: {
      binary: { type: 'string', required: true, description: '二进制文件绝对路径' },
      outFile: { type: 'string', description: '输出 .c 文件路径（缺省: <binary>.c）' },
      timeoutMs: { type: 'integer', description: '超时（毫秒），反编译可能较慢' },
    },
    output: { schema: OUT, render },
    async execute(args, exec) {
      const outFile = args.outFile || args.binary + '.c'
      return retdecDecompile(args.binary, outFile, common(args, exec))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tshark_interfaces',
    description: '列出 tshark 可用的抓包网卡（-D）。实时抓包需要 Npcap 驱动。',
    parameters: {},
    output: { schema: OUT, render },
    async execute(_args, exec) { return tsharkInterfaces({ config, timeoutMs: 20000, signal: exec.signal, maxOutputChars: 20000 }) },
  }))

  ctx.tools.register(defineTool({
    name: 'tshark_capture',
    description: 'tshark 实时抓包 durationSec 秒到 outFile（pcapng）。interface 为网卡编号（先 tshark_interfaces 查看）。实时抓包需要 Npcap 驱动和管理员权限；分析已有 pcap 用 tshark_read。',
    parameters: {
      interface: { type: 'string', description: '网卡编号或名称，缺省 1' },
      durationSec: { type: 'integer', description: '抓包时长（秒），缺省 30' },
      outFile: { type: 'string', required: true, description: '输出 pcapng 文件路径' },
      timeoutMs: { type: 'integer', description: '超时（毫秒）' },
    },
    output: { schema: OUT, render },
    async execute(args, exec) { return tsharkCapture(args.interface, args.durationSec, args.outFile, common(args, exec)) },
  }))

  ctx.tools.register(defineTool({
    name: 'tshark_read',
    description: 'tshark 分析 pcap/pcapng 文件：读取数据包文本输出，可用 BPF/Wireshark 显示过滤器（-Y）。',
    parameters: {
      pcap: { type: 'string', required: true, description: 'pcap/pcapng 文件路径' },
      filter: { type: 'string', description: '显示过滤器，如 http || tcp.port==443' },
      timeoutMs: { type: 'integer', description: '超时（毫秒）' },
    },
    output: { schema: OUT, render },
    async execute(args, exec) { return tsharkRead(args.pcap, args.filter, common(args, exec)) },
  }))

  ctx.tools.register(defineTool({
    name: 'mitm_start',
    description: '启动 mitmproxy 代理录制（mitmdump，后台任务流式）：监听 127.0.0.1:<port>，HTTPS 需客户端安装并信任 mitm 证书。返回 jobId，增量日志经 job_output，job_kill 停止。',
    parameters: {
      port: { type: 'integer', description: '监听端口，缺省 8080' },
      outFile: { type: 'string', description: '录制输出文件（缺省不落盘）' },
      cwd: { type: 'string', description: '工作目录' },
    },
    output: { schema: OUT, render },
    async execute(args, exec) {
      const port = args.port || 8080
      const label = 'mitm: 127.0.0.1:' + port
      const buf = { text: '', pos: 0 }
      const push = (s) => { buf.text = (buf.text + s).slice(-config.maxOutputChars) }
      const jobId = ctx.jobs.start({
        kind: 'mitm',
        label,
        owner: exec && exec.agent ? exec.agent : null,
        outputLimitBytes: config.maxOutputChars,
        run() {
          const done = (async () => {
            try {
              const m = await mitmStart(port, args.outFile, { config, cwd: args.cwd || process.cwd(), env: undefined })
              state.mitm = { pid: m.child.pid, port: m.port, outFile: m.outFile }
              m.child.stdout.on('data', (d) => push(d.toString('utf8')))
              m.child.stderr.on('data', (d) => push(d.toString('utf8')))
              push('mitmdump 已启动，监听 127.0.0.1:' + m.port + (m.outFile ? '，录制到 ' + m.outFile : '') + '\n')
              await new Promise((resolve) => { m.child.on('close', resolve) })
              return { status: 'killed', detail: '已停止' }
            } catch (e) {
              push('失败: ' + e.message)
              return { status: 'failed', detail: e.message }
            }
          })()
          return {
            cancel(reason) {
              push('停止: ' + (reason || '取消'))
              if (state.mitm) { killPid(state.mitm.pid); state.mitm = null }
            },
            done,
            readOutput() {
              const delta = buf.text.slice(buf.pos)
              buf.pos = buf.text.length
              return delta
            },
          }
        },
      })
      return { kind: 'background', jobId, label }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'page_extract',
    description: 'trafilatura 从 URL 提取网页正文（标题/段落，markdown 输出），去广告导航。',
    parameters: {
      url: { type: 'string', required: true, description: '网页 URL' },
      timeoutMs: { type: 'integer', description: '超时（毫秒）' },
    },
    output: { schema: OUT, render },
    async execute(args, exec) { return pageExtract(args.url, common(args, exec)) },
  }))

  ctx.tools.register(defineTool({
    name: 'crawl_page',
    description: 'crawl4ai 抓取网页并转为结构化 markdown（LLM 友好，支持 JS 渲染）。首次调用可能较慢（浏览器初始化）。',
    parameters: {
      url: { type: 'string', required: true, description: '网页 URL' },
      timeoutMs: { type: 'integer', description: '超时（毫秒），缺省 120 秒' },
    },
    output: { schema: OUT, render },
    async execute(args, exec) { return crawlPage(args.url, common(args, exec)) },
  }))

  ctx.tools.register(defineTool({
    name: 'clone_page',
    description: '把网页复刻为单个 HTML 文件（single-file 优先，回退 monolith）：内联 CSS/JS/图片，离线可开。',
    parameters: {
      url: { type: 'string', required: true, description: '网页 URL' },
      outFile: { type: 'string', description: '输出 HTML 文件路径（缺省: 当前目录 <host>.html）' },
      timeoutMs: { type: 'integer', description: '超时（毫秒）' },
    },
    output: { schema: OUT, render },
    async execute(args, exec) {
      return clonePage(args.url, args.outFile, common(args, exec))
    },
  }))
}
