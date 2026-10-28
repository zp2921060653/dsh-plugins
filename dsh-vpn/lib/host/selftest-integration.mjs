// 集成冒烟（Host 编排 × 真实 mihomo × 真实订阅缓存）：
//   node lib/host/selftest-integration.mjs <clash-yaml-path>
// 只用于交付自检/回归，跑完自动清理自己启动的 mihomo。普通 node 下预期：
//   engine 启动成功 → health 通过 → installPolicy 因 dsh-http-proxy/undici 不可用而失败
//   → 立即回滚（不安装任何策略）→ 停引擎 → status=failed，且不残留 mihomo 进程。
// health 也可能因节点/网络原因先在门控失败，同样视为可接受的失败路径（断言仍要求完整回滚）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VpnService } from './service.mjs'
import { SystemProxyManager, createMemoryRunner } from './system-proxy.mjs'

const sourceYaml = process.argv[2]
if (!sourceYaml || !fs.existsSync(sourceYaml)) {
  console.error('usage: node lib/host/selftest-integration.mjs <clash-yaml-path>')
  process.exit(2)
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vpn-int-'))
fs.copyFileSync(sourceYaml, path.join(dataDir, 'subscription.yaml'))

const log = (level, message) => {
  const tag = String(level).toUpperCase().padEnd(7)
  console.log('[' + tag + '] ' + String(message).slice(0, 500))
}

// 集成冒烟绝不触碰真实注册表：系统代理用内存 runner。
const systemProxyManager = new SystemProxyManager({
  platform: 'win32',
  runner: createMemoryRunner({
    ProxyEnable: { type: 'REG_DWORD', data: '0x1' },
    ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:7897' },
    ProxyOverride: { type: 'REG_SZ', data: 'localhost;*.local' },
  }),
})

const service = new VpnService({
  config: {
    dataDir,
    logLevel: 'debug',
    autoStartDelayMs: 60000,
    healthIntervalMs: 5000,
    failureThreshold: 2,
    retryIntervalMs: 60000,
    selfTestTimeoutMs: 8000,
    fetchTimeoutMs: 5000,
  },
  systemProxy: systemProxyManager,
  systemProxyStatusCacheMs: 0,
  log,
})

let exitCode = 0
try {
  const initial = service.status()
  console.log('== initial ==')
  console.log(JSON.stringify({ status: initial.status, subscription: initial.subscription, dataDir }, null, 2))
  if (initial.status !== 'disabled') throw new Error('初始状态不是 disabled')
  if (!initial.subscription.fromCache) throw new Error('未读到订阅缓存')
  if (!(initial.subscription.nodeCount > 0)) throw new Error('缓存订阅 nodeCount 异常: ' + initial.subscription.nodeCount)

  console.log('== enable ==')
  const result = await service.enable({ source: 'smoke' })
  console.log('enable result ok=', result.ok, ' error=', result.error || null)
  const after = service.status()
  console.log(
    'after status=',
    JSON.stringify(
      {
        status: after.status,
        state: after.state,
        lastError: after.lastError,
        port: after.port,
        controllerPort: after.controllerPort,
        selfTestMs: after.selfTestMs,
        lastHealthMs: after.lastHealthMs,
        policy: after.policy.active,
        engine: after.engine,
      },
      null,
      2,
    ),
  )
  // 普通 node 下策略接管必然不可用；也可能在 health 门控就失败（节点/网络原因）。
  // 两者都必须走完整回滚路径：failed、无策略、引擎已停。
  if (result.ok !== false) throw new Error('普通 node 下 enable 不应成功（策略接管应不可用）')
  const reasonText = String(result.error || '')
  const policyBlocked = /接管|POLICY_UNAVAILABLE|无法/.test(reasonText)
  const healthBlocked = /健康检查|health|HTTP \d+/.test(reasonText)
  if (!policyBlocked && !healthBlocked) throw new Error('失败原因不是预期路径: ' + reasonText)
  console.log('失败路径:', policyBlocked ? '策略接管不可用（预期）' : 'health 门控未通过（可接受的网络原因）')
  if (after.status !== 'failed') throw new Error('失败后状态不是 failed: ' + after.status)
  if (after.policy.active !== null) throw new Error('失败后策略仍在生效: ' + JSON.stringify(after.policy.active))
  if (after.engine && after.engine.running === true) throw new Error('失败后 mihomo 仍在运行')
  console.log('OK: enable 失败路径已正确回滚（策略未安装 + 引擎已停）')

  // 运行配置必须显式关闭 mihomo profile 持久化；mihomo.log 里不应该有 CacheFile 写失败告警。
  const runtimeYaml = fs.readFileSync(path.join(dataDir, 'runtime.yaml'), 'utf8')
  const profileBlocks = (runtimeYaml.match(/^profile\s*:/gm) || []).length
  if (profileBlocks !== 1) throw new Error('runtime.yaml 中 profile 顶层块数量异常: ' + profileBlocks + '（应为 1，engine 与 host 不应重复追加）')
  if (!/store-selected:\s*false/.test(runtimeYaml) || !/store-fake-ip:\s*false/.test(runtimeYaml)) {
    throw new Error('runtime.yaml 缺少 profile: {store-selected:false, store-fake-ip:false}')
  }
  console.log('OK: runtime.yaml 已包含 profile 持久化关闭配置（且无重复 profile 块）')
  let mihomoLog = ''
  try {
    mihomoLog = fs.readFileSync(path.join(dataDir, 'mihomo.log'), 'utf8')
  } catch {
    mihomoLog = ''
  }
  if (/can't open cache file|Access is denied/i.test(mihomoLog)) {
    throw new Error('mihomo.log 里仍有 CacheFile 写失败告警')
  }
  console.log('OK: mihomo.log 无 CacheFile/Access denied 告警')

  const disabled = await service.disable()
  console.log('disable ok=', disabled.ok, ' status=', disabled.status.status)
  if (!disabled.ok || disabled.status.status !== 'disabled') throw new Error('disable 未回到 disabled')
  console.log('ALL INTEGRATION CHECKS PASSED')
} catch (error) {
  console.error('INTEGRATION FAILED:', error && error.message)
  exitCode = 1
  try {
    console.log('final status=', JSON.stringify(service.status(), null, 2).slice(0, 4000))
  } catch {
    /* ignore */
  }
} finally {
  try {
    await service.shutdown()
  } catch (error) {
    console.error('shutdown error:', error && error.message)
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
process.exit(exitCode)
