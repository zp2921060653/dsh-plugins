// dsh-vpn —— 让 DSH 拥有自己的代理内核（mihomo）与订阅管理能力的 Host 插件。
//
// 这个文件只做三件事：
//   1. 声明 Cordis 插件身份（name / inject / Config / apply）
//   2. 创建 VpnService（状态机 + 引擎 + 进程级代理接管，见 lib/host/service.mjs）
//   3. 注册 Agent 工具 `vpn`（与 HTTP API 共用同一批 service 方法）与可选 HTTP API（webServer 存在时）
//
// 安全语义：默认 disabled；apply 不会安装任何代理策略、不会阻塞；只有 enable（手动或持久化
// enabled=true 后的延迟自动启动）走完 health 门控 + 进程内 fetch 自测后才接管。

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import { VpnService } from './lib/host/service.mjs'
import { attachRoutes } from './lib/host/routes.mjs'
import { errorMessage, truncateText } from './lib/host/state.mjs'

export const name = 'dsh-vpn'

// tools 是硬依赖（注册 vpn 工具）；webServer 在 routes.mjs 里作为可选服务处理。
export const inject = ['tools']

export const Config = Schema.object({
  // 订阅地址（https）。可留空，之后通过设置页 / vpn 工具填写。
  subscriptionUrl: Schema.string().default(''),
  // 是否在 DSH 启动时自动接管（默认 false；开启后也必须先通过 health 门控）。
  enabled: Schema.boolean().default(false),
  // mihomo 出站模式：rule = 按订阅规则分流；global = 全部走当前选中节点。
  mode: Schema.union(['rule', 'global']).default('rule'),
  // 首选节点名（留空 = 用订阅默认节点）。
  preferredNode: Schema.string().default(''),
  // mixed 代理端口（0 = 自动在 18000-18999 里挑空闲端口）。
  proxyPort: Schema.number().default(0),
  // mihomo external-controller 端口（0 = 自动在 19000-19999 里挑）。
  controllerPort: Schema.number().default(0),
  // 看门狗健康检查间隔（毫秒）。
  healthIntervalMs: Schema.number().default(30000),
  // 连续失败多少次判定降级。
  failureThreshold: Schema.number().default(3),
  // 降级后每隔多久尝试恢复（毫秒）。
  retryIntervalMs: Schema.number().default(60000),
  // 健康探测 URL（HTTP 204，经代理探测）。
  probeUrl: Schema.string().default('http://www.gstatic.com/generate_204'),
  // 接管后进程内 fetch 自测 URL（https，验证 TLS 通道真的通）。
  selfTestUrl: Schema.string().default('https://www.gstatic.com/generate_204'),
  // 自测超时（毫秒）。
  selfTestTimeoutMs: Schema.number().default(10000),
  // mihomo 二进制路径（留空 = <plugin>/bin/mihomo.exe）。
  binaryPath: Schema.string().default(''),
  // 状态目录（留空 = <DSH_PROFILE_DIR>/vpn）。subscription.yaml / state.json / disable.flag 都放这里。
  dataDir: Schema.string().default(''),
  // 降级时是否安装直连策略（安全网；默认 true）。
  fallbackToDirect: Schema.boolean().default(true),
  // 插件日志级别。
  logLevel: Schema.union(['info', 'warning', 'error']).default('warning'),
  // 订阅拉取超时（毫秒）。
  fetchTimeoutMs: Schema.number().default(30000),
  // 启动后延迟多久尝试自动接管（毫秒；避免和 launcher 启动抢资源）。
  autoStartDelayMs: Schema.number().default(3000),
  // 系统代理（Windows WinINET）：接管成功后是否同时把系统代理指向插件 mixed 端口（影响浏览器等）。
  systemProxy: Schema.boolean().default(false),
  // 停用/卸载/退出时是否精确还原用户原系统代理（false 时退化为安全关闭 ProxyEnable）。
  systemProxyRestoreOnStop: Schema.boolean().default(true),
})

// ---------------------------------------------------------------------------
// 工具输出 schema / 文本渲染
// ---------------------------------------------------------------------------

const vpnOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    message: { type: 'string' },
    error: { type: 'string' },
    status: { type: 'json' },
    data: { type: 'json' },
  },
}

function formatNodeLines(result) {
  const nodes = Array.isArray(result.nodes) ? result.nodes : []
  if (nodes.length === 0) return '（没有可用节点：VPN 未运行且没有本地订阅缓存）'
  const current = result.current || null
  const lines = ['节点列表（' + nodes.length + ' 个，来源: ' + (result.source || '?') + '）:']
  for (const node of nodes.slice(0, 120)) {
    const marker = current && node.name === current ? ' ← 当前' : ''
    lines.push('  - ' + node.name + ' [' + (node.type || '?') + ']' + marker)
  }
  if (nodes.length > 120) lines.push('  …（只显示前 120 个；完整列表见 data.nodes）')
  return lines.join('\n')
}

function formatTestLines(result) {
  const nodes = Array.isArray(result.nodes) ? result.nodes : []
  if (nodes.length === 0) return '（没有可测速的节点）'
  const lines = ['测速完成: ' + (result.available ?? '?') + '/' + (result.total ?? nodes.length) + ' 个节点可用']
  const sorted = nodes.slice().sort((a, b) => {
    const av = a && a.ok && typeof a.delay === 'number' ? a.delay : Number.POSITIVE_INFINITY
    const bv = b && b.ok && typeof b.delay === 'number' ? b.delay : Number.POSITIVE_INFINITY
    return av - bv
  })
  for (const node of sorted.slice(0, 120)) {
    lines.push('  - ' + node.name + ' [' + (node.type || '?') + '] ' + (node.ok ? node.delay + ' ms' : '超时/不可用'))
  }
  if (sorted.length > 120) lines.push('  …（只显示前 120 个；完整列表见 data.nodes）')
  return lines.join('\n')
}

function renderVpn(_args, value) {
  const lines = []
  const head = value.ok ? 'vpn ' + (value.action || '') + ' 成功' : 'vpn ' + (value.action || '') + ' 失败'
  lines.push(head)
  if (value.error) lines.push('错误: ' + value.error)
  if (value.message) lines.push(value.message)
  if (value.status && typeof value.status === 'object' && value.action !== 'status' && value.action !== 'nodes') {
    lines.push(
      '当前状态: ' + String(value.status.state || value.status.status || '?') +
        (value.status.port ? '，port=' + value.status.port : '') +
        (value.status.nodeName ? '，node=' + value.status.nodeName : ''),
    )
  }
  return [{ type: 'text', text: truncateText(lines.join('\n'), 12000) }]
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

function createVpnTool(service) {
  return defineTool({
    name: 'vpn',
    description:
      '管理 DSH 自带的 VPN/代理内核（mihomo）：粘贴 Clash 订阅地址后，DSH 进程用插件自带的代理内核独立出网，' +
      '不再依赖本机 Clash Verge 等外部 VPN（本机代理死掉也不影响 DSH）。' +
      'action=status 查看状态/端口/节点/订阅摘要；enable 启动并接管进程代理（会先做健康门控 + 进程内 fetch 自测，失败自动回滚）；' +
      'disable 先恢复原始 dispatcher 再停引擎；subscription 保存并拉取订阅（需 https 地址，用 url 参数）；update 重新拉取订阅；' +
      'nodes 列出节点；select 切换节点（node 参数）；test 并发测速全部节点；mode 切换 rule/global（mode 参数）；' +
      'system-proxy 开关 Windows 系统代理（enabled=true 把系统代理指向插件 mixed 端口，让浏览器/本机其他软件也走插件代理；' +
      'enabled=false 精确还原用户原来的系统代理；不改路由/TUN、不动 Clash 配置；VPN 停用/降级/退出时自动还原）。' +
      '接管是进程级的：所有 DSH 内 fetch（含 LLM API）都会走插件自己的代理，因此 enable 后如果网络异常，用 disable 一键恢复。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'enable', 'disable', 'subscription', 'update', 'nodes', 'select', 'test', 'mode', 'system-proxy'],
        description:
          'status=查看状态；enable=启用并接管进程代理；disable=停用并恢复原始代理设置；subscription=设置订阅地址（配合 url）；' +
          'update=重新拉取订阅；nodes=列出节点；select=切换节点（配合 node）；test=测速全部节点；mode=切换规则/全局模式（配合 mode）；' +
          'system-proxy=开关 Windows 系统代理（配合 enabled，影响浏览器等读系统代理的应用）',
      },
      url: {
        type: 'string',
        description: '订阅地址（仅 action=subscription）：必须是 https:// 开头的 Clash 订阅链接',
      },
      node: {
        type: 'string',
        description: '节点名（仅 action=select），可先用 action=nodes 查看名字',
      },
      mode: {
        type: 'string',
        enum: ['rule', 'global'],
        description: '出站模式（仅 action=mode）：rule=按订阅规则分流；global=全部走当前节点',
      },
      enabled: {
        type: 'boolean',
        description:
          '仅 action=system-proxy：true=把 Windows 系统代理指向插件 mixed 端口（浏览器/Electron 等生效，不改路由/TUN）；false=精确还原用户原系统代理',
      },
    },
    output: { schema: vpnOutputSchema, render: renderVpn },
    async execute(args) {
      const action = String((args && args.action) || 'status').toLowerCase()
      try {
        if (action === 'status') {
          const status = service.status()
          return { ok: true, action, message: service.describeStatus(status), status }
        }
        if (action === 'enable') {
          const result = await service.enable({ source: 'tool' })
          const base = { action, status: result.status, data: { port: result.port ?? null, nodeName: result.nodeName ?? null, selfTestMs: result.selfTestMs ?? null } }
          if (!result.ok) return { ...base, ok: false, error: result.error, message: '启用失败，未接管进程代理：' + result.error }
          return { ...base, ok: true, message: '已启用并接管进程代理（port=' + String(result.port) + '，node=' + String(result.nodeName || '?') + '）\n' + service.describeStatus(result.status) }
        }
        if (action === 'disable') {
          const result = await service.disable()
          const base = { action, status: result.status }
          if (!result.ok) return { ...base, ok: false, error: result.error, message: '停用失败：' + result.error }
          return { ...base, ok: true, message: '已停用：进程代理已恢复为 DSH 启动时的 dispatcher，mihomo 已停止' }
        }
        if (action === 'subscription') {
          if (args && args.url) {
            const result = await service.setSubscription(args.url)
            const base = { action, status: result.status, data: { subscription: result.subscription, applied: result.applied ?? null } }
            if (!result.ok) return { ...base, ok: false, error: result.error, message: '订阅保存失败：' + result.error }
            return { ...base, ok: true, message: '订阅已保存并拉取成功\n' + service.describeStatus(result.status) }
          }
          const status = service.status()
          return {
            ok: true,
            action,
            message: '当前订阅: ' + (status.subscriptionUrl || '（未设置）') + '\n' + service.describeStatus(status) + '\n\n用 action=subscription + url 参数设置新的 Clash 订阅地址（https）。',
            status,
          }
        }
        if (action === 'update') {
          const result = await service.updateSubscription()
          const base = { action, status: result.status, data: { subscription: result.subscription, applied: result.applied ?? null } }
          if (!result.ok) return { ...base, ok: false, error: result.error, message: '订阅更新失败：' + result.error }
          return { ...base, ok: true, message: '订阅已重新拉取\n' + service.describeStatus(result.status) }
        }
        if (action === 'nodes') {
          const result = await service.listNodes()
          const base = { action, status: result.status || service.status(), data: { nodes: result.nodes, groups: result.groups, current: result.current, running: result.running, source: result.source } }
          if (result.ok === false) return { ...base, ok: false, error: result.error, message: '读取节点失败：' + result.error }
          return { ...base, ok: true, message: formatNodeLines(result) }
        }
        if (action === 'select') {
          const node = args && args.node
          if (!node) return { ok: false, action, error: '缺少 node 参数', message: '缺少 node 参数：请先 action=nodes 查看节点名', status: service.status() }
          const result = await service.selectNode(node)
          const base = { action, status: result.status, data: { node: result.node ?? node, group: result.group ?? null, applied: result.applied ?? null } }
          if (!result.ok) return { ...base, ok: false, error: result.error, message: '切换节点失败：' + result.error }
          return { ...base, ok: true, message: result.applied ? '已切换节点: ' + node + (result.group ? '（分组 ' + result.group + '）' : '') : '已记录首选节点: ' + node + '（VPN 未运行，下次启用生效）' }
        }
        if (action === 'test') {
          const result = await service.testNodes()
          const base = { action, status: result.status || service.status(), data: { nodes: result.nodes, available: result.available, total: result.total, testedAt: result.testedAt, concurrency: result.concurrency } }
          if (result.ok === false) return { ...base, ok: false, error: result.error, message: '测速失败：' + result.error }
          return { ...base, ok: true, message: formatTestLines(result) }
        }
        if (action === 'mode') {
          const mode = args && args.mode
          if (!mode) return { ok: false, action, error: '缺少 mode 参数', message: '缺少 mode 参数（rule 或 global）', status: service.status() }
          const result = await service.setMode(mode)
          const base = { action, status: result.status, data: { mode: result.mode ?? mode, applied: result.applied ?? null } }
          if (!result.ok) return { ...base, ok: false, error: result.error, message: '切换模式失败：' + result.error }
          const applied = result.applied && result.applied.applied ? '已热应用' : '已保存（VPN 未运行时下次启用生效）'
          return { ...base, ok: true, message: '模式已切换为 ' + mode + '，' + applied }
        }
        if (action === 'system-proxy') {
          if (typeof (args && args.enabled) !== 'boolean') {
            return {
              ok: false,
              action,
              error: '缺少 enabled 参数（true/false）',
              message: '缺少 enabled 参数：true=把 Windows 系统代理指向插件端口；false=还原原系统代理',
              status: service.status(),
            }
          }
          const wantEnabled = args.enabled === true
          const result = await service.setSystemProxy(wantEnabled, { source: 'tool' })
          const systemProxy = result.systemProxy ?? (result.status && result.status.systemProxy) ?? null
          const base = { action, status: result.status, data: systemProxy }
          if (!result.ok) {
            return { ...base, ok: false, error: result.error, message: '系统代理操作失败：' + result.error }
          }
          let message
          if (wantEnabled) {
            if (systemProxy && systemProxy.applied) message = '系统代理已开启：浏览器/本机软件 → ' + String(systemProxy.target || '插件端口')
            else message = '系统代理开关已标记为开启，但当前未生效' + (systemProxy && systemProxy.drift ? '（系统代理已被其他程序改动，可再次开启）' : '')
          } else {
            message = result.restored
              ? '系统代理已关闭，并已精确还原用户原来的系统代理设置'
              : '系统代理开关已关闭（当前系统代理未指向插件端口，无需还原）'
          }
          return { ...base, ok: true, message }
        }
        return { ok: false, action, error: '未知 action: ' + action, message: '未知 action: ' + action + '（可用: status/enable/disable/subscription/update/nodes/select/test/mode/system-proxy）' }
      } catch (error) {
        const message = errorMessage(error)
        try {
          service._log?.('error', 'dsh-vpn: 工具 action=' + action + ' 异常: ' + message)
        } catch {
          /* 忽略 */
        }
        return { ok: false, action, error: message, message: 'vpn ' + action + ' 异常: ' + message }
      }
    },
  })
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  let service
  try {
    service = new VpnService({ ctx, config })
  } catch (error) {
    try {
      ctx.logger?.error?.('[dsh-vpn] 初始化 VpnService 失败（插件不启用）: ' + errorMessage(error))
    } catch {
      /* 忽略 */
    }
    return
  }

  // 插件卸载：恢复到 launcher dispatcher + 停掉自己启动的 mihomo（异步，不阻塞 unload）。
  ctx.effect(() => () => {
    Promise.resolve()
      .then(() => service.shutdown())
      .catch(() => {})
  })

  // 可选 HTTP API（webServer 不存在时自动跳过）。
  try {
    attachRoutes(ctx, service)
  } catch (error) {
    try {
      service._log?.('error', 'dsh-vpn: 挂载 HTTP API 失败（Agent 工具仍可用）: ' + errorMessage(error))
    } catch {
      /* 忽略 */
    }
  }

  // Agent 工具。
  try {
    ctx.effect(() => ctx.tools.register(createVpnTool(service)))
  } catch (error) {
    try {
      service._log?.('error', 'dsh-vpn: 注册 vpn 工具失败: ' + errorMessage(error))
    } catch {
      /* 忽略 */
    }
  }

  // 进程退出兜底：系统代理必须在 DSH 退出时精确还原（同步，不依赖 async unload）。
  try {
    service.installExitGuard()
  } catch (error) {
    try {
      service._log?.('warning', 'dsh-vpn: 注册系统代理退出兜底失败（已忽略）: ' + errorMessage(error))
    } catch {
      /* 忽略 */
    }
  }

  // 持久化 enabled=true 时的延迟自动接管；kill-switch / false 时什么都不做。
  try {
    service.maybeAutoStart()
  } catch (error) {
    try {
      service._log?.('error', 'dsh-vpn: 自动启动调度失败（已忽略）: ' + errorMessage(error))
    } catch {
      /* 忽略 */
    }
  }
}
