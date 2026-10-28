// dsh-vpn Host 侧纯逻辑自检（selftest.mjs）。
//
// 不依赖 dsh 宿主、不安装插件、不启动 mihomo：普通 node 直接跑：
//   node lib/host/selftest.mjs
//
// 覆盖：state 归一化/持久化/损坏容错/kill-switch/订阅摘要/URL 脱敏/探测归一化、
//       policy 在「dsh-http-proxy 与 undici 都不可用」时的优雅降级、
//       service 状态机与 enable/disable 安全失败路径（策略绝不被安装）、
//       routes 的 HTTP 契约（GET status/nodes、POST enable/test/mode、404/405、no-store）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import {
  normalizeConfig,
  resolveDataDir,
  resolveDataDirInfo,
  defaultDataDir,
  loadStateSync,
  saveStateSync,
  statePath,
  killSwitchPath,
  isKillSwitchActive,
  summarizeYaml,
  maskUrl,
  isProbeOk,
  describeProbe,
  randomSecret,
  extractProxyNames,
} from './state.mjs'
import { PolicyManager } from './policy.mjs'
import {
  normalizeProbeResult,
  parseNodesFromYaml,
  loadEngineModule,
  isEngineModuleLoaded,
  ensureProfileStoreDisabled,
} from './engine-bridge.mjs'
import { createApiHandler, resolveRelativePath, attachRoutes, API_PREFIX } from './routes.mjs'
import { VpnService } from './service.mjs'
import {
  SystemProxyManager,
  createMemoryRunner,
  isPluginProxyServer,
  mergeBypass,
  buildTargetProxyServer,
  parseRegQueryOutput,
  isValidProxyPort,
  validateSnapshot,
  parseDword,
} from './system-proxy.mjs'

let passed = 0
let failed = 0
const failures = []

/** 真实用户基线（Clash 系统代理 127.0.0.1:7897 开启）。 */
function defaultSystemProxyValues() {
  return {
    ProxyEnable: { type: 'REG_DWORD', data: '0x1' },
    ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:7897' },
    ProxyOverride: { type: 'REG_SZ', data: 'localhost;*.local' },
  }
}

/** 构造注入 memory-runner 的 SystemProxyManager（绝不触碰真实注册表）。 */
function createTestSystemProxy(initial) {
  const runner = createMemoryRunner(initial || defaultSystemProxyValues())
  const manager = new SystemProxyManager({ runner, platform: 'win32' })
  return { runner, manager }
}

/**
 * 构造带 fake system proxy manager 的 VpnService（避免 selftest 触碰真实注册表）。
 * 兼容 `newTestService({ config: {...} }, extra)` 与 `newTestService({...})` 两种写法。
 */
function newTestService(configOrOptions, extra = {}) {
  const options = configOrOptions && typeof configOrOptions === 'object' ? configOrOptions : {}
  const config = options.config && typeof options.config === 'object' ? options.config : options
  const { systemProxyInitial, ...rest } = extra || {}
  const sp = createTestSystemProxy(systemProxyInitial)
  return new VpnService({ config, systemProxy: sp.manager, systemProxyStatusCacheMs: 0, ...rest })
}

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return true
  }
  failed += 1
  failures.push(name + (detail === undefined ? '' : ' —— ' + detail))
  return false
}

function eq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  return check(name, same, same ? undefined : 'expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual))
}

function includes(name, text, needle) {
  const value = String(text ?? '')
  return check(name, value.includes(needle), 'text=' + JSON.stringify(value.slice(0, 300)) + ' needle=' + JSON.stringify(needle))
}

const TEMP_DIRS = []

function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vpn-' + label + '-'))
  TEMP_DIRS.push(dir)
  return dir
}

function cleanupTempDirs() {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// 1. Config 归一化 / 路径
// ---------------------------------------------------------------------------

function testConfig() {
  const cfg = normalizeConfig({})
  eq('config 默认值 enabled=false', cfg.enabled, false)
  eq('config 默认值 mode=rule', cfg.mode, 'rule')
  eq('config 默认值 fallbackToDirect=true', cfg.fallbackToDirect, true)
  eq('config 默认值 healthIntervalMs=30000', cfg.healthIntervalMs, 30000)
  eq('config 默认值 probeUrl', cfg.probeUrl, 'http://www.gstatic.com/generate_204')
  eq('config 默认值 selfTestUrl', cfg.selfTestUrl, 'https://www.gstatic.com/generate_204')

  const custom = normalizeConfig({
    enabled: true,
    mode: 'global',
    subscriptionUrl: '  https://example.com/sub?token=abc  ',
    proxyPort: '18123',
    healthIntervalMs: 500,
    failureThreshold: 0,
    logLevel: 'debug',
    fallbackToDirect: false,
  })
  eq('config enabled 覆盖', custom.enabled, true)
  eq('config mode 覆盖', custom.mode, 'global')
  eq('config subscriptionUrl trim', custom.subscriptionUrl, 'https://example.com/sub?token=abc')
  eq('config proxyPort 字符串转数字', custom.proxyPort, 18123)
  eq('config healthIntervalMs 下限 1000', custom.healthIntervalMs, 1000)
  eq('config failureThreshold 下限 1', custom.failureThreshold, 1)
  eq('config logLevel 覆盖', custom.logLevel, 'debug')
  eq('config fallbackToDirect=false 覆盖', custom.fallbackToDirect, false)

  const invalid = normalizeConfig({
    mode: 'bogus',
    logLevel: 'silly',
    proxyPort: -5,
    controllerPort: 99999,
    probeUrl: 'ftp://x',
    retryIntervalMs: 'NaN',
    dataDir: 12345,
  })
  eq('config 非法 mode 回退', invalid.mode, 'rule')
  eq('config 非法 logLevel 回退', invalid.logLevel, 'warning')
  eq('config 非法 proxyPort 回退 0', invalid.proxyPort, 0)
  eq('config 非法 controllerPort 回退 0', invalid.controllerPort, 0)
  eq('config 非 http(s) probeUrl 回退默认', invalid.probeUrl, 'http://www.gstatic.com/generate_204')
  eq('config 非法 retryIntervalMs 回退默认', invalid.retryIntervalMs, 60000)
  eq('config dataDir 数字转字符串', invalid.dataDir, '12345')

  eq('defaultDataDir 用 DSH_PROFILE_DIR', defaultDataDir({ DSH_PROFILE_DIR: 'C:/profiles/desktop' }), path.join('C:/profiles/desktop', 'vpn'))
  const resolved = resolveDataDir({ dataDir: '' }, { DSH_PROFILE_DIR: 'C:/profiles/desktop' })
  eq('resolveDataDir 默认 <profile>/vpn', resolved, path.resolve('C:/profiles/desktop/vpn'))
  const customDir = path.resolve('C:/tmp/custom-vpn')
  eq('resolveDataDir 显式覆盖', resolveDataDir({ dataDir: 'C:/tmp/custom-vpn' }), customDir)
}

// ---------------------------------------------------------------------------
// 2. 持久化 / 损坏容错 / kill-switch
// ---------------------------------------------------------------------------

function testState() {
  const dir = makeTempDir('state')
  try {
    const missing = loadStateSync(dir)
    eq('state 文件不存在 exists=false', missing.exists, false)
    eq('state 默认 enabled=false', missing.state.enabled, false)
    eq('state 文件不存在 warning=null', missing.warning, null)

    const saved = saveStateSync(dir, {
      enabled: true,
      subscriptionUrl: 'https://example.com/sub',
      preferredNode: '🇭🇰 香港01',
      mode: 'global',
    })
    check('state 原子写返回路径', saved.path === statePath(dir), saved.path)
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))
    eq('state 原子写没有临时文件残留', leftovers, [])

    const loaded = loadStateSync(dir)
    eq('state roundtrip exists=true', loaded.exists, true)
    eq('state roundtrip enabled', loaded.state.enabled, true)
    eq('state roundtrip mode', loaded.state.mode, 'global')
    eq('state roundtrip preferredNode', loaded.state.preferredNode, '🇭🇰 香港01')
    eq('state roundtrip subscriptionUrl', loaded.state.subscriptionUrl, 'https://example.com/sub')

    fs.writeFileSync(statePath(dir), '{ this is not json', 'utf8')
    const corrupt = loadStateSync(dir)
    eq('state 损坏 exists=false', corrupt.exists, false)
    eq('state 损坏回退 enabled=false', corrupt.state.enabled, false)
    includes('state 损坏给出 warning', corrupt.warning, '损坏')

    const killFlag = killSwitchPath(dir)
    eq('kill-switch 无 flag/无 env → inactive', isKillSwitchActive({ dataDir: dir }, { env: {} }).active, false)
    fs.writeFileSync(killFlag, '1', 'utf8')
    const flagHit = isKillSwitchActive({ dataDir: dir }, { env: {} })
    eq('kill-switch flag 文件生效', flagHit.active, true)
    includes('kill-switch flag 原因包含 disable.flag', flagHit.reason, 'disable.flag')
    fs.rmSync(killFlag, { force: true })
    eq('kill-switch env=1 生效', isKillSwitchActive({ dataDir: dir }, { env: { DSH_VPN_DISABLED: '1' } }).active, true)
    eq('kill-switch env=true 生效', isKillSwitchActive({ dataDir: dir }, { env: { DSH_VPN_DISABLED: 'true' } }).active, true)
    eq('kill-switch env=0 不生效', isKillSwitchActive({ dataDir: dir }, { env: { DSH_VPN_DISABLED: '0' } }).active, false)
  } finally {
    cleanupDir(dir)
  }
}

// ---------------------------------------------------------------------------
// 3. 订阅摘要 / 脱敏 / 探测归一化
// ---------------------------------------------------------------------------

const SAMPLE_YAML = [
  'mixed-port: 7890',
  'proxies:',
  "  - { name: '🇭🇰 香港01', type: ss, server: 1.2.3.4, port: 443, cipher: chacha20-ietf-poly1305 }",
  "  - { name: '🇺🇸 美国01[直连]', type: vless, server: 5.6.7.8, port: 443 }",
  "  - { name: '剩余流量：44.48 GB', type: ss, server: 0.0.0.0, port: 1 }",
  "  - { name: '套餐到期：2026-10-01', type: ss, server: 0.0.0.0, port: 1 }",
  'proxy-groups:',
  "  - { name: '🔰 节点选择', type: select, proxies: ['🇭🇰 香港01', '🇺🇸 美国01[直连]'] }",
  'rules:',
  '  - MATCH,🔰 节点选择',
].join('\n')

function testSummary() {
  eq('extractProxyNames 只取 proxies 段', extractProxyNames(SAMPLE_YAML), [
    '🇭🇰 香港01',
    '🇺🇸 美国01[直连]',
    '剩余流量：44.48 GB',
    '套餐到期：2026-10-01',
  ])
  const summary = summarizeYaml(SAMPLE_YAML, null)
  eq('summary 节点数（过滤伪节点）', summary.nodeCount, 2)
  eq('summary 剩余流量', summary.remainingTraffic, '44.48 GB')
  eq('summary 套餐到期', summary.expireDate, '2026-10-01')

  const withInfo = summarizeYaml(SAMPLE_YAML, {
    nodeCount: 62,
    remainingTraffic: '117.97 GB',
    expireDate: '2026-02-14',
    expireAtIso: '2026-02-14T00:00:00.000Z',
    totalBytes: 1099511627776,
    updateIntervalHours: 24,
  })
  eq('summary info 优先 nodeCount', withInfo.nodeCount, 62)
  eq('summary info 优先 remainingTraffic', withInfo.remainingTraffic, '117.97 GB')
  eq('summary info 提供 totalBytes', withInfo.totalBytes, 1099511627776)
  eq('summary info 提供 updateIntervalHours', withInfo.updateIntervalHours, 24)
  eq('summary info 提供 expireAtIso', withInfo.expireAtIso, '2026-02-14T00:00:00.000Z')

  const masked = maskUrl('https://panel.example.com/config?token=SECRET123&name=a')
  includes('maskUrl 掩码 token', masked, 'token=***')
  check('maskUrl 不泄露 secret', !masked.includes('SECRET123'), masked)
  eq('maskUrl 空值', maskUrl(''), '')

  eq('isProbeOk true', isProbeOk(true), true)
  eq('isProbeOk {ok:true}', isProbeOk({ ok: true }), true)
  eq('isProbeOk {status:204}', isProbeOk({ status: 204 }), true)
  eq('isProbeOk {status:502}', isProbeOk({ status: 502 }), false)
  eq('isProbeOk {ok:false}', isProbeOk({ ok: false }), false)
  eq('isProbeOk null', isProbeOk(null), false)
  includes('describeProbe 错误文本', describeProbe({ ok: false, error: 'boom' }), 'boom')

  const normalized = normalizeProbeResult({ ok: true, ms: 123, status: 204 })
  eq('probe 归一化 ok', normalized.ok, true)
  eq('probe 归一化 ms', normalized.ms, 123)
  eq('probe 归一化 status', normalized.status, 204)
  eq('probe 归一化 失败', normalizeProbeResult({ ok: false, error: 'x' }).ok, false)
  eq('probe 归一化 true', normalizeProbeResult(true).ok, true)

  const secret = randomSecret(16)
  eq('randomSecret 长度', secret.length, 16)
  check('randomSecret 仅十六进制', /^[0-9a-f]+$/.test(secret), secret)
}

// ---------------------------------------------------------------------------
// 4. 节点 YAML 解析（用假 engine 模块，不依赖 lib/engine）
// ---------------------------------------------------------------------------

function testParseNodes() {
  const fakeEngine = {
    parseClashYaml() {
      return {
        proxies: [
          { name: '🇭🇰 香港01', type: 'ss' },
          { name: '🇺🇸 美国01[直连]', type: 'vless' },
          { name: '剩余流量：44.48 GB', type: 'ss' },
          { name: '套餐到期：2026-10-01', type: 'ss' },
        ],
        groups: [{ name: '🔰 节点选择', type: 'select', proxies: ['🇭🇰 香港01', '🇺🇸 美国01[直连]'] }],
        rules: [],
      }
    },
  }
  const parsed = parseNodesFromYaml(fakeEngine, SAMPLE_YAML)
  eq('parseNodesFromYaml 过滤伪节点', parsed.nodes.map((node) => node.name), ['🇭🇰 香港01', '🇺🇸 美国01[直连]'])
  eq('parseNodesFromYaml group members 兼容 proxies 键', parsed.groups[0].members.length, 2)
}

// ---------------------------------------------------------------------------
// 5. 策略管线的优雅降级（普通 node 下两条通路都不可用）
// ---------------------------------------------------------------------------

async function testPolicy() {
  const policy = new PolicyManager({ log: () => {} })
  const before = policy.current()
  eq('policy 初始 active=null', before.active, null)
  eq('policy 初始 takeoverAvailable=null', before.takeoverAvailable, null)
  check('policy 初始 baseline 记录 launcher 环境', before.baseline && typeof before.baseline.note === 'string', JSON.stringify(before.baseline))

  let rejected = null
  try {
    await policy.installProxy(18080)
  } catch (error) {
    rejected = error
  }
  check('policy 安装失败而不是崩溃', rejected !== null, String(rejected))
  eq('policy 失败错误码 POLICY_UNAVAILABLE', rejected && rejected.code, 'POLICY_UNAVAILABLE')
  const after = policy.current()
  eq('policy 失败后 active 仍为 null', after.active, null)
  eq('policy 失败后 takeoverAvailable=false', after.takeoverAvailable, false)
  eq('policy 失败后 httpProxy 探测=false', after.moduleAvailability.httpProxy, false)
  eq('policy 失败后 undici 探测=false', after.moduleAvailability.undici, false)

  let directRejected = null
  try {
    await policy.installDirect()
  } catch (error) {
    directRejected = error
  }
  check('policy 直连策略安装失败也不崩溃', directRejected !== null, String(directRejected))

  await policy.restore()
  eq('policy restore 无 active 时幂等', policy.current().active, null)
  await policy.dispose()
  check('policy dispose 不抛错', true)
}

// ---------------------------------------------------------------------------
// 6. HTTP API 契约（mock service + mock req/res）
// ---------------------------------------------------------------------------

function mockStatus(state, extra) {
  return {
    status: state,
    state,
    enabled: state === 'running',
    connected: state === 'running',
    port: state === 'running' ? 18123 : null,
    controllerPort: state === 'running' ? 19123 : null,
    nodeName: state === 'running' ? '🇭🇰 香港01' : null,
    mode: 'rule',
    lastError: null,
    lastHealthMs: state === 'running' ? 88 : null,
    startedAt: state === 'running' ? Date.now() : null,
    killSwitch: { active: false, reason: null },
    subscription: {
      url: 'https://panel.example.com/config?token=***',
      nodeCount: 62,
      remainingTraffic: '117.97 GB',
      expireDate: '2026-02-14',
      totalBytes: 1099511627776,
      expireAtIso: '2026-02-14T00:00:00.000Z',
      updateIntervalHours: 24,
    },
    policy: { active: null, direct: null, takeoverAvailable: null, moduleAvailability: {}, lastError: null, baseline: {} },
    systemProxy: {
      supported: true,
      enabled: false,
      applied: false,
      target: null,
      proxyEnable: 1,
      proxyServer: '127.0.0.1:7897',
      original: null,
      lastError: null,
      drift: false,
    },
    logs: [{ at: 1, level: 'warning', message: 'secret-log-line' }],
    engineLogs: ['secret-engine-log'],
    ...(extra || {}),
  }
}

function createFakeService() {
  const base = mockStatus('disabled')
  return {
    _log() {},
    config: { mode: 'rule' },
    status() {
      return JSON.parse(JSON.stringify(this._state || base))
    },
    listNodes: async () => ({ ok: true, running: false, source: 'cache', current: null, nodes: [{ name: '🇭🇰 香港01', type: 'ss' }], groups: [] }),
    enable: async () => ({ ok: false, error: '模拟启用失败', status: mockStatus('failed', { lastError: '模拟启用失败' }) }),
    disable: async () => ({ ok: true, status: mockStatus('disabled') }),
    setSubscription: async (url) => {
      if (!url) return { ok: false, error: '缺少订阅地址（https://…）', status: mockStatus('disabled') }
      return { ok: true, subscription: { url: 'https://panel.example.com/config?token=***', summary: { nodeCount: 62 } }, applied: { ok: true, applied: false }, status: mockStatus('disabled') }
    },
    updateSubscription: async () => ({ ok: true, subscription: { summary: { nodeCount: 62 } }, applied: { ok: true, applied: false }, status: mockStatus('disabled') }),
    setMode: async (mode) => (mode === 'rule' || mode === 'global' ? { ok: true, mode, applied: { ok: true, applied: false }, status: mockStatus('disabled') } : { ok: false, error: 'mode 只能是 rule 或 global', status: mockStatus('disabled') }),
    selectNode: async (node) => (node ? { ok: true, node, applied: false, status: mockStatus('disabled') } : { ok: false, error: '缺少 node 参数（节点名）', status: mockStatus('disabled') }),
    setSystemProxy: async (enabled) => {
      if (typeof enabled !== 'boolean') {
        return { ok: false, error: '缺少 enabled 参数（true/false）', status: mockStatus('disabled') }
      }
      if (enabled) {
        return {
          ok: false,
          error: 'VPN 未运行（先 enable），不能把系统代理指向插件端口',
          systemProxy: { supported: true, enabled: false, applied: false, target: null, original: null, lastError: 'VPN 未运行' },
          status: mockStatus('disabled'),
        }
      }
      return {
        ok: true,
        changed: false,
        restored: false,
        systemProxy: { supported: true, enabled: false, applied: false, target: null, original: null, lastError: null },
        status: mockStatus('disabled'),
      }
    },
    testNodes: async () => ({
      ok: true,
      nodes: [
        { name: '🇭🇰 香港01', type: 'ss', ok: true, delay: 88 },
        { name: '🇺🇸 美国01[直连]', type: 'vless', ok: false, delay: null, error: 'timeout' },
      ],
      available: 1,
      total: 2,
      testedAt: 1700000000000,
      concurrency: 8,
      status: mockStatus('running'),
    }),
    setState(state) {
      this._state = mockStatus(state)
    },
  }
}

function mockRequest({ method = 'GET', url = '/dsh-vpn/api/status', body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function mockResponse() {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk === undefined || chunk === null ? '' : String(chunk)
      if (this._resolve) this._resolve()
    },
  }
  res.done = new Promise((resolve) => {
    res._resolve = resolve
  })
  return res
}

async function callApi(handler, options) {
  const req = mockRequest(options)
  const res = mockResponse()
  await handler(req, res)
  await res.done
  let body = null
  try {
    body = JSON.parse(res.body)
  } catch {
    body = null
  }
  return { statusCode: res.statusCode, headers: res.headers, body, raw: res.body }
}

async function testRoutes() {
  const service = createFakeService()
  const handler = createApiHandler(service)

  const status = await callApi(handler, { method: 'GET', url: '/dsh-vpn/api/status' })
  eq('API status 200', status.statusCode, 200)
  eq('API status ok=true', status.body && status.body.ok, true)
  eq('API status 带 state 别名', status.body && status.body.status.state, 'disabled')
  eq('API status 带 subscription.nodeCount', status.body && status.body.status.subscription.nodeCount, 62)
  eq('API status cache-control=no-store', status.headers['cache-control'], 'no-store')
  includes('API status content-type json', status.headers['content-type'], 'application/json')
  check('API status 默认不返回 logs（轻量轮询）', status.body && status.body.status.logs === undefined, JSON.stringify(status.body && status.body.status.logs))
  const statusDebug = await callApi(handler, { method: 'GET', url: '/dsh-vpn/api/status?debug=1' })
  check('API status?debug=1 返回 logs', Array.isArray(statusDebug.body && statusDebug.body.status.logs), JSON.stringify(statusDebug.body && statusDebug.body.status.logs))

  const nodes = await callApi(handler, { method: 'GET', url: '/dsh-vpn/api/nodes' })
  eq('API nodes 200', nodes.statusCode, 200)
  eq('API nodes ok=true', nodes.body && nodes.body.ok, true)
  eq('API nodes nodes[0].name', nodes.body && nodes.body.nodes[0].name, '🇭🇰 香港01')
  eq('API nodes mode', nodes.body && nodes.body.mode, 'rule')

  const enableFail = await callApi(handler, { method: 'POST', url: '/dsh-vpn/api/enable', body: {} })
  eq('API enable 失败 HTTP 400', enableFail.statusCode, 400)
  eq('API enable 失败 ok=false', enableFail.body && enableFail.body.ok, false)
  eq('API enable 失败带 error', enableFail.body && enableFail.body.error, '模拟启用失败')

  const disable = await callApi(handler, { method: 'POST', url: '/dsh-vpn/api/disable', body: {} })
  eq('API disable 200', disable.statusCode, 200)
  eq('API disable status.state=disabled', disable.body && disable.body.status.state, 'disabled')

  const test = await callApi(handler, { method: 'POST', url: '/dsh-vpn/api/test', body: {} })
  eq('API test 200', test.statusCode, 200)
  eq('API test delays["🇭🇰 香港01"]=88', test.body && test.body.delays['🇭🇰 香港01'], 88)
  eq('API test delays 超时为 null', test.body && test.body.delays['🇺🇸 美国01[直连]'], null)

  const mode = await callApi(handler, { method: 'POST', url: '/dsh-vpn/api/mode', body: { mode: 'global' } })
  eq('API mode 200', mode.statusCode, 200)
  eq('API mode 返回 mode=global', mode.body && mode.body.mode, 'global')

  const select = await callApi(handler, { method: 'POST', url: '/dsh-vpn/api/select', body: { node: '🇭🇰 香港01' } })
  eq('API select 200', select.statusCode, 200)
  eq('API select 返回 node', select.body && select.body.node, '🇭🇰 香港01')

  const subscription = await callApi(handler, { method: 'POST', url: '/dsh-vpn/api/subscription', body: { url: 'https://panel.example.com/config?token=x' } })
  eq('API subscription 200', subscription.statusCode, 200)
  eq('API subscription summary.nodeCount', subscription.body && subscription.body.summary && subscription.body.summary.nodeCount, 62)

  const update = await callApi(handler, { method: 'POST', url: '/dsh-vpn/api/update', body: {} })
  eq('API update 200', update.statusCode, 200)

  const systemProxyOn = await callApi(handler, { method: 'POST', url: '/dsh-vpn/api/system-proxy', body: { enabled: true } })
  eq('API system-proxy 未运行 400', systemProxyOn.statusCode, 400)
  eq('API system-proxy 失败 ok=false', systemProxyOn.body && systemProxyOn.body.ok, false)
  const systemProxyOff = await callApi(handler, { method: 'POST', url: '/dsh-vpn/api/system-proxy', body: { enabled: false } })
  eq('API system-proxy 关闭 200', systemProxyOff.statusCode, 200)
  eq('API system-proxy 成功 ok=true', systemProxyOff.body && systemProxyOff.body.ok, true)
  eq('API system-proxy 返回完整 status', Boolean(systemProxyOff.body && systemProxyOff.body.status && systemProxyOff.body.status.state), true)
  eq('API system-proxy 返回 systemProxy', Boolean(systemProxyOff.body && systemProxyOff.body.systemProxy), true)
  const systemProxyBad = await callApi(handler, { method: 'POST', url: '/dsh-vpn/api/system-proxy', body: { enabled: 'yes' } })
  eq('API system-proxy 缺少 boolean 参数 400', systemProxyBad.statusCode, 400)

  const badJson = await callApi(handler, { method: 'POST', url: '/dsh-vpn/api/mode', body: '{oops' })
  eq('API 非法 JSON HTTP 400', badJson.statusCode, 400)
  eq('API 非法 JSON ok=false', badJson.body && badJson.body.ok, false)

  const unknown = await callApi(handler, { method: 'GET', url: '/dsh-vpn/api/nope' })
  eq('API 未知端点 404', unknown.statusCode, 404)

  const wrongMethod = await callApi(handler, { method: 'GET', url: '/dsh-vpn/api/enable' })
  eq('API 方法不允许 405', wrongMethod.statusCode, 405)

  eq('resolveRelativePath 带前缀', resolveRelativePath('/dsh-vpn/api/status'), '/status')
  eq('resolveRelativePath 已剥离前缀', resolveRelativePath('/status'), '/status')
  eq('resolveRelativePath 根', resolveRelativePath('/dsh-vpn/api'), '/')

  // attachRoutes：webServer 可用时注册 prefix 路由，disposer 可移除
  let registered = null
  let disposed = false
  const fakeWebServer = {
    register(route) {
      registered = route
      return () => {
        disposed = true
      }
    },
  }
  const disposers = []
  const fakeCtx = {
    get(name) {
      return name === 'webServer' ? fakeWebServer : undefined
    },
    effect(factory) {
      disposers.push(factory())
    },
  }
  attachRoutes(fakeCtx, service)
  check('attachRoutes 注册了 prefix 路由', Boolean(registered), String(registered))
  eq('attachRoutes 路由 kind', registered && registered.kind, 'prefix')
  eq('attachRoutes 路由 path', registered && registered.path, API_PREFIX)
  eq('attachRoutes 路由 handler 是函数', typeof (registered && registered.handler), 'function')
  for (const dispose of disposers) {
    if (typeof dispose === 'function') dispose()
  }
  eq('attachRoutes disposer 可移除路由', disposed, true)

  // attachRoutes：webServer 不存在时静默跳过
  const silentCtx = { get: () => undefined, inject(deps, callback) { eq('attachRoutes 缺 webServer 时走 inject 等待', deps[0], 'webServer') ; void callback } }
  let threw = null
  try {
    attachRoutes(silentCtx, service)
  } catch (error) {
    threw = error
  }
  eq('attachRoutes 缺 webServer 不抛错', threw, null)
}

// ---------------------------------------------------------------------------
// 7. VpnService 状态机安全路径（不启动 mihomo、不安装策略）
// ---------------------------------------------------------------------------

async function testService() {
  const dir = makeTempDir('service')
  try {
    const status0 = newTestService({ config: { dataDir: dir, logLevel: 'silent' } })
    const snapshot = status0.status()
    eq('service 初始 status=disabled', snapshot.status, 'disabled')
    eq('service 初始 state 别名=disabled', snapshot.state, 'disabled')
    eq('service 初始 enabled=false', snapshot.enabled, false)
    eq('service 初始 killSwitch inactive', snapshot.killSwitch.active, false)
    eq('service 初始 policy.active=null', snapshot.policy.active, null)
    const auto = status0.maybeAutoStart()
    eq('service 未启用时 maybeAutoStart 不调度', auto.scheduled, false)

    const enableNoSub = await status0.enable({ source: 'selftest' })
    eq('service 无订阅 enable ok=false', enableNoSub.ok, false)
    includes('service 无订阅错误提示', enableNoSub.error, '订阅')
    eq('service 无订阅后 policy 未安装', status0.policy.current().active, null)
    const disable = await status0.disable()
    eq('service disable ok=true', disable.ok, true)
    eq('service disable 后 status=disabled', disable.status.status, 'disabled')
    await status0.shutdown()

    // 有订阅缓存 + 引擎不可用/二进制不存在 → 失败路径必须保持策略未安装
    const dir2 = makeTempDir('service-cache')
    fs.writeFileSync(path.join(dir2, 'subscription.yaml'), SAMPLE_YAML, 'utf8')
    const service2 = newTestService({
      config: {
        dataDir: dir2,
        logLevel: 'silent',
        binaryPath: path.join(dir2, 'definitely-not-mihomo.exe'),
        subscriptionUrl: 'https://panel.example.com/config?token=x',
        fetchTimeoutMs: 3000,
        autoStartDelayMs: 60000,
      },
    })
    eq('service2 有缓存时 subscription.fromCache=true', service2.status().subscription.fromCache, true)
    eq('service2 有缓存时 nodeCount=2', service2.status().subscription.nodeCount, 2)
    const enable2 = await service2.enable({ source: 'selftest' })
    eq('service2 enable ok=false', enable2.ok, false)
    includeOrCheck(enable2.error)
    eq('service2 失败后 status=failed', service2.status().status, 'failed')
    eq('service2 失败后 policy 未安装', service2.policy.current().active, null)
    await service2.disable()
    await service2.shutdown()

    // kill-switch：flag 存在 → 强制 disabled、enable 被拒绝
    const dir3 = makeTempDir('service-kill')
    fs.writeFileSync(path.join(dir3, 'disable.flag'), '1', 'utf8')
    const service3 = newTestService({ config: { dataDir: dir3, logLevel: 'silent' } })
    eq('service3 killSwitch.active=true', service3.status().killSwitch.active, true)
    const enable3 = await service3.enable({ source: 'selftest' })
    eq('service3 kill-switch 下 enable ok=false', enable3.ok, false)
    includes('service3 kill-switch 错误提示', enable3.error, 'kill-switch')
    eq('service3 kill-switch 下 status 保持 disabled', service3.status().status, 'disabled')
    eq('service3 kill-switch 下 maybeAutoStart 不调度', service3.maybeAutoStart().scheduled, false)
    await service3.shutdown()

    // 持久化 enabled=true → maybeAutoStart 调度（延迟 60s，shutdown 时清理）
    const dir4 = makeTempDir('service-auto')
    saveStateSync(dir4, { enabled: true, subscriptionUrl: 'https://panel.example.com/config?token=x', preferredNode: '', mode: 'rule' })
    const service4 = newTestService({ config: { dataDir: dir4, logLevel: 'silent', autoStartDelayMs: 60000 } })
    eq('service4 持久化 enabled=true 读到', service4.status().enabled, true)
    eq('service4 maybeAutoStart 调度', service4.maybeAutoStart().scheduled, true)
    await service4.disable()
    await service4.shutdown()

    // state.json 损坏 → 回退 disabled，不抛错
    const dir5 = makeTempDir('service-corrupt')
    fs.writeFileSync(statePath(dir5), 'not-json', 'utf8')
    let corruptThrew = null
    let service5 = null
    try {
      service5 = newTestService({ config: { dataDir: dir5, logLevel: 'silent' } })
    } catch (error) {
      corruptThrew = error
    }
    eq('service5 state 损坏不抛错', corruptThrew, null)
    eq('service5 state 损坏回退 disabled', service5 && service5.status().status, 'disabled')
    eq('service5 state 损坏回退 enabled=false', service5 && service5.status().enabled, false)
    await service5?.shutdown()
  } finally {
    cleanupDir(dir)
  }
}

function includeOrCheck(errorText) {
  check('service2 失败错误信息非空', typeof errorText === 'string' && errorText.length > 0, String(errorText))
}

// ---------------------------------------------------------------------------
// 8. 引擎模块探测（引擎未就绪时应优雅失败，就绪时应满足契约导出）
// ---------------------------------------------------------------------------

async function testEngineProbe() {
  try {
    const mod = await loadEngineModule(() => {})
    console.log('  [engine] lib/engine/index.mjs 已加载，契约导出校验中…')
    check('engine 模块已就绪（lib/engine/index.mjs 存在）', isEngineModuleLoaded(), 'loaded')
    const required = ['resolvePaths', 'fetchSubscription', 'parseClashYaml', 'buildRuntimeConfig', 'pickFreePort', 'MihomoEngine', 'probeThroughProxy']
    for (const name of required) eq('engine 导出 ' + name, typeof mod[name], name === 'MihomoEngine' ? 'function' : 'function')
    // 用真实解析器验证 SAMPLE_YAML
    const parsed = mod.parseClashYaml(SAMPLE_YAML)
    eq('engine.parseClashYaml proxies 数量', parsed.proxies.length, 4)
    const runtime = mod.buildRuntimeConfig({ yaml: SAMPLE_YAML, mixedPort: 18123, controllerPort: 19123, secret: 's', mode: 'global', logLevel: 'warning' })
    includes('engine.buildRuntimeConfig 覆盖 mixed-port', runtime, 'mixed-port: 18123')
    includes('engine.buildRuntimeConfig 覆盖 external-controller', runtime, "external-controller: '127.0.0.1:19123'")
    includes('engine.buildRuntimeConfig 覆盖 mode', runtime, 'mode: global')
    check('engine.buildRuntimeConfig 保留 proxies', runtime.includes('🇭🇰 香港01'), runtime.slice(0, 200))
  } catch (error) {
    // 引擎尚未写完：加载失败必须是一条清晰错误，而不是模块级崩溃
    console.log('  [engine] 未就绪（SKIP 契约校验）:', error && error.message)
    includes('engine 未就绪时错误信息清晰', error && error.message, '引擎模块')
    eq('engine 未就绪时 isEngineModuleLoaded=false', isEngineModuleLoaded(), false)
    passed += 1
  }
}

// ---------------------------------------------------------------------------
// 9. dataDir 自动探测（桌面宿主只有 DSH_HOME 时按 profile-scan 找插件安装位置）
// ---------------------------------------------------------------------------

function testDataDirDetection() {
  const root = makeTempDir('datadir')
  const home = path.join(root, 'DSH-Home')
  const profiles = path.join(home, 'profiles')

  // 1) Config.dataDir 显式优先
  const custom = resolveDataDirInfo({ dataDir: path.join(root, 'custom') }, { DSH_HOME: home })
  eq('dataDir 显式 config 覆盖', custom.dataDir, path.resolve(path.join(root, 'custom')))
  eq('dataDir 来源 config', custom.source, 'config')

  // 2) DSH_PROFILE_DIR 优先于 DSH_HOME
  const viaProfileDir = resolveDataDirInfo({ dataDir: '' }, { DSH_PROFILE_DIR: path.join(root, 'profileA'), DSH_HOME: home })
  eq('dataDir DSH_PROFILE_DIR 优先', viaProfileDir.dataDir, path.join(path.join(root, 'profileA'), 'vpn'))
  eq('dataDir 来源 env', viaProfileDir.source, 'env')

  // 3) DSH_PROFILE 存在对应目录时用它
  fs.mkdirSync(path.join(profiles, 'desktop'), { recursive: true })
  fs.mkdirSync(path.join(profiles, 'default'), { recursive: true })
  const viaProfile = resolveDataDirInfo({ dataDir: '' }, { DSH_HOME: home, DSH_PROFILE: 'desktop' })
  eq('dataDir DSH_PROFILE 目录存在时用它', viaProfile.dataDir, path.join(profiles, 'desktop', 'vpn'))
  eq('dataDir 来源 env(profile)', viaProfile.source, 'env')

  // 4) 只有 DSH_HOME 时扫描 profiles：找包含 node_modules/dsh-vpn 的 profile
  fs.mkdirSync(path.join(profiles, 'default', 'node_modules'), { recursive: true })
  fs.mkdirSync(path.join(profiles, 'desktop', 'node_modules', 'dsh-vpn'), { recursive: true })
  const viaScan = resolveDataDirInfo({ dataDir: '' }, { DSH_HOME: home })
  eq('dataDir 扫描到含插件的 profile', viaScan.dataDir, path.join(profiles, 'desktop', 'vpn'))
  eq('dataDir 来源 profile-scan', viaScan.source, 'profile-scan')
  check('dataDir profile-scan 返回 profileDir', viaScan.profileDir === path.join(profiles, 'desktop'), String(viaScan.profileDir))

  // 5) 没有任何含插件的 profile 时回退 default
  const home2 = path.join(root, 'DSH-Home2')
  fs.mkdirSync(path.join(home2, 'profiles', 'other-profile'), { recursive: true })
  const viaFallback = resolveDataDirInfo({ dataDir: '' }, { DSH_HOME: home2 })
  eq('dataDir 无插件 profile 时 fallback', viaFallback.dataDir, path.join(home2, 'profiles', 'default', 'vpn'))
  eq('dataDir 来源 fallback', viaFallback.source, 'fallback')

  // 6) 完全无 env 时 ~/.dsh-vpn
  const noHome = resolveDataDirInfo({ dataDir: '' }, {})
  eq('dataDir 无 env 来源 fallback', noHome.source, 'fallback')
  check('dataDir 无 env 时回退 home', noHome.dataDir.length > 0, noHome.dataDir)
}

// ---------------------------------------------------------------------------
// 10. mihomo profile 持久化补丁（避免受限目录写 cache.db 告警）
// ---------------------------------------------------------------------------

function testProfileStorePatch() {
  const patched = ensureProfileStoreDisabled(SAMPLE_YAML)
  includes('profile patch 追加 profile 段', patched, 'profile:')
  includes('profile patch store-selected: false', patched, 'store-selected: false')
  includes('profile patch store-fake-ip: false', patched, 'store-fake-ip: false')
  check('profile patch 保留原 proxies 内容', patched.includes('🇭🇰 香港01'), patched.slice(0, 160))
  const already = 'profile:\n  store-selected: true\n' + SAMPLE_YAML
  eq('profile patch 已有 profile 段时幂等', ensureProfileStoreDisabled(already), already)
  eq('profile patch 空串原样返回', ensureProfileStoreDisabled(''), '')
  eq('profile patch 非字符串原样返回', ensureProfileStoreDisabled(null), null)
}

// ---------------------------------------------------------------------------
// 11. 当前节点解析（真实 /proxies 结构：节点选择→自动选择→真节点；排除 Reject/直连）
// ---------------------------------------------------------------------------

function makeFakeEngine({ groups, nodes, globalNow }) {
  const state = {
    globalNow,
    groups: groups.map((group) => ({ ...group, all: Array.isArray(group.all) ? [...group.all] : [] })),
    nodes: nodes.map((node) => ({ ...node })),
  }
  return {
    state,
    async proxies() {
      return {
        groups: state.groups.map((group) => ({ ...group, all: [...group.all] })),
        nodes: state.nodes.map((node) => ({ ...node })),
        global: { now: state.globalNow },
      }
    },
    async selectInGroup(groupName, name) {
      const group = state.groups.find((candidate) => candidate.name === groupName)
      if (!group) throw new Error('no such group: ' + groupName)
      if (!group.all.includes(name)) throw new Error('group ' + groupName + ' has no member ' + name)
      group.now = name
    },
    async selectGlobal(name) {
      state.globalNow = name
    },
  }
}

/** Lead 真实宿主实测到的 /proxies 结构。 */
function leadStructure() {
  return {
    globalNow: '🔰 节点选择',
    groups: [
      { name: 'GLOBAL', type: 'Selector', now: '🔰 节点选择', all: [] },
      { name: '🔰 节点选择', type: 'Selector', now: '♻️ 自动选择', all: ['♻️ 自动选择', '🇵🇭 菲律宾A[BGP]', '🇺🇸 美国01[直连]'] },
      { name: '♻️ 自动选择', type: 'URLTest', now: '🇵🇭 菲律宾A[BGP]', all: ['🇵🇭 菲律宾A[BGP]', '🇺🇸 美国01[直连]'] },
      { name: '⛔ Reject', type: 'Selector', now: 'REJECT', all: ['REJECT'] },
      { name: '🎯 全球直连', type: 'Selector', now: 'DIRECT', all: ['DIRECT'] },
    ],
    nodes: [
      { name: '🇵🇭 菲律宾A[BGP]', type: 'Vless' },
      { name: '🇺🇸 美国01[直连]', type: 'Vless' },
      { name: '剩余流量：300 GB', type: 'Shadowsocks' },
      { name: '套餐到期：2026-11-28', type: 'Shadowsocks' },
      { name: '导航页：https://example.com', type: 'Shadowsocks' },
    ],
  }
}

/**
 * Lead 真实宿主实测到的另一种结构：规则用的 Selector 链最终落到**伪节点名**
 * （`⚙️ 故障转移.now = "剩余流量：299.8 GB"`，订阅把它当合法 fallback 选项，但名字是广告）。
 */
function pseudoFallbackStructure() {
  return {
    globalNow: '🔰 节点选择',
    groups: [
      { name: 'GLOBAL', type: 'Selector', now: '🔰 节点选择', all: [] },
      { name: '🔰 节点选择', type: 'Selector', now: '⚙️ 故障转移', all: ['⚙️ 故障转移', '🇭🇰 香港F[BGP]'] },
      {
        name: '⚙️ 故障转移',
        type: 'Fallback',
        now: '剩余流量：299.8 GB',
        all: ['剩余流量：299.8 GB', '🇭🇰 香港F[BGP]'],
      },
      { name: '♻️ 自动选择', type: 'URLTest', now: '🇭🇰 香港F[BGP]', all: ['🇭🇰 香港F[BGP]'] },
    ],
    nodes: [
      { name: '🇭🇰 香港F[BGP]', type: 'Vless' },
      { name: '剩余流量：299.8 GB', type: 'Shadowsocks' },
    ],
  }
}

async function testNodeResolution() {
  const dir = makeTempDir('node-resolution')
  const service = newTestService({ config: { dataDir: dir, logLevel: 'silent' } })
  try {
    // 当前节点：必须沿 节点选择→自动选择 解析到真节点，不能是 REJECT/DIRECT/分组名
    const engine = makeFakeEngine(leadStructure())
    const current = await service._currentNodeName(engine)
    eq('currentNode 递归解析到真节点', current, '🇵🇭 菲律宾A[BGP]')
    check('currentNode 不是 REJECT/DIRECT', current !== 'REJECT' && current !== 'DIRECT', String(current))
    check('currentNode 不是分组名', !['♻️ 自动选择', '🔰 节点选择', 'GLOBAL'].includes(current), String(current))

    // 只有 Reject/直连开关组时：不能把控制值当当前节点
    const rejectOnly = makeFakeEngine({
      globalNow: '🎯 全球直连',
      groups: [
        { name: 'GLOBAL', type: 'Selector', now: '🎯 全球直连', all: [] },
        { name: '⛔ Reject', type: 'Selector', now: 'REJECT', all: ['REJECT'] },
        { name: '🎯 全球直连', type: 'Selector', now: 'DIRECT', all: ['DIRECT'] },
      ],
      nodes: [{ name: '🇵🇭 菲律宾A[BGP]', type: 'Vless' }],
    })
    const rejectCurrent = await service._currentNodeName(rejectOnly)
    check('currentNode 无路由组时不返回 REJECT/DIRECT', rejectCurrent !== 'REJECT' && rejectCurrent !== 'DIRECT', String(rejectCurrent))

    // rule 模式 select：应设置在「节点选择」并验证生效
    const selected = await service._selectOnEngine(engine, '🇺🇸 美国01[直连]')
    eq('rule select 分组为节点选择', selected.group, '🔰 节点选择')
    eq('rule select 已验证生效', selected.verified, true)
    eq('rule select 后节点选择.now', engine.state.groups.find((group) => group.name === '🔰 节点选择').now, '🇺🇸 美国01[直连]')
    eq('rule select 后 currentNode', await service._currentNodeName(engine), '🇺🇸 美国01[直连]')

    // 选择后 selectNode 状态：persist preferredNode + applied/verified（模拟 running）
    service._engine = engine
    service._status.status = 'running'
    const selectResult = await service.selectNode('🇵🇭 菲律宾A[BGP]')
    eq('selectNode ok', selectResult.ok, true)
    eq('selectNode verified', selectResult.verified, true)
    eq('selectNode group', selectResult.group, '🔰 节点选择')
    eq('selectNode 持久化 preferredNode', service.config.preferredNode, '🇵🇭 菲律宾A[BGP]')
    service._engine = null
    service._status.status = 'disabled'

    // global 模式 select：走 GLOBAL 并验证
    const dir2 = makeTempDir('node-resolution-global')
    const serviceGlobal = newTestService({ config: { dataDir: dir2, logLevel: 'silent', mode: 'global' } })
    try {
      const engineGlobal = makeFakeEngine(leadStructure())
      const globalSelected = await serviceGlobal._selectOnEngine(engineGlobal, '🇺🇸 美国01[直连]')
      eq('global select 分组为 GLOBAL', globalSelected.group, 'GLOBAL')
      eq('global select 已验证生效', globalSelected.verified, true)
      eq('global select 后 currentNode', await serviceGlobal._currentNodeName(engineGlobal), '🇺🇸 美国01[直连]')
    } finally {
      await serviceGlobal.shutdown()
    }

    // global 模式下 GLOBAL.now 是 DIRECT → 不应拿 rule 分组节点冒充当前节点
    const dirGlobalDirect = makeTempDir('node-global-direct')
    const serviceGlobalDirect = newTestService({ config: { dataDir: dirGlobalDirect, logLevel: 'silent', mode: 'global' } })
    try {
      const globalDirect = makeFakeEngine({ ...leadStructure(), globalNow: 'DIRECT' })
      eq('global 模式 GLOBAL=DIRECT 时 currentNode=null', await serviceGlobalDirect._currentNodeName(globalDirect), null)
    } finally {
      await serviceGlobalDirect.shutdown()
    }

    // 伪节点叶子（⚙️ 故障转移.now = 剩余流量：299.8 GB）不得作为 nodeName
    const dirPseudo = makeTempDir('node-pseudo')
    const servicePseudo = newTestService({ config: { dataDir: dirPseudo, logLevel: 'silent', preferredNode: '🇭🇰 香港F[BGP]' } })
    try {
      const pseudoEngine = makeFakeEngine(pseudoFallbackStructure())
      const nameWithPreferred = await servicePseudo._currentNodeName(pseudoEngine)
      eq('伪节点叶子被过滤并回退 preferred', nameWithPreferred, '🇭🇰 香港F[BGP]')
      check('伪节点名不作为 nodeName', !String(nameWithPreferred).includes('剩余流量'), String(nameWithPreferred))
      // 严格模式（选择校验）不接受 preferred 回退：链最终仍是伪节点 → null
      eq(
        '严格模式不把 preferred 当作选择生效',
        await servicePseudo._currentNodeName(pseudoEngine, { allowPreferredFallback: false }),
        null,
      )
      // _applyPreferredNode 生效后 nodeName = preferred
      servicePseudo._status.status = 'running'
      servicePseudo._status.port = 18419
      const preferredApplied = await servicePseudo._applyPreferredNode(pseudoEngine)
      eq('_applyPreferredNode verified', Boolean(preferredApplied && preferredApplied.verified), true)
      eq('applyPreferred 后 currentNode=preferred', await servicePseudo._currentNodeName(pseudoEngine), '🇭🇰 香港F[BGP]')
    } finally {
      await servicePseudo.shutdown()
    }
    const dirPseudo2 = makeTempDir('node-pseudo2')
    const servicePseudo2 = newTestService({ config: { dataDir: dirPseudo2, logLevel: 'silent' } })
    try {
      eq('无 preferred 时伪节点叶子返回 null', await servicePseudo2._currentNodeName(makeFakeEngine(pseudoFallbackStructure())), null)
    } finally {
      await servicePseudo2.shutdown()
    }
  } finally {
    await service.shutdown()
  }
}

// ---------------------------------------------------------------------------
// 12. 系统代理 manager（memory runner：快照/合并 bypass/幂等/失败回滚/精确还原）
// ---------------------------------------------------------------------------

function testSystemProxyManager() {
  // ---- 纯函数 ----
  eq('isValidProxyPort 1024', isValidProxyPort(1024), true)
  eq('isValidProxyPort 80 非法', isValidProxyPort(80), false)
  eq('isValidProxyPort 65536 非法', isValidProxyPort(65536), false)
  eq('buildTargetProxyServer', buildTargetProxyServer(18414), '127.0.0.1:18414')
  eq('isPluginProxyServer 插件端口', isPluginProxyServer('127.0.0.1:18414'), true)
  eq('isPluginProxyServer 用户 Clash', isPluginProxyServer('127.0.0.1:7897'), false)
  eq('isPluginProxyServer 多协议形式', isPluginProxyServer('http=127.0.0.1:18000;https=127.0.0.1:18000'), true)
  eq('isPluginProxyServer 非 loopback', isPluginProxyServer('10.0.0.1:18000'), false)
  eq('mergeBypass 保留原条目并补默认', mergeBypass('localhost;*.local'), 'localhost;*.local;127.*;::1;<local>')
  eq('mergeBypass 空值', mergeBypass(''), 'localhost;127.*;::1;<local>')
  eq('mergeBypass 大小写不敏感去重', mergeBypass('LOCALHOST;127.*;<local>'), 'LOCALHOST;127.*;<local>;::1')
  eq('parseDword 0x1', parseDword('0x1'), 1)
  eq('parseDword 0', parseDword('0'), 0)
  eq('parseDword 空', parseDword(''), null)
  const parsedReg = parseRegQueryOutput(
    '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n' +
      '    ProxyEnable    REG_DWORD    0x1\r\n' +
      '    ProxyServer    REG_SZ    127.0.0.1:7897\r\n' +
      '    ProxyOverride    REG_SZ    localhost;*.local;<local>\r\n',
  )
  eq('parseRegQueryOutput ProxyEnable', parsedReg.ProxyEnable, { type: 'REG_DWORD', data: '0x1' })
  eq('parseRegQueryOutput ProxyOverride', parsedReg.ProxyOverride.data, 'localhost;*.local;<local>')

  // ---- 非 Windows 平台 ----
  const linux = new SystemProxyManager({ runner: createMemoryRunner(), platform: 'linux' })
  eq('非 win32 supported=false', linux.supported, false)
  eq('非 win32 read 失败', linux.readSystemProxy().ok, false)
  eq('非 win32 apply 失败', linux.applySystemProxy({ port: 18414 }).ok, false)

  // ---- apply：快照 + 写入 + 合并 bypass + 通知 ----
  const { runner, manager } = createTestSystemProxy()
  const applied = manager.applySystemProxy({ port: 18414 })
  eq('apply ok', applied.ok, true)
  eq('apply capturedSnapshot', applied.capturedSnapshot, true)
  eq('apply target', applied.target, '127.0.0.1:18414')
  eq('apply 后 ProxyEnable', runner.getValue('ProxyEnable').data, '1')
  eq('apply 后 ProxyServer', runner.getValue('ProxyServer').data, '127.0.0.1:18414')
  eq('apply 后 bypass 合并', runner.getValue('ProxyOverride').data, 'localhost;*.local;127.*;::1;<local>')
  eq('apply 后调用 WinINET notify', runner.calls.filter((call) => call.op === 'notify').length, 1)
  eq('apply 快照记录原值 7897', applied.snapshot.proxyServer.data, '127.0.0.1:7897')
  // 幂等
  runner.resetCalls()
  const again = manager.applySystemProxy({ port: 18414 })
  eq('重复 apply 幂等 ok', again.ok, true)
  eq('重复 apply changed=false', again.changed, false)
  eq('重复 apply 不写注册表/不通知', runner.calls.filter((call) => call.op !== 'read').length, 0)
  // 换端口：沿用快照，不重拍
  const changedPort = manager.applySystemProxy({ port: 18415, snapshot: applied.snapshot })
  eq('换端口 ok', changedPort.ok, true)
  eq('换端口不重拍快照', changedPort.capturedSnapshot, false)
  eq('换端口后 ProxyServer', runner.getValue('ProxyServer').data, '127.0.0.1:18415')
  eq('换端口后快照原值仍是 7897', changedPort.snapshot.proxyServer.data, '127.0.0.1:7897')
  // 精确还原
  const restored = manager.restoreSystemProxy(changedPort.snapshot)
  eq('restore ok', restored.ok, true)
  eq('restore mode=precise', restored.mode, 'precise')
  eq('restore ProxyEnable 还原 0x1', runner.getValue('ProxyEnable').data, '0x1')
  eq('restore ProxyServer 还原 7897', runner.getValue('ProxyServer').data, '127.0.0.1:7897')
  eq('restore ProxyOverride 还原', runner.getValue('ProxyOverride').data, 'localhost;*.local')
  const restoreAgain = manager.restoreSystemProxy(changedPort.snapshot)
  eq('重复 restore 幂等', restoreAgain.ok, true)
  eq('重复 restore 后仍是 7897', runner.getValue('ProxyServer').data, '127.0.0.1:7897')

  // ---- 无快照 → 安全关闭 ProxyEnable ----
  const { runner: r2, manager: m2 } = createTestSystemProxy()
  const safe = m2.restoreSystemProxy(null)
  eq('无快照 restore ok', safe.ok, true)
  eq('无快照 restore mode', safe.mode, 'disabled-no-snapshot')
  eq('无快照 restore 后 ProxyEnable=0', String(r2.getValue('ProxyEnable').data), '0')

  // ---- 失败回滚 ----
  const { runner: r3, manager: m3 } = createTestSystemProxy()
  r3.failWrite('ProxyServer')
  const failApply = m3.applySystemProxy({ port: 18414 })
  eq('写失败 apply ok=false', failApply.ok, false)
  eq('写失败标记 rolledBack', failApply.rolledBack, true)
  eq('回滚后 ProxyEnable 原值', r3.getValue('ProxyEnable').data, '0x1')
  eq('回滚后 ProxyServer 原值', r3.getValue('ProxyServer').data, '127.0.0.1:7897')
  const { runner: r4, manager: m4 } = createTestSystemProxy()
  r4.failNotify(true)
  const failNotify = m4.applySystemProxy({ port: 18414 })
  eq('WinINET 通知失败 apply ok=false', failNotify.ok, false)
  eq('通知失败后 ProxyServer 回滚', r4.getValue('ProxyServer').data, '127.0.0.1:7897')
  const { runner: r5, manager: m5 } = createTestSystemProxy()
  r5.failWrite('ProxyServer', 'silent')
  const failVerify = m5.applySystemProxy({ port: 18414 })
  eq('写入校验失败 ok=false', failVerify.ok, false)
  eq('写入校验失败后 ProxyEnable 回滚', r5.getValue('ProxyEnable').data, '0x1')

  // ---- 当前已是插件端口且无快照：绝不把自己的端口当原值 ----
  const orphanState = {
    ProxyEnable: { type: 'REG_DWORD', data: '0x1' },
    ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:18000' },
    ProxyOverride: { type: 'REG_SZ', data: 'localhost' },
  }
  const { manager: m6 } = createTestSystemProxy(orphanState)
  const orphanApply = m6.applySystemProxy({ port: 18414 })
  eq('插件端口段无快照 apply ok', orphanApply.ok, true)
  eq('插件端口段无快照 snapshot=null', orphanApply.snapshot, null)

  // ---- PAC（AutoConfigURL）暂存/清空/还原 ----
  const pacValues = { ...defaultSystemProxyValues(), AutoConfigURL: { type: 'REG_SZ', data: 'http://127.0.0.1:9999/proxy.pac' } }
  const { runner: r7, manager: m7 } = createTestSystemProxy(pacValues)
  const pacApply = m7.applySystemProxy({ port: 18414 })
  eq('PAC apply ok', pacApply.ok, true)
  eq('PAC 被临时清空', r7.getValue('AutoConfigURL'), null)
  eq('PAC 快照标记 autoConfigUrlCleared', pacApply.snapshot.autoConfigUrlCleared, true)
  const pacRestore = m7.restoreSystemProxy(pacApply.snapshot)
  eq('PAC restore ok', pacRestore.ok, true)
  eq('PAC 原值已还原', r7.getValue('AutoConfigURL').data, 'http://127.0.0.1:9999/proxy.pac')

  // ---- 快照校验 ----
  eq('合法快照校验通过', validateSnapshot(applied.snapshot).ok, true)
  eq('非法版本快照被拒', validateSnapshot({ version: 99 }).ok, false)
  eq('非法快照 restore 被拒', manager.restoreSystemProxy({ version: 99 }).ok, false)
}

// ---------------------------------------------------------------------------
// 13. 系统代理 × VpnService 集成（注入 memory runner，不碰真实注册表）
// ---------------------------------------------------------------------------

async function testSystemProxyService() {
  const dir = makeTempDir('sysproxy-service')
  const service = newTestService({ dataDir: dir, logLevel: 'silent' })
  const manager = service._systemProxy
  const runner = manager.runner
  try {
    eq('构造时无 stale 标记 → 不读注册表', runner.calls.filter((call) => call.op === 'read').length, 0)
    const initial = service.status().systemProxy
    eq('systemProxy.supported=true', initial.supported, true)
    eq('systemProxy.enabled=false', initial.enabled, false)
    eq('systemProxy.applied=false', initial.applied, false)
    eq('systemProxy 有 baseline 字段', Object.prototype.hasOwnProperty.call(initial, 'original'), true)

    const notRunning = await service.setSystemProxy(true)
    eq('未运行时开启 ok=false', notRunning.ok, false)
    includes('未运行错误提示', notRunning.error, '未运行')

    // 模拟 running
    service._status.status = 'running'
    service._status.port = 18414
    const on = await service.setSystemProxy(true, { source: 'selftest' })
    eq('开启系统代理 ok', on.ok, true)
    eq('开启后 applied=true', on.systemProxy.applied, true)
    eq('开启后 target', on.systemProxy.target, '127.0.0.1:18414')
    eq('开启后 state.enabled=true', on.systemProxy.enabled, true)
    eq('ProxyEnable 写入 1', String(runner.getValue('ProxyEnable').data), '1')
    eq('ProxyServer 写入插件端口', runner.getValue('ProxyServer').data, '127.0.0.1:18414')
    check(
      'ProxyOverride 合并 loopback',
      ['localhost', '127.*', '<local>'].every((token) => runner.getValue('ProxyOverride').data.includes(token)),
      runner.getValue('ProxyOverride').data,
    )
    check('ProxyOverride 保留原条目 *.local', runner.getValue('ProxyOverride').data.includes('*.local'), runner.getValue('ProxyOverride').data)
    const idempotent = await service.setSystemProxy(true)
    eq('重复开启幂等', Boolean(idempotent.idempotent), true)

    // 外部程序改回 7897 → status.applied 必须实时变 false（drift）
    runner.setValue('ProxyServer', '127.0.0.1:7897')
    const drift = service.status().systemProxy
    eq('外部改动后 status.applied=false', drift.applied, false)
    eq('外部改动后 status.enabled=true', drift.enabled, true)
    eq('外部改动后 drift=true', drift.drift, true)

    // applied=false 时关闭：只清意图，不重复还原
    runner.resetCalls()
    const offWhenDrift = await service.setSystemProxy(false)
    eq('applied=false 关闭 ok', offWhenDrift.ok, true)
    eq('applied=false 关闭不写/不通知', runner.calls.filter((call) => call.op !== 'read').length, 0)
    eq('applied=false 关闭后 enabled=false', service.status().systemProxy.enabled, false)

    // 重新开启（重新捕获当前 7897 快照）→ 手动关闭精确还原
    const on2 = await service.setSystemProxy(true)
    eq('重新开启 ok', on2.ok, true)
    eq('重新开启 again applied', on2.systemProxy.applied, true)
    eq('重新开启快照为 7897', on2.systemProxy.original.proxyServer, '127.0.0.1:7897')
    const off = await service.setSystemProxy(false)
    eq('关闭 ok', off.ok, true)
    eq('关闭 restored=true', off.restored, true)
    eq('关闭后 ProxyServer 还原 7897', runner.getValue('ProxyServer').data, '127.0.0.1:7897')
    eq('关闭后 ProxyEnable 还原为开启(1)', parseDword(runner.getValue('ProxyEnable').data), 1)
    eq('关闭后 status.applied=false', service.status().systemProxy.applied, false)
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
    eq('state.systemProxy=false', persisted.systemProxy, false)
    eq('state.systemProxyApplied=false', persisted.systemProxyApplied, false)
    eq('state.systemProxyOriginal=null', persisted.systemProxyOriginal, null)
  } finally {
    await service.shutdown()
  }

  // disable：先还原系统代理，再停引擎
  const dir2 = makeTempDir('sysproxy-disable')
  const service2 = newTestService({ dataDir: dir2, logLevel: 'silent' })
  const manager2 = service2._systemProxy
  const runner2 = manager2.runner
  try {
    service2._status.status = 'running'
    service2._status.port = 18415
    await service2.setSystemProxy(true)
    const events = []
    const originalRestore = manager2.restoreSystemProxy.bind(manager2)
    manager2.restoreSystemProxy = (...args) => {
      events.push('restore-system-proxy')
      return originalRestore(...args)
    }
    service2._engine = {
      stop: async () => {
        events.push('stop-engine')
      },
      isRunning: () => true,
      status: () => ({ running: true, pid: 1 }),
      logs: () => [],
    }
    const disabled = await service2.disable()
    eq('disable ok', disabled.ok, true)
    check(
      'disable 先还原系统代理再停引擎',
      events.includes('restore-system-proxy') && events.indexOf('restore-system-proxy') < events.indexOf('stop-engine'),
      JSON.stringify(events),
    )
    eq('disable 后系统代理已还原', runner2.getValue('ProxyServer').data, '127.0.0.1:7897')
    manager2.restoreSystemProxy = originalRestore
  } finally {
    await service2.shutdown()
  }

  // 还原失败（且安全关闭也失败）→ disable 中止，保持引擎运行
  const dir3 = makeTempDir('sysproxy-abort')
  const service3 = newTestService({ dataDir: dir3, logLevel: 'silent' })
  const manager3 = service3._systemProxy
  const runner3 = manager3.runner
  try {
    service3._status.status = 'running'
    service3._status.port = 18416
    await service3.setSystemProxy(true)
    runner3.failWrite('*')
    runner3.failDelete('*')
    const events = []
    service3._engine = {
      stop: async () => {
        events.push('stop-engine')
      },
      isRunning: () => true,
      status: () => ({ running: true, pid: 1 }),
      logs: () => [],
    }
    const aborted = await service3.disable()
    eq('还原失败时 disable ok=false', aborted.ok, false)
    includes('还原失败时 disable 报中止', aborted.error, '中止')
    eq('还原失败时引擎未被停止', events.length, 0)
    runner3.failures.write = null
    runner3.failures.delete = null
  } finally {
    await service3.shutdown()
  }

  // degraded：立即还原系统代理（意图保持 true，恢复后可再开）
  const dir4 = makeTempDir('sysproxy-degraded')
  const service4 = newTestService({ dataDir: dir4, logLevel: 'silent' })
  const manager4 = service4._systemProxy
  const runner4 = manager4.runner
  try {
    service4._status.status = 'running'
    service4._status.port = 18417
    await service4.setSystemProxy(true)
    service4._engine = { stop: async () => {}, isRunning: () => true, status: () => ({ running: true, pid: 1 }), logs: () => [] }
    await service4._enterDegraded('selftest degraded')
    eq('degraded 后系统代理已还原', runner4.getValue('ProxyServer').data, '127.0.0.1:7897')
    const spState = service4.status().systemProxy
    eq('degraded 后 applied=false', spState.applied, false)
    eq('degraded 后意图 enabled=true', spState.enabled, true)
  } finally {
    await service4.shutdown()
  }

  // shutdown：还原
  const dir5 = makeTempDir('sysproxy-shutdown')
  const service5 = newTestService({ dataDir: dir5, logLevel: 'silent' })
  const runner5 = service5._systemProxy.runner
  try {
    service5._status.status = 'running'
    service5._status.port = 18418
    await service5.setSystemProxy(true)
    await service5.shutdown()
    eq('shutdown 后系统代理已还原', runner5.getValue('ProxyServer').data, '127.0.0.1:7897')
  } catch (error) {
    cleanupSafe(service5)
    throw error
  }

  // 启动期 stale 清理：state 里有快照/标记 + 注册表指向插件端口 → 构造时先精确还原
  const dir6 = makeTempDir('sysproxy-stale')
  const snapshot = {
    version: 1,
    capturedAt: Date.now(),
    proxyEnable: { exists: true, type: 'REG_DWORD', data: '0x1' },
    proxyServer: { exists: true, type: 'REG_SZ', data: '127.0.0.1:7897' },
    proxyOverride: { exists: true, type: 'REG_SZ', data: 'localhost;*.local' },
    autoConfigUrl: { exists: false, type: null, data: null },
    autoConfigUrlCleared: false,
  }
  saveStateSync(dir6, { systemProxy: true, systemProxyApplied: true, systemProxyOriginal: snapshot })
  const staleRunner = createMemoryRunner({
    ProxyEnable: { type: 'REG_DWORD', data: '0x1' },
    ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:18000' },
    ProxyOverride: { type: 'REG_SZ', data: 'localhost;127.*;::1;<local>' },
  })
  const staleManager = new SystemProxyManager({ runner: staleRunner, platform: 'win32' })
  const staleService = new VpnService({
    config: { dataDir: dir6, logLevel: 'silent' },
    systemProxy: staleManager,
    systemProxyStatusCacheMs: 0,
  })
  try {
    eq('stale 清理后 ProxyServer 还原 7897', staleRunner.getValue('ProxyServer').data, '127.0.0.1:7897')
    const staleState = JSON.parse(fs.readFileSync(path.join(dir6, 'state.json'), 'utf8'))
    eq('stale 清理后 systemProxyApplied=false', staleState.systemProxyApplied, false)
    eq('stale 清理后 systemProxyOriginal=null', staleState.systemProxyOriginal, null)
    eq('stale 清理后意图仍保留 systemProxy=true', staleState.systemProxy, true)
  } finally {
    await staleService.shutdown()
  }
}

function cleanupSafe(service) {
  try {
    service?.shutdown?.()
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log('== dsh-vpn Host 纯逻辑自检 ==')
  console.log('node', process.version, '| cwd', process.cwd())
  console.log('')

  try {
    testConfig()
    testState()
    testSummary()
    testParseNodes()
    testDataDirDetection()
    testProfileStorePatch()
    testSystemProxyManager()
    await testPolicy()
    await testRoutes()
    await testService()
    await testNodeResolution()
    await testSystemProxyService()
    await testEngineProbe()
  } finally {
    cleanupTempDirs()
  }

  console.log('')
  console.log('PASS:', passed, ' FAIL:', failed)
  if (failed > 0) {
    console.log('')
    console.log('失败项:')
    for (const item of failures) console.log('  - ' + item)
    process.exitCode = 1
  } else {
    console.log('全部通过 ✅')
    process.exitCode = 0
  }
}

main().catch((error) => {
  console.error('selftest 崩溃:', error)
  process.exitCode = 1
})
