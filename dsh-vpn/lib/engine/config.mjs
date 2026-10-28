// dsh-vpn engine — path resolution, runtime config generation, port picker.
//
// No external dependencies, only node: built-ins.

import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the dsh-vpn plugin root (…/dsh-plugins/dsh-vpn). */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Resolve the bundled mihomo binary and the engine data directory.
 *
 * @param {{ profileDir?: string, dataDir?: string, binaryPath?: string }} [opts]
 *   - binaryPath: explicit override (default: <plugin>/bin/mihomo.exe)
 *   - dataDir:    explicit override (default: <profileDir>/vpn, else <plugin>/data)
 *   - profileDir: DSH profile directory; engine keeps its mihomo home under <profileDir>/vpn
 * @returns {{ binaryPath: string, dataDir: string }}
 */
export function resolvePaths({ profileDir, dataDir, binaryPath } = {}) {
  const resolvedBinary = binaryPath ? path.resolve(binaryPath) : path.join(PLUGIN_ROOT, 'bin', 'mihomo.exe')
  let resolvedData
  if (dataDir) resolvedData = path.resolve(dataDir)
  else if (profileDir) resolvedData = path.resolve(profileDir, 'vpn')
  else resolvedData = path.join(PLUGIN_ROOT, 'data')
  return { binaryPath: resolvedBinary, dataDir: resolvedData }
}

const OVERRIDES = [
  ['mixed-port', (o) => `mixed-port: ${assertPort(o.mixedPort, 'mixedPort')}`],
  ['allow-lan', () => 'allow-lan: false'],
  ['bind-address', () => "bind-address: '127.0.0.1'"],
  ['external-controller', (o) => `external-controller: '127.0.0.1:${assertPort(o.controllerPort, 'controllerPort')}'`],
  ['secret', (o) => `secret: '${escapeSingleQuote(o.secret ?? '')}'`],
  ['mode', (o) => `mode: ${assertEnum(o.mode ?? 'rule', ['rule', 'global', 'direct'], 'mode')}`],
  [
    'log-level',
    (o) => `log-level: ${assertEnum(o.logLevel ?? 'warning', ['silent', 'error', 'warning', 'info', 'debug'], 'logLevel')}`,
  ],
  ['geo-auto-update', () => 'geo-auto-update: false'],
  ['geodata-mode', () => 'geodata-mode: false'],
]

/**
 * Overlay runtime settings on a Clash subscription YAML.
 *
 * Only the listed top-level keys are overridden / added; every other byte of the
 * subscription (proxies, proxy-groups, rules, dns internals, …) is preserved.
 * `dns.listen` is forced to an empty string so mihomo never binds 0.0.0.0:1053
 * (which would collide with a user-installed Clash Verge).
 *
 * @param {{ yaml: string, mixedPort: number, controllerPort: number, secret?: string,
 *           mode?: 'rule'|'global'|'direct', logLevel?: string }} opts
 * @returns {string}
 */
export function buildRuntimeConfig({ yaml, mixedPort, controllerPort, secret = '', mode = 'rule', logLevel = 'warning' } = {}) {
  if (typeof yaml !== 'string' || yaml.trim() === '') {
    throw new Error('buildRuntimeConfig: yaml must be a non-empty string')
  }
  if (!/(^|\n)proxies\s*:/.test(yaml)) {
    throw new Error('buildRuntimeConfig: yaml 中没有 proxies: 段（需要 Clash / mihomo 格式订阅配置）')
  }

  const values = { mixedPort, controllerPort, secret, mode, logLevel }
  const pending = new Map()
  for (const [key, render] of OVERRIDES) pending.set(key, render(values))

  const src = yaml.replace(/\r\n?/g, '\n')
  const lines = src.split('\n')
  const out = []

  // dns.listen must be '' (otherwise mihomo binds 0.0.0.0:1053 and can collide
  // with a user installed Clash Verge).
  // profile.store-selected / store-fake-ip must be false (otherwise mihomo tries
  // to write <dataDir>/cache.db; if that directory is read-only for the host
  // process it logs "[CacheFile] can't open cache file: ... Access is denied").
  // Both blocks are merged in place: other child keys of an existing block are
  // preserved, existing store-* / listen lines are rewritten instead of
  // duplicated.
  const dns = { everSeen: false, open: false, listenSet: false, childIndent: '' }
  const profile = { everSeen: false, open: false, childIndent: '', seen: new Set() }
  const PROFILE_KEYS = ['store-selected', 'store-fake-ip']

  const closeOpenBlocks = () => {
    if (dns.open && !dns.listenSet) {
      out.push(`${dns.childIndent || '    '}listen: ''`)
      dns.listenSet = true
    }
    if (profile.open) {
      for (const key of PROFILE_KEYS) {
        if (!profile.seen.has(key)) out.push(`${profile.childIndent || '    '}${key}: false`)
      }
    }
  }

  for (const line of lines) {
    const top = /^([A-Za-z0-9_.-]+)\s*:/.exec(line)
    if (top) {
      const key = top[1]
      closeOpenBlocks()
      dns.open = key === 'dns'
      if (dns.open) {
        dns.everSeen = true
        dns.listenSet = false
        dns.childIndent = ''
      }
      profile.open = key === 'profile'
      if (profile.open) {
        profile.everSeen = true
        profile.seen = new Set()
        profile.childIndent = ''
      }
      if (pending.has(key)) {
        out.push(pending.get(key))
        pending.delete(key)
        continue
      }
      out.push(line)
      continue
    }

    if (dns.open) {
      const listen = /^(\s+)listen\s*:/.exec(line)
      if (listen) {
        out.push(`${listen[1]}listen: ''`)
        dns.listenSet = true
        if (!dns.childIndent) dns.childIndent = listen[1]
        continue
      }
      const child = /^(\s+)\S/.exec(line)
      if (child && !dns.childIndent) dns.childIndent = child[1]
    }
    if (profile.open) {
      const store = /^(\s+)(store-selected|store-fake-ip)\s*:/.exec(line)
      if (store) {
        out.push(`${store[1]}${store[2]}: false`)
        profile.seen.add(store[2])
        if (!profile.childIndent) profile.childIndent = store[1]
        continue
      }
      const child = /^(\s+)\S/.exec(line)
      if (child && !profile.childIndent) profile.childIndent = child[1]
    }
    out.push(line)
  }

  closeOpenBlocks()
  if (!dns.everSeen) out.push('dns:', "    listen: ''")
  if (!profile.everSeen) out.push('profile:', '    store-selected: false', '    store-fake-ip: false')

  for (const key of OVERRIDES.map(([k]) => k)) {
    if (pending.has(key)) out.push(pending.get(key))
  }

  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return `${out.join('\n')}\n`
}

/**
 * Find a free TCP port in [start, end] on 127.0.0.1.
 * @param {number} [start=18000]
 * @param {number} [end=18999]
 * @returns {Promise<number>}
 */
export async function pickFreePort(start = 18000, end = 18999) {
  const lo = Number(start)
  const hi = Number(end)
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi > 65535 || lo > hi) {
    throw new Error(`pickFreePort: 端口范围非法 (${start}-${end})`)
  }
  const span = hi - lo + 1
  const offset = Math.floor(Math.random() * span)
  for (let i = 0; i < span; i += 1) {
    const port = lo + ((offset + i) % span)
    if (await canBind(port)) return port
  }
  throw new Error(`pickFreePort: ${lo}-${hi} 范围内没有可用端口`)
}

/* ------------------------------------------------------------------ */

function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      srv.close(() => resolve(true))
    })
  })
}

function assertPort(value, name) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`buildRuntimeConfig: ${name} 必须是 1-65535 的整数，收到 ${JSON.stringify(value)}`)
  }
  return n
}

function assertEnum(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new Error(`buildRuntimeConfig: ${name} 必须是 ${allowed.join('|')} 之一，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function escapeSingleQuote(value) {
  return String(value).replace(/'/g, "''")
}
