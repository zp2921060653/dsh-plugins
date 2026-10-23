// Standalone smoke test for the dsh-browser engine (no DSH plugin host needed).
// Run: node dev/smoke.mjs
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager } from '../lib/browser.js'
import { runBrowserAction, runReadAction } from '../lib/actions.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = path.join(here, '.run')
fs.mkdirSync(work, { recursive: true })

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Smoke 测试页</title>
<meta name="description" content="dsh-browser smoke test">
</head><body>
<nav><a href="/other">Other page</a></nav>
<h1>Hello Browser</h1>
<main id="app"><p>Server-rendered placeholder.</p></main>
<input id="q" placeholder="search" />
<button id="btn">Load data</button>
<div id="out"></div>
<script>
  console.log('page booted')
  document.querySelector('#btn').addEventListener('click', async () => {
    const r = await fetch('/api/data')
    const j = await r.json()
    document.querySelector('#app').innerHTML = '<h2>Items</h2><ul>' + j.items.map(i => '<li>' + i.name + '</li>').join('') + '</ul>'
    document.querySelector('#out').textContent = 'loaded ' + j.items.length
  })
  fetch('/api/data?auto=1').then(r => r.json()).then(j => { window.__auto = j.items.length })
  fetch('/api/fail').catch(() => {})
</script>
</body></html>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  if (url.pathname === '/other') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><head><title>Other</title></head><body><h1>Other page</h1></body></html>')
    return
  }
  if (url.pathname === '/api/data') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ items: [{ name: 'Alpha' }, { name: 'Beta' }], ts: Date.now() }))
    return
  }
  if (url.pathname === '/api/fail') {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'boom' }))
    return
  }
  res.writeHead(404).end('nope')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}/`

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const manager = new BrowserManager({
  headless: true,
  userDataDir: path.join(work, 'profile'),
  defaultTimeoutMs: 20000,
  downloadDir: path.join(work, 'downloads'),
})
const ctx = { manager, cwd: work }

try {
  const status0 = manager.status()
  check('initial status', status0.running === false)

  const page = await manager.openPage(base)
  check('browser launched + page attached', !!page, manager.exe)

  const read1 = await runReadAction('read', { mode: 'main' }, ctx)
  check('read main', read1.text.includes('Server-rendered placeholder'), JSON.stringify(read1.text.slice(0, 60)))

  const md = await runReadAction('read', { mode: 'markdown' }, ctx)
  check('read markdown has link', /\[Other page\]\(http/.test(md.text), md.text.split('\n')[0])

  const meta = await runReadAction('read', { mode: 'meta' }, ctx)
  check('read meta description', meta.text.includes('smoke test'))

  const interactive = await runReadAction('read', { mode: 'interactive' }, ctx)
  check('interactive lists button+input', /Load data/.test(interactive.text) && /search/.test(interactive.text), interactive.text.split('\n').slice(0, 3).join(' | '))

  const net = await runReadAction('network', { filter: 'api/', limit: 20 }, ctx)
  const dataReq = (net.requests || []).find((r) => r.url.includes('/api/data'))
  check('network captured /api/data', !!dataReq && dataReq.status === 200, dataReq && dataReq.id)
  const failReq = (net.requests || []).find((r) => r.url.includes('/api/fail'))
  check('network captured 500', !!failReq && failReq.status === 500)
  check('network body captured', !!dataReq && dataReq.hasBody === true)

  if (dataReq) {
    const body = await runReadAction('network', { id: dataReq.id }, ctx)
    check('network body json', /"Alpha"/.test(body.text), body.text.slice(0, 50))
  }

  const consoleOut = await runReadAction('console', {}, ctx)
  check('console captured log', consoleOut.text.includes('page booted'))

  const clickRes = await runBrowserAction('click', { text: 'Load data' }, ctx)
  check('click by text', clickRes.ok === true, clickRes.text)
  await new Promise((r) => setTimeout(r, 400))
  const read2 = await runReadAction('read', { mode: 'main' }, ctx)
  check('DOM updated after click', read2.text.includes('Alpha') && !read2.text.includes('Hello Browser'), read2.text.slice(0, 80))

  const typed = await runBrowserAction('type', { selector: '#q', text: 'hello world' }, ctx)
  const value = await runBrowserAction('eval', { script: 'document.querySelector("#q").value' }, ctx)
  check('type into input', value.text.includes('hello world'), typed.text)

  const evalRes = await runBrowserAction('eval', { script: '({ n: window.__auto, title: document.title })' }, ctx)
  check('eval returns object', /"n": 2|"n":2/.test(evalRes.text), evalRes.text.slice(0, 60))

  const shot = await runBrowserAction('screenshot', { path: 'shots/main.png', fullPage: true }, ctx)
  check('screenshot saved', fs.existsSync(shot.path) && fs.statSync(shot.path).size > 1000, shot.path + ' ' + shot.bytes + 'B')

  const elShot = await runBrowserAction('screenshot', { selector: 'main', path: 'shots/main-el.png' }, ctx)
  check('element screenshot', fs.existsSync(elShot.path), elShot.size ? JSON.stringify(elShot.size) : '')

  const ax = await runReadAction('read', { mode: 'ax' }, ctx)
  check('ax tree', /button/.test(ax.text), ax.text.split('\n').slice(0, 3).join(' | '))

  const links = await runReadAction('read', { mode: 'link' }, ctx)
  check('link list', links.text.includes('/other'), links.text.split('\n')[0])

  const fetchRes = await runReadAction('fetch', { url: '/api/data?manual=1' }, ctx)
  check('page fetch', /"Alpha"/.test(fetchRes.text) && fetchRes.status === 200, String(fetchRes.status))

  const cookies = await runReadAction('cookies', { op: 'set', cookies: [{ name: 'k', value: 'v', url: base }] }, ctx)
  const got = await runReadAction('cookies', {}, ctx)
  check('cookie set/get', got.text.includes('k=v'), cookies.text)

  const nav = await runBrowserAction('goto', { url: base + 'other' }, ctx)
  check('goto', /Other/.test(nav.title + nav.url), nav.title)
  const back = await runBrowserAction('back', {}, ctx)
  check('back', back.ok === true, back.url)

  const tabs = await runBrowserAction('tabs', {}, ctx)
  check('tabs list', tabs.tabs.length >= 1, tabs.text.split('\n')[0])

  const vp = await runBrowserAction('viewport', { width: 800, height: 600 }, ctx)
  check('viewport', vp.ok === true, vp.text)

  const waited = await runBrowserAction('wait', { selector: '#btn' }, ctx)
  check('wait selector', waited.ok === true, waited.text)

  const second = await manager.openPage(base + 'other')
  const tabs2 = await runBrowserAction('tabs', {}, ctx)
  check('second tab', tabs2.tabs.length === 2, tabs2.text)

  const closeRes = await runBrowserAction('close', { tab: second.targetId.slice(0, 8) }, ctx)
  check('close tab', closeRes.ok === true, closeRes.text)
} catch (err) {
  console.error('FATAL', err)
  check('no fatal', false, err.message)
} finally {
  try { await manager.closeBrowser() } catch { /* ignore */ }
  server.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}
