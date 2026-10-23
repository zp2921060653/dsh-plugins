// Action layer: every browser operation exposed to the model, implemented on
// top of the BrowserManager/Page primitives.

import fs from 'node:fs'
import path from 'node:path'
import { evalScript } from './page-lib.js'
import { sleep } from './cdp.js'

const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
}

function truncate(value, max) {
  if (typeof value !== 'string') value = JSON.stringify(value)
  if (!max || value.length <= max) return value
  return value.slice(0, max) + '\n… [截断，原长 ' + value.length + ' 字符]'
}

function js(value) {
  return JSON.stringify(value == null ? '' : String(value))
}

/** Expression yielding the element addressed by `selector` / `text` / focus. */
function targetExpr(args) {
  const selector = args.selector != null && String(args.selector).trim() !== '' ? String(args.selector) : ''
  const text = args.text != null && String(args.text).trim() !== '' ? String(args.text) : ''
  const index = Number.isInteger(args.index) ? args.index : 0
  if (selector) return `__dsh.pick(${js(selector)})`
  if (text) return `__dsh.findByText(${js(text)}, { index: ${index} })`
  return 'document.activeElement'
}

function describeTarget(args) {
  if (args.selector) return 'selector ' + args.selector
  if (args.text) return 'text "' + args.text + '"' + (args.index ? ' (#' + args.index + ')' : '')
  return '当前焦点元素'
}

async function resolvePage(ctx, args) {
  const page = await ctx.manager.requirePage(args.tab)
  return page
}

/** Poll one predicate inside the page until it is truthy. */
async function pollInPage(page, expression, timeoutMs, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await page.eval(expression, { awaitPromise: false, timeout: 3000 })
      if (value) return value
      lastError = null
    } catch (err) {
      lastError = err
    }
    await sleep(intervalMs)
  }
  if (lastError) throw lastError
  return null
}

async function navigateAndWait(page, url, waitUntil) {
  const result = await page.send('Page.navigate', { url })
  if (result.errorText) throw new Error('导航失败: ' + result.errorText)
  await page.waitForReady({ until: waitUntil })
  await sleep(150)
  page.url = await page.eval('location.href', { awaitPromise: false }).catch(() => page.url)
  page.title = await page.eval('document.title', { awaitPromise: false }).catch(() => page.title)
  return page
}

export async function runBrowserAction(action, args, ctx) {
  const manager = ctx.manager
  const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : ctx.manager.config.defaultTimeoutMs

  switch (action) {
    case 'status': {
      const status = manager.status()
      return {
        ok: true,
        text:
          (status.running ? '浏览器运行中' : '浏览器未启动') +
          (status.exe ? '\n可执行文件: ' + status.exe + (status.exeSource ? ' (' + status.exeSource + ')' : '') : '') +
          (status.browser ? '\n版本: ' + status.browser : '') +
          (status.headless ? '\n模式: headless' : '\n模式: 有窗口') +
          '\n标签页: ' + status.tabs.length +
          (status.tabs.length ? '\n' + status.tabs.map((t, i) => `  ${i + 1}. ${t.title || '(无标题)'} — ${t.url}${t.active ? ' [active]' : ''}`).join('\n') : ''),
        ...status,
      }
    }

    case 'open': {
      const url = String(args.url || '')
      if (args.tab) {
        const page = await resolvePage(ctx, args)
        await navigateAndWait(page, url, args.waitUntil)
        manager.touch(page)
        return { ok: true, tab: page.targetId.slice(0, 8), url: page.url, title: page.title, text: `已导航到 ${page.url}` }
      }
      const page = await manager.openPage(url || 'about:blank')
      await page.waitForReady({ until: args.waitUntil || 'load', timeoutMs })
      await sleep(150)
      page.url = await page.eval('location.href', { awaitPromise: false }).catch(() => page.url)
      page.title = await page.eval('document.title', { awaitPromise: false }).catch(() => page.title)
      manager.touch(page)
      return { ok: true, tab: page.targetId.slice(0, 8), url: page.url, title: page.title, text: `已打开新标签页 ${page.url}` }
    }

    case 'goto': {
      const page = await resolvePage(ctx, args)
      if (!args.url) throw new Error('goto 需要 url')
      await navigateAndWait(page, String(args.url), args.waitUntil)
      manager.touch(page)
      return { ok: true, tab: page.targetId.slice(0, 8), url: page.url, title: page.title, text: `已导航到 ${page.url}` }
    }

    case 'back':
    case 'forward': {
      const page = await resolvePage(ctx, args)
      const history = await page.send('Page.getNavigationHistory')
      const next = history.entries[history.currentIndex + (action === 'back' ? -1 : 1)]
      if (!next) throw new Error(action === 'back' ? '没有上一页' : '没有下一页')
      await page.send('Page.navigateToHistoryEntry', { entryId: next.id })
      await page.waitForReady({ until: args.waitUntil })
      page.url = await page.eval('location.href', { awaitPromise: false }).catch(() => page.url)
      page.title = await page.eval('document.title', { awaitPromise: false }).catch(() => page.title)
      return { ok: true, url: page.url, title: page.title, text: `${action === 'back' ? '后退' : '前进'}到 ${page.url}` }
    }

    case 'reload': {
      const page = await resolvePage(ctx, args)
      await page.send('Page.reload', { ignoreCache: !!args.noCache })
      await page.waitForReady({ until: args.waitUntil })
      return { ok: true, url: page.url, title: page.title, text: `已刷新 ${page.url}` }
    }

    case 'tabs': {
      await manager.ensure().catch(() => {})
      const tabs = manager.listPages().map((p, i) => ({ index: i + 1, tab: p.targetId.slice(0, 8), title: p.title, url: p.url, active: p.sessionId === manager.activeSessionId }))
      return {
        ok: true,
        tabs,
        text: tabs.length ? tabs.map((t) => `${t.index}. ${t.active ? '* ' : ''}${t.title || '(无标题)'} — ${t.url} [${t.tab}]`).join('\n') : '(没有标签页)',
      }
    }

    case 'activate': {
      const page = manager.page(args.tab)
      if (!page) throw new Error('找不到标签页: ' + args.tab)
      manager.touch(page)
      return { ok: true, url: page.url, title: page.title, text: '已切换到 ' + page.url }
    }

    case 'close': {
      const page = await resolvePage(ctx, args)
      await manager.closePage(page)
      return { ok: true, text: '已关闭标签页 ' + (page.url || page.targetId.slice(0, 8)) }
    }

    case 'close_browser': {
      await manager.closeBrowser()
      return { ok: true, text: '浏览器已关闭' }
    }

    case 'click': {
      const page = await resolvePage(ctx, args)
      const force = !!args.force
      const info = await page.eval(evalScript(`
        const el = ${targetExpr(args)};
        if (!el) {
          const hint = ${js(args.text || '')} ? __dsh.byText(${js(args.text || '')}, { limit: 8 }).map((e) => __dsh.describe(e)) : [];
          return { found: false, hint };
        }
        if (!el.scrollIntoView) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height), name: __dsh.nameOf(el).slice(0, 100), tag: el.tagName.toLowerCase(), selector: __dsh.cssPath(el), disabled: !!el.disabled, coveredNote: null };
      `))
      if (!info.found) {
        const hint = (info.hint || []).map((h) => `  - <${h.tag}> "${h.name}" ${h.selector}`).join('\n')
        throw new Error('找不到要点击的元素（' + describeTarget(args) + '）' + (hint ? '\n页面中相近的可点击元素：\n' + hint : '') + '\n提示：先用 browser_read 的 read 动作，mode=interactive 列出可点击元素。')
      }
      if (force) {
        await page.eval(evalScript(`const el = ${targetExpr(args)}; if (el) el.click(); return true;`))
      } else {
        const button = args.button === 'right' ? 'right' : args.button === 'middle' ? 'middle' : 'left'
        const x = Math.round(info.x)
        const y = Math.round(info.y)
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
        const count = args.double ? 2 : 1
        for (let i = 1; i <= count; i++) {
          await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i })
          await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i })
        }
      }
      await sleep(Number(args.settleMs) || 350)
      const after = await page.eval(evalScript('return { url: location.href, title: document.title }'), { awaitPromise: false }).catch(() => ({}))
      const best = await page.eval(evalScript(`return __dsh.describe(${targetExpr(args)})`), { awaitPromise: false }).catch(() => null)
      return {
        ok: true,
        clicked: { tag: info.tag, name: info.name, selector: info.selector || (best && best.selector) || '' },
        url: after.url || page.url,
        title: after.title || page.title,
        text: `已点击 <${info.tag}> "${info.name}"` + (after.url && after.url !== page.url ? ' → ' + after.url : ''),
      }
    }

    case 'type': {
      const page = await resolvePage(ctx, args)
      const text = String(args.text == null ? '' : args.text)
      const focused = await page.eval(evalScript(`
        const el = ${targetExpr(args)};
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        if (${args.clear !== false ? 'true' : 'false'}) __dsh.focusSelect(el);
        else { el.focus(); if (typeof el.setSelectionRange === 'function') { try { const n = String(el.value == null ? '' : el.value).length; el.setSelectionRange(n, n); } catch (e) {} } }
        const r = el.getBoundingClientRect();
        return { found: true, tag: el.tagName.toLowerCase(), name: __dsh.nameOf(el).slice(0, 80), x: r.left + r.width / 2, y: r.top + r.height / 2, selector: __dsh.cssPath(el) };
      `))
      if (!focused.found) throw new Error('找不到输入元素（' + describeTarget(args) + '）')
      if (args.clickFirst) {
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(focused.x), y: Math.round(focused.y), button: 'left', clickCount: 1 })
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(focused.x), y: Math.round(focused.y), button: 'left', clickCount: 1 })
        await sleep(60)
      }
      if (args.clear !== false && text === '' ) { /* select() already cleared */ }
      if (text) {
        if (Number(args.delay) > 0) {
          for (const ch of text) {
            await page.send('Input.insertText', { text: ch })
            await sleep(Number(args.delay))
          }
        } else {
          await page.send('Input.insertText', { text })
        }
      }
      if (args.submit) {
        await pressKey(page, 'Enter')
        await sleep(Number(args.settleMs) || 400)
      }
      const readBack = focused.selector
        ? `const el = __dsh.pick(${js(focused.selector)});`
        : `const el = document.activeElement;`
      const value = await page.eval(evalScript(`${readBack} if (!el) return null; return el.isContentEditable ? (el.innerText || '').slice(0, 200) : String(el.value == null ? '' : el.value).slice(0, 200);`), { awaitPromise: false }).catch(() => null)
      return { ok: true, element: focused, value, text: `已输入到 <${focused.tag}> "${focused.name || focused.selector}"` + (args.submit ? '，并按下 Enter' : '') }
    }

    case 'press': {
      const page = await resolvePage(ctx, args)
      const times = Math.max(1, Math.min(50, Number(args.times) || 1))
      for (let i = 0; i < times; i++) {
        await pressKey(page, String(args.key || 'Enter'), args.modifiers)
        await sleep(60)
      }
      await sleep(Number(args.settleMs) || 200)
      return { ok: true, text: `已按键 ${args.key}${times > 1 ? ' ×' + times : ''}` }
    }

    case 'hover': {
      const page = await resolvePage(ctx, args)
      const info = await page.eval(evalScript(`
        const el = ${targetExpr(args)};
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, name: __dsh.nameOf(el).slice(0, 80) };
      `))
      if (!info.found) throw new Error('找不到要悬停的元素（' + describeTarget(args) + '）')
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(info.x), y: Math.round(info.y) })
      await sleep(Number(args.settleMs) || 300)
      return { ok: true, text: '已悬停 "' + info.name + '"' }
    }

    case 'scroll': {
      const page = await resolvePage(ctx, args)
      if (args.to === 'top') {
        await page.eval('window.scrollTo({ top: 0, behavior: "instant" }); true', { awaitPromise: false })
        return { ok: true, text: '已滚动到顶部' }
      }
      if (args.to === 'bottom') {
        await page.eval('window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }); true', { awaitPromise: false })
        return { ok: true, text: '已滚动到底部' }
      }
      if (args.selector || args.text) {
        const found = await page.eval(evalScript(`const el = ${targetExpr(args)}; if (!el) return false; el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); return true;`))
        if (!found) throw new Error('找不到要滚动到的元素（' + describeTarget(args) + '）')
        return { ok: true, text: '已滚动到目标元素' }
      }
      const dy = Number(args.dy) || Math.round(600)
      const dx = Number(args.dx) || 0
      const rect = await page.eval('({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })', { awaitPromise: false })
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: dx, deltaY: dy, pointerType: 'mouse' })
      await sleep(Number(args.settleMs) || 300)
      const pos = await page.eval('({ y: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight) })', { awaitPromise: false }).catch(() => null)
      return { ok: true, scrollPosition: pos, text: '已滚动' + (dy > 0 ? '向下' : '向上') + ' ' + Math.abs(dy) + 'px' }
    }

    case 'wait': {
      const page = await resolvePage(ctx, args)
      const started = Date.now()
      if (args.ms) {
        await sleep(Math.min(120000, Number(args.ms)))
        return { ok: true, waitedMs: Date.now() - started, text: '已等待 ' + args.ms + 'ms' }
      }
      if (args.selector) {
        const hit = await pollInPage(page, evalScript(`const el = __dsh.pick(${js(args.selector)}); return el && __dsh.vis(el) ? __dsh.describe(el) : null;`), timeoutMs)
        if (!hit) throw new Error('等待超时：选择器 ' + args.selector + ' 未在 ' + timeoutMs + 'ms 内出现')
        return { ok: true, element: hit, waitedMs: Date.now() - started, text: '元素已出现: ' + (hit.name || hit.selector) }
      }
      if (args.text) {
        const hit = await pollInPage(page, evalScript(`const list = __dsh.byText(${js(args.text)}, { limit: 1 }); return list.length ? __dsh.describe(list[0]) : null;`), timeoutMs)
        if (!hit) throw new Error('等待超时：文本 "' + args.text + '" 未在 ' + timeoutMs + 'ms 内出现')
        return { ok: true, element: hit, waitedMs: Date.now() - started, text: '文本已出现: ' + hit.name }
      }
      if (args.url) {
        const hit = await pollInPage(page, `location.href.includes(${js(args.url)}) && location.href`, timeoutMs)
        if (!hit) throw new Error('等待超时：URL 未包含 ' + args.url)
        return { ok: true, url: hit, waitedMs: Date.now() - started, text: 'URL 已匹配: ' + hit }
      }
      // default: network idle + readyState complete
      const deadline = Date.now() + timeoutMs
      let quiet = 0
      while (Date.now() < deadline) {
        const state = await page.eval('document.readyState', { awaitPromise: false }).catch(() => 'loading')
        if (state === 'complete' && page.pending === 0) {
          quiet += 1
          if (quiet >= 3) {
            return { ok: true, waitedMs: Date.now() - started, pendingRequests: 0, text: '页面已加载且网络空闲' }
          }
        } else {
          quiet = 0
        }
        await sleep(150)
      }
      return { ok: true, waitedMs: Date.now() - started, pendingRequests: page.pending, text: '等待超时，但未报错（仍有 ' + page.pending + ' 个请求在途）' }
    }

    case 'eval': {
      const page = await resolvePage(ctx, args)
      const script = String(args.script || '')
      if (!script) throw new Error('eval 需要 script')
      const started = Date.now()
      const value = await page.eval(script, { timeout: Number(args.timeoutMs) || 30000 })
      const json = value === undefined ? 'undefined' : (() => { try { return JSON.stringify(value, null, 2) } catch { return String(value) } })()
      return {
        ok: true,
        value: value === undefined ? null : value,
        text: truncate(json == null ? 'null' : json, Number(args.maxChars) || 20000),
        ms: Date.now() - started,
      }
    }

    case 'screenshot': {
      const page = await resolvePage(ctx, args)
      const format = args.format === 'jpeg' || args.format === 'jpg' ? 'jpeg' : 'png'
      let params = { format }
      if (format === 'jpeg') params.quality = Number(args.quality) || 80
      let clipped = null
      if (args.selector) {
        const box = await page.eval(evalScript(`
          const el = ${targetExpr(args)};
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          const r = el.getBoundingClientRect();
          return { x: r.left + scrollX, y: r.top + scrollY, width: Math.max(1, r.width), height: Math.max(1, r.height) };
        `))
        if (!box) throw new Error('找不到要截图的元素（' + describeTarget(args) + '）')
        clipped = box
        params.clip = { ...box, scale: 1 }
        params.captureBeyondViewport = true
      } else if (args.fullPage) {
        const metrics = await page.send('Page.getLayoutMetrics')
        const size = metrics.cssContentSize || metrics.contentSize
        if (size && size.width && size.height) {
          clipped = { x: 0, y: 0, width: size.width, height: size.height }
          params.clip = { ...clipped, scale: 1 }
          params.captureBeyondViewport = true
        }
      }
      const shot = await page.send('Page.captureScreenshot', params, 30000)
      const buffer = Buffer.from(shot.data, 'base64')
      const target = resolveShotPath(args.path, format, ctx.cwd)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, buffer)
      return {
        ok: true,
        path: target,
        bytes: buffer.length,
        size: clipped ? { width: Math.round(clipped.width), height: Math.round(clipped.height) } : null,
        url: page.url,
        title: page.title,
        text: `截图已保存: ${target} (${Math.round(buffer.length / 1024)} KB)` + (clipped ? ` ${Math.round(clipped.width)}x${Math.round(clipped.height)}` : '') + '\n需要看图时用 read_image 打开该路径。',
      }
    }

    case 'viewport': {
      const page = await resolvePage(ctx, args)
      const width = Number(args.width) || 1440
      const height = Number(args.height) || 900
      await page.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: Number(args.scale) || 1,
        mobile: !!args.mobile,
        screenWidth: width,
        screenHeight: height,
      })
      await sleep(150)
      return { ok: true, text: `视口已设为 ${width}x${height}` + (args.mobile ? ' (mobile)' : '') }
    }

    case 'selectOption': {
      const page = await resolvePage(ctx, args)
      const options = Array.isArray(args.values) ? args.values : [args.value]
      const result = await page.eval(evalScript(`
        const el = ${targetExpr(args)};
        if (!el || el.tagName !== 'SELECT') return { ok: false, error: '不是 select 元素' };
        const wanted = ${JSON.stringify(options.map(String))};
        for (const opt of el.options) {
          const match = wanted.includes(opt.value) || wanted.includes((opt.text || '').trim());
          opt.selected = match;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value, text: el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : el.value };
      `))
      if (!result.ok) throw new Error(result.error || '选择失败')
      await sleep(200)
      return { ok: true, value: result.value, text: '已选择 ' + result.text }
    }

    default:
      throw new Error('未知动作: ' + action)
  }
}

async function pressKey(page, key, modifiers) {
  const spec = KEYMAP[key] || (/^.$/.test(key)
    ? { key, code: /[a-zA-Z]/.test(key) ? 'Key' + key.toUpperCase() : key, text: key }
    : { key, code: key })
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode || 0,
    nativeVirtualKeyCode: spec.windowsVirtualKeyCode || 0,
    modifiers: Number(modifiers) || 0,
  }
  await page.send('Input.dispatchKeyEvent', { type: spec.text ? 'keyDown' : 'rawKeyDown', ...base, text: spec.text, unmodifiedText: spec.text })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

function resolveShotPath(requested, format, cwd) {
  const ext = format === 'jpeg' ? '.jpg' : '.png'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  if (requested && String(requested).trim()) {
    const p = String(requested).trim()
    return path.isAbsolute(p) ? p : path.join(cwd, p)
  }
  return path.join(cwd, 'browser-shots', `shot-${stamp}${ext}`)
}

// ---------------------------------------------------------------------------
// Read-side actions
// ---------------------------------------------------------------------------

function formatAxNode(node) {
  const role = (node.role && node.role.value) || ''
  const name = (node.name && node.name.value) || ''
  const value = (node.value && node.value.value) || ''
  const props = []
  for (const p of node.properties || []) {
    if (!p || !p.name) continue
    if (p.name === 'checked' || p.name === 'disabled' || p.name === 'expanded' || p.name === 'pressed' || p.name === 'selected' || p.name === 'required') {
      props.push(p.name + '=' + (p.value && p.value.value))
    }
  }
  let line = role
  if (name) line += ' "' + String(name).replace(/\s+/g, ' ').slice(0, 100) + '"'
  if (value) line += ' = ' + String(value).slice(0, 60)
  if (props.length) line += ' [' + props.join(' ') + ']'
  return line
}

export async function runReadAction(action, args, ctx) {
  const manager = ctx.manager
  switch (action) {
    case 'read': {
      const page = await resolvePage(ctx, args)
      const mode = String(args.mode || 'main')
      const maxChars = Number(args.maxChars) || 12000
      const selector = args.selector ? String(args.selector) : ''
      let text = ''
      let meta = { url: page.url, title: page.title, mode }

      if (mode === 'main') {
        text = await page.eval(evalScript(`const el = ${selector ? `__dsh.pick(${js(selector)})` : '__dsh.main()'}; if (!el) return ''; return __dsh.md(el, {});`))
      } else if (mode === 'html') {
        text = await page.eval(selector
          ? evalScript(`const el = __dsh.pick(${js(selector)}); return el ? el.outerHTML : '';`)
          : 'document.documentElement.outerHTML')
      } else if (mode === 'text') {
        text = await page.eval(evalScript(`const el = ${selector ? `__dsh.pick(${js(selector)})` : '__dsh.main()'}; if (!el) return ''; return (el.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();`))
      } else if (mode === 'markdown') {
        text = await page.eval(evalScript(`const el = ${selector ? `__dsh.pick(${js(selector)})` : 'document.body'}; if (!el) return ''; return __dsh.md(el, {});`))
      } else if (mode === 'link') {
        const links = await page.eval(evalScript(`
          const out = [];
          for (const a of document.querySelectorAll('a[href]')) {
            if (!__dsh.vis(a)) continue;
            const t = __dsh.txt(a);
            if (!t) continue;
            out.push({ text: t.slice(0, 120), href: a.href });
            if (out.length >= 200) break;
          }
          return out;
        `))
        text = links.map((l) => `- ${l.text} → ${l.href}`).join('\n')
        meta.linkCount = links.length
      } else if (mode === 'meta') {
        const info = await page.eval(evalScript(`
          const pickMeta = (sel) => { const el = document.querySelector(sel); return el ? (el.content || el.href || '') : '' };
          return {
            title: document.title,
            description: pickMeta('meta[name="description"]'),
            canonical: pickMeta('link[rel="canonical"]'),
            ogTitle: pickMeta('meta[property="og:title"]'),
            ogDescription: pickMeta('meta[property="og:description"]'),
            ogImage: pickMeta('meta[property="og:image"]'),
            lang: document.documentElement.lang || '',
            h1: Array.from(document.querySelectorAll('h1')).map((h) => __dsh.txt(h)).filter(Boolean).slice(0, 8),
            h2: Array.from(document.querySelectorAll('h2')).map((h) => __dsh.txt(h)).filter(Boolean).slice(0, 20),
            forms: document.forms.length,
            links: document.links.length,
            images: document.images.length,
          };
        `))
        text = Object.entries(info).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' / ') : v}`).join('\n')
        meta = { ...meta, ...info }
      } else if (mode === 'interactive') {
        const items = await page.eval(evalScript(`return __dsh.interactive({ limit: ${Number(args.limit) || 120} });`))
        text = items.map((it) => `${it.i}. <${it.tag}${it.type ? ' type=' + it.type : ''}> ${it.name || '(无名称)'}  [${it.selector}]`).join('\n')
        meta.items = items
      } else if (mode === 'ax') {
        const tree = await page.send('Accessibility.enable').then(() => page.send('Accessibility.getFullAXTree', { depth: Number(args.depth) || 30 }))
        const lines = []
        for (const node of tree.nodes || []) {
          if (node.ignored) continue
          const line = formatAxNode(node)
          if (!line || line === 'none' || line === 'generic' || line === 'InlineTextBox' || line === 'StaticText' && !(node.name && node.name.value)) continue
          lines.push(line)
          if (lines.length >= (Number(args.limit) || 400)) break
        }
        text = lines.join('\n')
      } else {
        throw new Error('未知 read mode: ' + mode + '（可用 main / markdown / text / html / link / meta / interactive / ax）')
      }

      const raw = String(text == null ? '' : text)
      const chars = raw.length
      const clipped = raw.length > maxChars
      return {
        ok: true,
        url: meta.url,
        title: meta.title,
        mode,
        chars,
        truncated: clipped,
        text: (clipped ? raw.slice(0, maxChars) + '\n… [已截断，共 ' + chars + ' 字符，可加大 maxChars 或缩小范围]' : raw) || '(空)',
        ...meta,
      }
    }

    case 'network': {
      const page = await resolvePage(ctx, args)
      if (args.id) {
        const rec = page.requests.get(String(args.id)) || [...page.requests.values()].find((r) => r.id.startsWith(String(args.id)))
        if (!rec) throw new Error('找不到请求 id: ' + args.id + '（用 network 动作不带 id 先列出请求）')
        let body = rec.body
        if (body == null) {
          try {
            body = await page.captureBody(rec.id)
          } catch (err) {
            throw new Error('取不到响应体（可能已被浏览器回收）: ' + (err && err.message ? err.message : String(err)) + '\n可以改用 browser_read 的 fetch 动作重新请求该 URL。')
          }
        }
        const maxChars = Number(args.maxChars) || 40000
        return {
          ok: true,
          id: rec.id,
          url: rec.url,
          status: rec.status,
          mime: rec.mime,
          size: rec.size,
          truncated: body.length > maxChars,
          text: (body.length > maxChars ? body.slice(0, maxChars) + '\n… [已截断，共 ' + body.length + ' 字符]' : body) || '(空响应体)',
        }
      }
      let list = [...page.requests.values()]
      if (args.filter) {
        const needle = String(args.filter).toLowerCase()
        list = list.filter((r) => (r.url || '').toLowerCase().includes(needle) || (r.mime || '').toLowerCase().includes(needle))
      }
      if (args.type && args.type !== 'all') {
        const t = String(args.type).toLowerCase()
        list = list.filter((r) => String(r.type || '').toLowerCase() === t || String(r.type || '').toLowerCase() === (t === 'api' ? 'xhr' : t))
      }
      if (args.status) list = list.filter((r) => String(r.status) === String(args.status))
      const total = list.length
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 40))
      list = list.slice(-limit)
      const rows = list.map((r) => ({
        id: r.id,
        status: r.status,
        method: r.method,
        type: r.type,
        mime: (r.mime || '').split(';')[0],
        ms: r.ms != null ? r.ms : (r.done ? null : 'pending'),
        size: r.size,
        failed: r.failed || undefined,
        url: String(r.url || '').slice(0, 300),
        hasBody: r.body != null,
      }))
      const lines = rows.map((r) => `${r.id}  ${r.status || (r.failed ? 'ERR' : '…')}  ${r.method}  ${r.mime || '-'}  ${r.url}${r.hasBody ? '  [body]' : ''}`)
      return {
        ok: true,
        total,
        pending: page.pending,
        requests: rows,
        text: total === 0
          ? '(没有匹配的请求；页面可能还未产生流量，或过滤条件太窄)'
          : `共 ${total} 个请求（显示最近 ${rows.length} 个，带 hasBody 的可用 id 取响应体）:\n` + lines.join('\n'),
      }
    }

    case 'console': {
      const page = await resolvePage(ctx, args)
      let list = page.console
      if (args.level) {
        const want = String(args.level)
        list = list.filter((c) => c.type === want || c.type.includes(want))
      }
      if (args.filter) {
        const needle = String(args.filter).toLowerCase()
        list = list.filter((c) => (c.text || '').toLowerCase().includes(needle))
      }
      const total = list.length
      const limit = Math.max(1, Math.min(400, Number(args.limit) || 80))
      list = list.slice(-limit)
      if (args.clear) page.console = []
      return {
        ok: true,
        total,
        messages: list,
        text: list.length ? list.map((c) => `[${c.type}] ${c.text}`).join('\n') : '(控制台没有输出)',
      }
    }

    case 'cookies': {
      const page = await resolvePage(ctx, args)
      const op = String(args.op || 'get')
      if (op === 'set') {
        const cookies = Array.isArray(args.cookies) ? args.cookies : [{ name: args.name, value: args.value, url: args.url }]
        let ok = 0
        for (const c of cookies) {
          const params = { name: String(c.name), value: String(c.value), path: c.path || '/', httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite }
          if (c.domain) params.domain = c.domain
          if (c.url) params.url = c.url
          if (!c.url && !c.domain) params.url = page.url
          const r = await page.send('Network.setCookie', params)
          if (r && r.success) ok += 1
        }
        return { ok: true, text: '已写入 ' + ok + '/' + cookies.length + ' 个 cookie' }
      }
      if (op === 'clear') {
        await page.send('Network.clearBrowserCookies')
        return { ok: true, text: '已清空所有 cookie' }
      }
      const r = await page.send('Network.getCookies', { urls: args.url ? [String(args.url)] : [page.url] })
      const list = (r.cookies || []).map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, expires: c.expires }))
      return {
        ok: true,
        cookies: list,
        text: list.length ? list.map((c) => `${c.name}=${c.value}  (${c.domain}${c.path})`).join('\n') : '(没有 cookie)',
      }
    }

    case 'storage': {
      const page = await resolvePage(ctx, args)
      const store = args.store === 'session' ? 'sessionStorage' : 'localStorage'
      const op = String(args.op || 'get')
      if (op === 'clear') {
        await page.eval(`${store}.clear(); true`, { awaitPromise: false })
        return { ok: true, text: '已清空 ' + store }
      }
      if (op === 'set') {
        const value = typeof args.value === 'string' ? args.value : JSON.stringify(args.value)
        await page.eval(`${store}.setItem(${js(args.key)}, ${js(value)}); true`, { awaitPromise: false })
        return { ok: true, text: `已设置 ${store}[${args.key}]` }
      }
      if (args.key) {
        const value = await page.eval(`${store}.getItem(${js(args.key)})`)
        let parsed = value
        try { parsed = JSON.parse(value) } catch { /* keep raw */ }
        return { ok: true, value: parsed, text: value == null ? '(不存在)' : String(value).slice(0, 8000) }
      }
      const all = await page.eval(`(() => { const o = {}; for (let i = 0; i < ${store}.length; i++) { const k = ${store}.key(i); o[k] = ${store}.getItem(k); } return o; })()`)
      return { ok: true, value: all, text: Object.keys(all || {}).length ? Object.entries(all).map(([k, v]) => `${k} = ${String(v).slice(0, 300)}`).join('\n') : '(空)' }
    }

    case 'fetch': {
      const page = await resolvePage(ctx, args)
      const url = String(args.url || '')
      if (!url) throw new Error('fetch 需要 url')
      const maxChars = Number(args.maxChars) || 40000
      const payload = {
        url,
        method: String(args.method || 'GET').toUpperCase(),
        headers: args.headers && typeof args.headers === 'object' ? args.headers : {},
        body: args.body == null ? null : (typeof args.body === 'string' ? args.body : JSON.stringify(args.body)),
        credentials: args.credentials || 'include',
        absolute: /^https?:/i.test(url) ? url : null,
      }
      const result = await page.eval(`(async () => {
        const cfg = ${JSON.stringify(payload)};
        const target = cfg.absolute || new URL(cfg.url, location.href).href;
        const init = { method: cfg.method, headers: cfg.headers, credentials: cfg.credentials };
        if (cfg.body != null && cfg.method !== 'GET' && cfg.method !== 'HEAD') init.body = cfg.body;
        try {
          const res = await fetch(target, init);
          const buf = await res.arrayBuffer();
          let text = '';
          try { text = new TextDecoder('utf-8').decode(buf); } catch (e) { text = ''; }
          return { ok: true, status: res.status, statusText: res.statusText, headers: Array.from(res.headers.entries()), bytes: buf.byteLength, text };
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) };
        }
      })()`, { timeout: 60000 })
      if (!result.ok) throw new Error('页面内 fetch 失败: ' + result.error + '（跨域被 CSP/同源策略拦截时，改用 network 动作读取页面自己发出的请求响应）')
      const body = String(result.text || '')
      return {
        ok: true,
        status: result.status,
        headers: Object.fromEntries(result.headers || []),
        bytes: result.bytes,
        truncated: body.length > maxChars,
        text: (body.length > maxChars ? body.slice(0, maxChars) + '\n… [已截断，共 ' + body.length + ' 字符]' : body) || '(空响应体)',
      }
    }

    default:
      throw new Error('未知 read 动作: ' + action)
  }
}
