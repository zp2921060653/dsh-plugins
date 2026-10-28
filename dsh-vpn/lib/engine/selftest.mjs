#!/usr/bin/env node
// dsh-vpn engine — end-to-end selftest.
//
// Exercises the real engine path:
//   fetchSubscription (live subscription)
//   -> buildRuntimeConfig (mode:global, random mixed/controller port in 18100-18299)
//   -> MihomoEngine.start (bundled mihomo binary, bundled Country.mmdb)
//   -> health / proxies / selectGlobal(REALITY node) / delay
//   -> probeThroughProxy('https://api.deepseek.com/') expecting HTTP 401
//   -> stop, and verify no mihomo process / no listening port is left behind.
//
// Usage:
//   node lib/engine/selftest.mjs
//   DSH_VPN_SUB='https://...' node lib/engine/selftest.mjs
//
// Exit code 0 = all checks passed, 1 = failure (diagnostics printed).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  buildRuntimeConfig,
  fetchSubscription,
  MihomoEngine,
  parseClashYaml,
  parseYaml,
  pickFreePort,
  probeThroughProxy,
  resolvePaths,
} from './index.mjs'

const SUBSCRIPTION_URL = process.env.DSH_VPN_SUB
if (!SUBSCRIPTION_URL) {
  console.error('缺少订阅地址：本自测需要一个真实的 Clash 订阅 URL（通过环境变量提供，绝不写进源码/仓库）。')
  console.error('用法示例：')
  console.error("  DSH_VPN_SUB='https://your-subscription-url/config?token=...' node lib/engine/selftest.mjs")
  console.error('  或（PowerShell）：')
  console.error("  $env:DSH_VPN_SUB='https://...'; node lib/engine/selftest.mjs")
  process.exit(1)
}
const EXPECTED_PROBE_STATUS = 401
const DEEPSEEK_PROBE_URL = 'https://api.deepseek.com/'
const DELAY_PROBE_URL = 'http://www.gstatic.com/generate_204'
const SECRET = 'dsh-vpn-selftest'
const PORT_RANGE = [18100, 18299]
const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url))

/** @type {Array<{name:string, ok:boolean, detail?:string, soft?:boolean}>} */
const steps = []
let engine = null
let tempDir = null
let startedPid = null
let mixedPort = null
let controllerPort = null
let hardFailure = false

function pass(name, detail) {
  steps.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(name, detail) {
  steps.push({ name, ok: false, detail })
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  hardFailure = true
}

function note(name, detail) {
  steps.push({ name, ok: true, detail, soft: true })
  console.log(`INFO  ${name}${detail ? ` — ${detail}` : ''}`)
}

function check(name, condition, detail) {
  if (condition) pass(name, detail)
  else fail(name, detail)
  return Boolean(condition)
}

async function main() {
  console.log('==== dsh-vpn engine selftest ====')
  console.log(
    `node ${process.version} | ${process.platform}/${process.arch} | cwd ${process.cwd()}`,
  )
  console.log(`subscription: ${SUBSCRIPTION_URL.replace(/(token=)[^&]+/, '$1***')}`)

  const { binaryPath } = resolvePaths({})
  const binaryOk = check('mihomo 二进制存在', fs.existsSync(binaryPath), binaryPath)
  if (!binaryOk) throw new Error('bundled mihomo binary is missing')

  // 1) subscription ---------------------------------------------------
  const fetchStarted = Date.now()
  const sub = await fetchSubscription(SUBSCRIPTION_URL, { timeoutMs: 30000 })
  console.log(
    `subscription: format=${sub.format} nodes=${sub.nodes.length} groups=${sub.groups.length} ` +
      `raw=${Buffer.byteLength(sub.raw, 'utf8')}B fetch=${Date.now() - fetchStarted}ms`,
  )
  console.log(
    'subscription info: ' +
      JSON.stringify({
        totalBytes: sub.info.totalBytes,
        expireAtIso: sub.info.expireAtIso,
        updateIntervalHours: sub.info.updateIntervalHours,
        nodeCount: sub.info.nodeCount,
        pseudoNodeCount: sub.info.pseudoNodeCount,
        remainingTraffic: sub.info.remainingTraffic,
        expireDate: sub.info.expireDate,
      }),
  )
  check('订阅拉取+解析成功', sub.nodes.length > 0, `${sub.nodes.length} 个可连接节点`)
  check(
    '订阅包含 REALITY(vless) 节点',
    sub.nodes.some((n) => n.type === 'vless'),
    `${sub.nodes.filter((n) => n.type === 'vless').length} 个 vless`,
  )
  check(
    '伪节点(剩余流量/套餐到期/导航页)已从 nodes 过滤',
    !sub.nodes.some((n) => /^(剩余流量|套餐到期|导航页)/u.test(n.name)),
    `pseudoNodeCount=${sub.info.pseudoNodeCount}`,
  )
  const reparsed = parseClashYaml(sub.clashYaml)
  check(
    'clashYaml 可再次解析',
    reparsed.proxies.length >= sub.nodes.length,
    `${reparsed.proxies.length} proxies / ${reparsed.groups.length} groups / ${reparsed.rules.length} rules`,
  )
  check(
    '订阅信息含流量/到期字段',
    sub.info.totalBytes != null && sub.info.expireAtIso != null,
    `total=${sub.info.totalBytes} expire=${sub.info.expireAtIso} interval=${sub.info.updateIntervalHours}h`,
  )

  // 2) runtime config -------------------------------------------------
  mixedPort = await pickFreePort(PORT_RANGE[0], PORT_RANGE[1])
  for (let i = 0; i < 50; i += 1) {
    controllerPort = await pickFreePort(PORT_RANGE[0], PORT_RANGE[1])
    if (controllerPort !== mixedPort) break
  }
  check('端口选择', mixedPort !== controllerPort, `mixed=${mixedPort} controller=${controllerPort}`)

  tempDir = createTempDir()
  const dataDir = path.join(tempDir, 'data')
  const configPath = path.join(dataDir, 'config.yaml')
  const runtimeYaml = buildRuntimeConfig({
    yaml: sub.clashYaml,
    mixedPort,
    controllerPort,
    secret: SECRET,
    mode: 'global',
    logLevel: 'warning',
  })
  const runtimeDoc = parseYaml(runtimeYaml)
  check(
    'buildRuntimeConfig 覆盖正确',
    runtimeDoc['mixed-port'] === mixedPort &&
      runtimeDoc['external-controller'] === `127.0.0.1:${controllerPort}` &&
      runtimeDoc.secret === SECRET &&
      runtimeDoc.mode === 'global' &&
      runtimeDoc['geo-auto-update'] === false &&
      runtimeDoc['geodata-mode'] === false &&
      runtimeDoc.dns?.listen === '' &&
      runtimeDoc['allow-lan'] === false &&
      runtimeDoc['bind-address'] === '127.0.0.1' &&
      runtimeDoc.profile?.['store-selected'] === false &&
      runtimeDoc.profile?.['store-fake-ip'] === false &&
      runtimeDoc.proxies.length === reparsed.proxies.length,
    `config ${Buffer.byteLength(runtimeYaml, 'utf8')}B, proxies=${runtimeDoc.proxies.length}, ` +
      `profile=${JSON.stringify(runtimeDoc.profile)}`,
  )

  // 3) engine start ---------------------------------------------------
  engine = new MihomoEngine({ binaryPath, dataDir, configPath, log: () => {} })
  const startStarted = Date.now()
  const status = await engine.start(runtimeYaml)
  startedPid = status.pid
  check(
    'mihomo 启动就绪',
    status.running === true && status.version != null,
    `pid=${status.pid} version=${status.version} ${Date.now() - startStarted}ms`,
  )
  note('mihomo status', JSON.stringify(status))

  // 4) health through mixed port -------------------------------------
  const health1 = await engine.health(DELAY_PROBE_URL, 10000)
  check('health 经本地 mixed 端口连通', health1.ok, JSON.stringify(health1))
  const cacheWarnings = engine.logs(200).filter((line) => /cache\s*file|cachefile/i.test(line))
  check(
    'mihomo 无 CacheFile 告警（profile.store-* 已关闭）',
    cacheWarnings.length === 0,
    cacheWarnings[0] ?? 'clean',
  )

  // 5) controller API / proxies --------------------------------------
  const proxies = await engine.proxies()
  console.log(
    `proxies(): groups=${proxies.groups.length} nodes=${proxies.nodes.length} GLOBAL.now=${proxies.global.now}`,
  )
  console.log(
    '  groups: ' +
      proxies.groups
        .slice(0, 6)
        .map((g) => `${g.name}(${g.type})`)
        .join(' | ') +
      (proxies.groups.length > 6 ? ' | …' : ''),
  )
  check('proxies() 返回组/节点/GLOBAL', proxies.groups.length > 0 && proxies.nodes.length > 0, `groups=${proxies.groups.length} nodes=${proxies.nodes.length}`)

  // 6) switch GLOBAL to a REALITY node ------------------------------
  const realityNodes = sub.nodes.filter((n) => n.type === 'vless')
  let target = realityNodes.find((n) => /美国01/u.test(n.name)) || realityNodes[0]
  check('找到 REALITY 目标节点', Boolean(target), target?.name)
  await engine.selectGlobal(target.name)
  const afterSwitch = await engine.proxies()
  check('selectGlobal 生效', afterSwitch.global.now === target.name, `GLOBAL.now=${afterSwitch.global.now}`)

  // 7) delay (retry a few REALITY nodes if the first one is cold) ----
  let delay = await engine.delay(target.name, DELAY_PROBE_URL, 10000)
  console.log(`delay(${target.name}): ${JSON.stringify(delay)}`)
  let attempt = 1
  for (let i = 1; i < realityNodes.length && !delay.ok && attempt < 4; i += 1) {
    target = realityNodes[i]
    attempt += 1
    await engine.selectGlobal(target.name)
    delay = await engine.delay(target.name, DELAY_PROBE_URL, 10000)
    console.log(`delay retry(${target.name}): ${JSON.stringify(delay)}`)
  }
  check('REALITY 节点 delay 正常', delay.ok, delay.ok ? `${delay.delay}ms` : String(delay.error))
  if (delay.ok) {
    const health2 = await engine.health(DELAY_PROBE_URL, 10000)
    check('切换 REALITY 节点后 health ok', health2.ok, JSON.stringify(health2))
  }

  // 8) HTTPS through the proxy: api.deepseek.com must answer 401 ----
  const probe = await probeThroughProxy(mixedPort, DEEPSEEK_PROBE_URL, 20000)
  console.log(
    'probeThroughProxy(mixed): ' +
      JSON.stringify({
        ok: probe.ok,
        status: probe.status,
        ms: probe.ms,
        error: probe.error,
        head: probe.head ? probe.head.slice(0, 120) : undefined,
      }),
  )
  check(
    `经代理请求 ${DEEPSEEK_PROBE_URL} 返回 ${EXPECTED_PROBE_STATUS}`,
    probe.status === EXPECTED_PROBE_STATUS,
    `status=${probe.status}${probe.error ? ` error=${probe.error}` : ''}`,
  )

  // 9) config reload (informational; not part of the pass gate) ------
  try {
    await engine.reload(runtimeYaml)
    note('reload() 可用', 'PUT /configs?force=true ok')
  } catch (err) {
    note('reload() 不可用（不影响核心验收）', err.message)
  }

  // 10) stop is asserted in cleanup()
}

async function cleanup() {
  console.log('\n---- cleanup ----')
  if (engine) {
    try {
      if (engine.isRunning()) await engine.stop()
      check('mihomo 已停止', !engine.isRunning(), 'isRunning() === false')
    } catch (err) {
      fail('mihomo 停止失败', err.message)
    }
  }
  if (startedPid != null) {
    let alive = processExists(startedPid)
    if (alive) {
      // process.kill works even when spawning taskkill is denied (sandboxed
      // agent environments); taskkill is only the tree-cleanup fallback.
      try {
        process.kill(startedPid, 'SIGKILL')
      } catch {
        try {
          spawnSync('taskkill', ['/PID', String(startedPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        } catch {
          /* ignore */
        }
      }
      await sleep(800)
      alive = processExists(startedPid)
    }
    check('无残留 mihomo 进程', !alive, `pid=${startedPid}`)
  }
  if (mixedPort != null) {
    const mixedOpen = await portOpen('127.0.0.1', mixedPort, 500)
    check('mixed 端口已释放', !mixedOpen, `127.0.0.1:${mixedPort}`)
  }
  if (controllerPort != null) {
    const controllerOpen = await portOpen('127.0.0.1', controllerPort, 500)
    check('controller 端口已释放', !controllerOpen, `127.0.0.1:${controllerPort}`)
  }
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
      pass('临时目录已清理', tempDir)
    } catch (err) {
      fail('临时目录清理失败', err.message)
    }
  }
  for (const name of ['_scratch-runtime.yaml']) {
    try {
      fs.rmSync(path.join(ENGINE_DIR, name), { force: true })
    } catch {
      /* ignore */
    }
  }
}

function summarize() {
  console.log('\n==== selftest summary ====')
  for (const step of steps) {
    if (!step.ok) console.log(`FAILED: ${step.name}${step.detail ? ` — ${step.detail}` : ''}`)
  }
  const checked = steps.filter((s) => !s.soft).length
  const passedCount = steps.filter((s) => !s.soft && s.ok).length
  console.log(`checks: ${passedCount}/${checked} passed${steps.some((s) => s.soft) ? ' (plus informational)' : ''}`)
  if (hardFailure) {
    console.log('SELFTEST FAILED')
    process.exitCode = 1
  } else {
    console.log('SELFTEST PASSED')
    process.exitCode = 0
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function createTempDir() {
  const candidates = [
    path.join(os.tmpdir(), `dsh-vpn-selftest-${process.pid}-${Date.now()}`),
    path.join(ENGINE_DIR, '.selftest-tmp'),
  ]
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true })
      const probe = path.join(candidate, '.write-probe')
      fs.writeFileSync(probe, 'ok')
      fs.rmSync(probe, { force: true })
      return candidate
    } catch {
      /* try next candidate */
    }
  }
  throw new Error('无法创建自测临时目录')
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function portOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    let done = false
    const finish = (open) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(open)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(true))
    sock.once('error', () => finish(false))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ------------------------------------------------------------------ */
/* entry                                                               */
/* ------------------------------------------------------------------ */

try {
  await main()
} catch (err) {
  hardFailure = true
  console.error('\nSELFTEST ERROR:', err?.stack || err)
  if (engine) {
    try {
      const tail = engine.logs(25)
      if (tail.length > 0) console.error(`---- mihomo log tail ----\n${tail.join('\n')}`)
    } catch {
      /* ignore */
    }
  }
} finally {
  try {
    await cleanup()
  } catch (err) {
    hardFailure = true
    console.error('CLEANUP ERROR:', err?.stack || err)
  }
  summarize()
}
