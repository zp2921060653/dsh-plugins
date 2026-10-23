// Page-side helper library.
//
// `pageLib()` is serialized with Function.prototype.toString and evaluated inside
// the page, so it must stay self-contained: no imports, no references to this module.
// Every helper is written against plain DOM APIs available in Chromium.

function pageLib() {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'LINK', 'META', 'HEAD', 'OBJECT', 'EMBED', 'MAP', 'AREA'])
  const INTERACTIVE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])'

  const norm = (s) => String(s == null ? '' : s).replace(/\u00a0/g, ' ').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').trim()

  const vis = (el) => {
    if (!el || el.nodeType !== 1) return false
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false
    if (Number(cs.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    return true
  }

  const txt = (el) => {
    if (!el) return ''
    const t = el.innerText != null ? el.innerText : (el.textContent || '')
    return norm(t)
  }

  const abs = (href) => {
    try { return new URL(href, location.href).href } catch { return href }
  }

  const esc = (s) => {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s)
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c)
  }

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return ''
    if (el.id) {
      const sel = '#' + esc(el.id)
      try { if (document.querySelectorAll(sel).length === 1) return sel } catch { /* ignore */ }
    }
    const parts = []
    let cur = el
    let guard = 0
    while (cur && cur.nodeType === 1 && guard++ < 7) {
      const tag = cur.tagName.toLowerCase()
      if (tag === 'body' || tag === 'html') { parts.unshift(tag); break }
      let part = tag
      const cls = typeof cur.className === 'string' ? cur.className.trim().split(/\s+/).filter(Boolean) : []
      if (cls.length) part += '.' + cls.slice(0, 2).map(esc).join('.')
      const parent = cur.parentElement
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === cur.tagName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')'
      }
      parts.unshift(part)
      if (cur.id) { parts[0] = '#' + esc(cur.id); break }
      cur = parent
    }
    return parts.join(' > ')
  }

  const pick = (sel) => {
    if (!sel) return null
    const s = String(sel).trim()
    if (!s) return null
    if (s.startsWith('//') || s.startsWith('(//')) {
      try {
        const r = document.evaluate(s, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
        return r.singleNodeValue || null
      } catch { return null }
    }
    try { return document.querySelector(s) } catch { return null }
  }

  const pickAll = (sel) => {
    if (!sel) return []
    try { return Array.prototype.slice.call(document.querySelectorAll(sel)) } catch { return [] }
  }

  const nameOf = (el) => {
    if (!el) return ''
    const aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder'))
    if (aria && aria.trim()) return norm(aria)
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'checkbox' || t === 'radio') return el.checked ? 'checked' : 'unchecked'
      return norm(el.value || '')
    }
    if (el.tagName === 'SELECT') return norm(el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : el.value)
    if (el.tagName === 'IMG') return norm(el.getAttribute('alt') || '')
    return txt(el)
  }

  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  }

  const describe = (el) => {
    if (!el) return null
    return {
      tag: el.tagName.toLowerCase(),
      role: (el.getAttribute && el.getAttribute('role')) || '',
      name: nameOf(el).slice(0, 120),
      selector: cssPath(el),
      box: (function () { const r = rect(el); return [r.x, r.y, r.w, r.h] })(),
    }
  }

  const inline = (node) => {
    let s = ''
    const kids = node.childNodes || []
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]
      if (child.nodeType === 3) { s += norm(child.nodeValue); if (s && !/\s$/.test(s)) s += ' '; continue }
      if (child.nodeType !== 1) continue
      const tag = child.tagName
      if (SKIP.has(tag)) continue
      if (tag === 'BR') { s += '\n'; continue }
      if (tag === 'IMG') {
        const alt = norm(child.getAttribute('alt') || '')
        const src = child.getAttribute('src') || ''
        s += alt ? '![' + alt + '](' + abs(src) + ') ' : ''
        continue
      }
      if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') { s += '`' + norm(child.textContent).replace(/`/g, "'") + '` '; continue }
      if (tag === 'STRONG' || tag === 'B') { const t = norm(inline(child)); s += t ? '**' + t + '** ' : ''; continue }
      if (tag === 'EM' || tag === 'I') { const t = norm(inline(child)); s += t ? '*' + t + '* ' : ''; continue }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        const n = nameOf(child)
        if (n) s += '[' + tag.toLowerCase() + ': ' + n + '] '
        continue
      }
      if (tag === 'A') {
        const label = norm(inline(child))
        const href = child.getAttribute('href') || ''
        if (!label) { s += '' ; continue }
        s += href && !/^javascript:/i.test(href) ? '[' + label + '](' + abs(href) + ') ' : label + ' '
        continue
      }
      s += inline(child)
    }
    return s
  }

  const md = (root, opts) => {
    const o = opts || {}
    const out = []
    const push = (s) => { if (s) out.push(s) }
    const seen = new Set()

    const block = (el, depth) => {
      const tag = el.tagName
      if (SKIP.has(tag)) return
      if (seen.has(el)) return
      seen.add(el)
      const style = getComputedStyle(el)
      const isHidden = style.display === 'none' || style.visibility === 'hidden'
      if (isHidden) return
      if (/^H[1-6]$/.test(tag)) {
        const t = norm(inline(el))
        if (t) push('\n' + '#'.repeat(Number(tag[1])) + ' ' + t + '\n')
        return
      }
      if (tag === 'P') { const t = norm(inline(el)); if (t) push('\n' + t + '\n'); return }
      if (tag === 'PRE') {
        const code = String(el.textContent || '').replace(/\s+$/, '')
        if (code.trim()) push('\n```\n' + code + '\n```\n')
        return
      }
      if (tag === 'BLOCKQUOTE') {
        const inner = md(el, o).trim()
        if (inner) push('\n' + inner.split('\n').map((l) => '> ' + l).join('\n') + '\n')
        return
      }
      if (tag === 'HR') { push('\n---\n'); return }
      if (tag === 'UL' || tag === 'OL') {
        let n = 0
        for (const li of el.children) {
          if (li.tagName !== 'LI') continue
          n += 1
          const bullet = tag === 'OL' ? n + '. ' : '- '
          const t = norm(inline(li))
          if (t) push('\n' + '  '.repeat(Math.max(0, depth)) + bullet + t)
          for (const nested of li.children) {
            if (nested.tagName === 'UL' || nested.tagName === 'OL') block(nested, depth + 1)
          }
        }
        push('\n')
        return
      }
      if (tag === 'TABLE') {
        const rows = el.querySelectorAll('tr')
        let i = 0
        for (const tr of rows) {
          const cells = Array.prototype.map.call(tr.children, (c) => norm(inline(c)))
          if (!cells.some(Boolean)) continue
          push('\n| ' + cells.join(' | ') + ' |')
          if (i === 0) push('\n|' + cells.map(() => ' --- ').join('|') + '|')
          i += 1
        }
        if (i) push('\n')
        return
      }
      if (tag === 'DT') { const t = norm(inline(el)); if (t) push('\n**' + t + '**'); return }
      if (tag === 'DD') { const t = norm(inline(el)); if (t) push(' — ' + t + '\n'); return }
      if (tag === 'A' || tag === 'SPAN' || tag === 'STRONG' || tag === 'EM' || tag === 'B' || tag === 'I' || tag === 'CODE' || tag === 'LABEL' || tag === 'SMALL' || tag === 'TIME' || tag === 'MARK') {
        const t = norm(inline(el))
        if (t) push(t)
        return
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') {
        const t = norm(inline(el))
        if (t) push('[' + tag.toLowerCase() + ': ' + t + '] ')
        return
      }
      // generic container: recurse into children
      let hasBlockChild = false
      for (const child of el.children) {
        if (SKIP.has(child.tagName)) continue
        if (/^(DIV|SECTION|ARTICLE|MAIN|ASIDE|NAV|HEADER|FOOTER|FORM|FIELDSET|FIGURE|DETAILS|SUMMARY|H[1-6]|P|PRE|UL|OL|TABLE|BLOCKQUOTE|HR|DL|LI|TR|TD|TH)$/.test(child.tagName)) {
          hasBlockChild = true
          break
        }
      }
      if (hasBlockChild) {
        push('\n')
        for (const child of el.children) block(child, depth)
      } else {
        const t = norm(inline(el))
        if (t) push((o.separator || '\n') + t)
      }
    }

    block(root || document.body, 0)
    let text = out.join('')
    text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '').replace(/\s+$/, '')
    return text
  }

  const main = () => {
    const longest = (list) => {
      list.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
      return list[list.length - 1]
    }
    const strong = Array.prototype.filter.call(
      document.querySelectorAll('main, [role="main"], article'),
      (el) => vis(el) && (el.innerText || '').trim().length > 0,
    )
    if (strong.length) return longest(strong)
    const loose = Array.prototype.filter.call(
      document.querySelectorAll('#content, #main, .content, .main, .markdown-body, .article, .post, .entry-content'),
      (el) => vis(el) && (el.innerText || '').trim().length > 120,
    )
    if (loose.length) return longest(loose)
    let best = document.body
    let bestScore = 0
    const blocks = document.body.querySelectorAll('div,section,article,main,td')
    for (const el of blocks) {
      const t = el.innerText || ''
      if (t.length < 250) continue
      const links = el.querySelectorAll('a')
      let linkLen = 0
      for (const a of links) linkLen += (a.innerText || '').length
      const pCount = el.querySelectorAll('p').length
      const score = t.length - linkLen * 1.6 + pCount * 120 - el.querySelectorAll('div').length * 6
      if (score > bestScore) { bestScore = score; best = el }
    }
    return best
  }

  const interactive = (opts) => {
    const o = opts || {}
    const out = []
    const els = pickAll(o.selector || INTERACTIVE)
    for (const el of els) {
      if (out.length >= (o.limit || 250)) break
      if (!vis(el)) continue
      const r = rect(el)
      if (r.w < 2 || r.h < 2) continue
      const item = {
        i: out.length,
        tag: el.tagName.toLowerCase(),
        role: (el.getAttribute('role') || '').toLowerCase(),
        name: nameOf(el).replace(/\s+/g, ' ').slice(0, 100),
        selector: cssPath(el),
        box: [r.x, r.y, r.w, r.h],
      }
      if (el.tagName === 'A' && el.getAttribute('href')) item.href = abs(el.getAttribute('href'))
      if (el.tagName === 'INPUT') {
        item.type = (el.getAttribute('type') || 'text').toLowerCase()
        if (item.type === 'checkbox' || item.type === 'radio') item.checked = !!el.checked
        if (el.value) item.value = String(el.value).slice(0, 80)
      }
      if (el.tagName === 'SELECT') item.value = el.value
      if (el.disabled) item.disabled = true
      out.push(item)
    }
    return out
  }

  const byText = (needle, opts) => {
    const o = opts || {}
    const want = norm(needle).toLowerCase()
    if (!want) return []
    const pool = []
    const pushIf = (el) => { if (el && !pool.includes(el) && vis(el)) pool.push(el) }
    for (const el of pickAll(INTERACTIVE)) pushIf(el)
    for (const el of pickAll('h1,h2,h3,h4,h5,h6,p,span,div,td,th,label,li')) {
      if (pool.length > 4000) break
      pushIf(el)
    }
    const scored = []
    for (const el of pool) {
      const t = norm(el.innerText || el.textContent || '').toLowerCase()
      if (!t) continue
      let score = -1
      if (t === want) score = 100
      else if (t.startsWith(want)) score = 80 - Math.min(40, t.length - want.length)
      else if (t.includes(want)) score = 50 - Math.min(40, t.length - want.length)
      if (score < 0) continue
      const isInteractive = el.matches(INTERACTIVE)
      if (isInteractive) score += 30
      // prefer the innermost element carrying the text
      let childHit = false
      for (const child of el.children) {
        const ct = norm(child.innerText || '').toLowerCase()
        if (ct === want || ct.length > 0 && ct.includes(want) && ct.length < t.length) { childHit = true; break }
      }
      if (childHit) score -= 40
      scored.push({ el, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, o.limit || 10).map((s) => s.el)
  }

  const findByText = (needle, opts) => {
    const list = byText(needle, opts)
    const index = (opts && opts.index) || 0
    return list[index] || null
  }

  const focusSelect = (el) => {
    if (!el) return false
    el.focus()
    if (el.isContentEditable) {
      const r = document.createRange()
      r.selectNodeContents(el)
      const s = getSelection()
      s.removeAllRanges()
      s.addRange(r)
      return true
    }
    if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      try { el.select() } catch { /* ignore */ }
      return true
    }
    return true
  }

  const scrollByWheel = (dy) => {
    const x = Math.round(innerWidth / 2)
    const y = Math.round(innerHeight / 2)
    return { x, y, dy }
  }

  return { vis, txt, norm, abs, esc, cssPath, pick, pickAll, nameOf, rect, describe, inline, md, main, interactive, byText, findByText, focusSelect, scrollByWheel, INTERACTIVE }
}

/** Wrap a page-side statement in an IIFE that exposes the helper table as `__dsh`. */
export function evalScript(body) {
  return '(() => { const __dsh = (' + pageLib.toString() + ')(); ' + body + ' })()'
}

export { pageLib }
