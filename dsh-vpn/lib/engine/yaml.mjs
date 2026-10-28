// dsh-vpn engine — minimal YAML parser for the subset used by Clash/mihomo
// subscription configs.
//
// Supported: block mappings & sequences, flow mappings & sequences (single or
// multi line), single/double quoted scalars, plain scalars, comments.
// Not supported: anchors/aliases, tags, multi-document streams, literal block
// scalars (| / >). Those do not appear in Clash subscription configs.
//
// No external dependencies, only node: built-ins.

/**
 * Parse a YAML document (subset above) into plain JS values.
 * @param {string} text
 * @returns {any}
 */
export function parseYaml(text) {
  if (typeof text !== 'string') throw new TypeError('parseYaml(text): text must be a string')
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = buildLines(src)
  if (lines.length === 0) return {}
  const [doc] = parseBlock(lines, 0, lines[0].indent)
  return doc
}

/**
 * Parse a Clash/mihomo style config and return the three collections the
 * engine cares about.
 * @param {string} yaml
 * @returns {{ proxies: any[], groups: any[], rules: any[] }}
 */
export function parseClashYaml(yaml) {
  if (typeof yaml !== 'string' || yaml.trim() === '') {
    throw new Error('parseClashYaml: yaml must be a non-empty string')
  }
  let doc
  try {
    doc = parseYaml(yaml)
  } catch (err) {
    throw new Error(`Clash YAML 解析失败: ${err.message}`)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Clash YAML 解析失败: 顶层不是映射')
  }
  if (!Array.isArray(doc.proxies)) {
    throw new Error('Clash YAML 解析失败: 缺少 proxies 列表（不是 Clash 格式订阅？）')
  }
  const proxies = doc.proxies.filter((p) => p !== null && typeof p === 'object' && !Array.isArray(p))
  const groups = Array.isArray(doc['proxy-groups'])
    ? doc['proxy-groups'].filter((g) => g !== null && typeof g === 'object' && !Array.isArray(g))
    : []
  const rules = Array.isArray(doc.rules) ? doc.rules.filter((r) => r !== null && r !== undefined) : []
  return { proxies, groups, rules }
}

/* ------------------------------------------------------------------ */
/* line preparation                                                    */
/* ------------------------------------------------------------------ */

function buildLines(text) {
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  const lines = []
  for (let rawLine of raw) {
    if (rawLine.includes('\t')) rawLine = rawLine.replace(/\t/g, '    ')
    const trimmed = rawLine.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (/^(---|\.\.\.)\s*$/.test(trimmed)) continue
    if (trimmed.startsWith('%')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    lines.push({ indent, content: rawLine.slice(indent).replace(/\s+$/, '') })
  }
  return lines
}

/* ------------------------------------------------------------------ */
/* block structure                                                     */
/* ------------------------------------------------------------------ */

function parseBlock(lines, idx, indent) {
  const ln = lines[idx]
  if (ln.content === '-' || ln.content.startsWith('- ')) return parseSequence(lines, idx, indent)
  return parseMapping(lines, idx, indent)
}

function parseMapping(lines, idx, indent) {
  const obj = {}
  while (idx < lines.length) {
    const ln = lines[idx]
    if (ln.indent < indent) break
    if (ln.indent > indent) {
      idx += 1
      continue
    }
    if (ln.content === '-' || ln.content.startsWith('- ')) break
    const colon = findKeyColon(ln.content)
    if (colon < 0) {
      idx += 1
      continue
    }
    const key = decodeKey(ln.content.slice(0, colon))
    const rest = ln.content.slice(colon + 1).trim()
    idx += 1
    if (rest === '' || rest.startsWith('#')) {
      if (idx < lines.length && lines[idx].indent > indent) {
        const [value, next] = parseBlock(lines, idx, lines[idx].indent)
        obj[key] = value
        idx = next
      } else {
        obj[key] = null
      }
    } else {
      const [value, next] = parseInlineValue(rest, lines, idx)
      obj[key] = value
      idx = next
    }
  }
  return [obj, idx]
}

function parseSequence(lines, idx, indent) {
  const arr = []
  while (idx < lines.length) {
    const ln = lines[idx]
    if (ln.indent !== indent) break
    if (!(ln.content === '-' || ln.content.startsWith('- '))) break
    let rest = ln.content === '-' ? '' : ln.content.slice(2).trim()
    idx += 1
    if (rest === '' || rest.startsWith('#')) {
      if (idx < lines.length && lines[idx].indent > indent) {
        const [value, next] = parseBlock(lines, idx, lines[idx].indent)
        arr.push(value)
        idx = next
      } else {
        arr.push(null)
      }
      continue
    }
    if (rest.startsWith('{') || rest.startsWith('[')) {
      const [value, next] = parseInlineValue(rest, lines, idx)
      arr.push(value)
      idx = next
      continue
    }
    const colon = findKeyColon(rest)
    if (colon >= 0) {
      // block-style sequence item that is a mapping: "- name: foo" then "  type: ss"
      const obj = {}
      const key = decodeKey(rest.slice(0, colon))
      const valueText = rest.slice(colon + 1).trim()
      if (valueText === '' || valueText.startsWith('#')) {
        if (idx < lines.length && lines[idx].indent > indent) {
          const [value, next] = parseBlock(lines, idx, lines[idx].indent)
          obj[key] = value
          idx = next
        } else {
          obj[key] = null
        }
      } else {
        const [value, next] = parseInlineValue(valueText, lines, idx)
        obj[key] = value
        idx = next
      }
      if (idx < lines.length && lines[idx].indent > indent) {
        const contIndent = lines[idx].indent
        const [more, next] = parseMapping(lines, idx, contIndent)
        Object.assign(obj, more)
        idx = next
      }
      arr.push(obj)
    } else {
      arr.push(parseScalarText(rest))
    }
  }
  return [arr, idx]
}

/**
 * Parse a value that starts on the current line. Flow collections may continue
 * over following lines; block scalars do not (plain scalars are single-line).
 */
function parseInlineValue(rest, lines, idx) {
  if (rest.startsWith('[') || rest.startsWith('{')) {
    let text = rest
    while (flowOpen(text) && idx < lines.length) {
      text += ' ' + lines[idx].content.trim()
      idx += 1
    }
    return [parseFlow(text), idx]
  }
  return [parseScalarText(rest), idx]
}

/* ------------------------------------------------------------------ */
/* scalars                                                             */
/* ------------------------------------------------------------------ */

const TRUE_WORDS = new Set(['true', 'True', 'TRUE'])
const FALSE_WORDS = new Set(['false', 'False', 'FALSE'])
const NULL_WORDS = new Set(['null', 'Null', 'NULL', '~'])

function decodeKey(text) {
  const t = text.trim()
  if (t.length >= 2) {
    const first = t[0]
    const last = t[t.length - 1]
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      const parsed = parseQuotedText(t)
      if (parsed !== null) return parsed
    }
  }
  return t
}

function parseScalarText(text) {
  const t = text.trim()
  if (t === '') return null
  if (t[0] === "'" || t[0] === '"') {
    const quoted = parseQuotedText(t)
    if (quoted !== null) return quoted
  }
  return interpretPlain(stripInlineComment(t))
}

function stripInlineComment(text) {
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1
      else if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") i += 1
        else quote = ''
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '#' && i > 0 && /\s/.test(text[i - 1])) return text.slice(0, i).trim()
  }
  return text.trim()
}

function interpretPlain(t) {
  const s = t.trim()
  if (s === '') return null
  if (TRUE_WORDS.has(s)) return true
  if (FALSE_WORDS.has(s)) return false
  if (NULL_WORDS.has(s)) return null
  if (/^[+-]?\d+$/.test(s)) return Number(s)
  if (/^[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return Number(s)
  return s
}

/** Parse a full quoted scalar (text starts and ends with the quote). */
function parseQuotedText(text) {
  const quote = text[0]
  if (quote !== "'" && quote !== '"') return null
  let out = ''
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out += "'"
          i += 1
          continue
        }
        return out + text.slice(i + 1).trim().replace(/^#.*$/, '').replace(/\s+$/, '')
      }
      out += ch
      continue
    }
    // double quoted
    if (ch === '\\') {
      const next = text[i + 1]
      i += 1
      switch (next) {
        case 'n':
          out += '\n'
          break
        case 't':
          out += '\t'
          break
        case 'r':
          out += '\r'
          break
        case '"':
          out += '"'
          break
        case '\\':
          out += '\\'
          break
        case '/':
          out += '/'
          break
        case 'u': {
          const hex = text.slice(i + 1, i + 5)
          const code = Number.parseInt(hex, 16)
          if (Number.isFinite(code)) {
            out += String.fromCharCode(code)
            i += 4
          }
          break
        }
        default:
          out += next ?? ''
      }
      continue
    }
    if (ch === '"') return out
    out += ch
  }
  return out
}

/* ------------------------------------------------------------------ */
/* flow collections                                                    */
/* ------------------------------------------------------------------ */

function flowOpen(text) {
  let depth = 0
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (quote === '"' && ch === '\\') i += 1
      else if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") i += 1
        else quote = ''
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth -= 1
  }
  return depth > 0 || quote !== ''
}

function parseFlow(text) {
  const state = { s: text, i: 0 }
  const value = parseFlowNode(state)
  return value
}

function parseFlowNode(state) {
  skipFlowSpace(state)
  const ch = state.s[state.i]
  if (ch === '{') return parseFlowMap(state)
  if (ch === '[') return parseFlowList(state)
  if (ch === "'" || ch === '"') return parseFlowQuoted(state)
  return parseFlowPlain(state)
}

function parseFlowMap(state) {
  state.i += 1 // {
  const obj = {}
  while (state.i < state.s.length) {
    skipFlowSpace(state)
    if (state.s[state.i] === '}') {
      state.i += 1
      return obj
    }
    let key
    if (state.s[state.i] === "'" || state.s[state.i] === '"') key = parseFlowQuoted(state)
    else key = readFlowKey(state)
    key = String(key)
    skipFlowSpace(state)
    if (state.s[state.i] === ':') state.i += 1
    else if (state.s[state.i] === ',') {
      obj[key] = null
      state.i += 1
      continue
    } else if (state.s[state.i] === '}') {
      obj[key] = null
      state.i += 1
      return obj
    }
    skipFlowSpace(state)
    if (state.s[state.i] === ',' || state.s[state.i] === '}') {
      obj[key] = null
      if (state.s[state.i] === ',') state.i += 1
      continue
    }
    obj[key] = parseFlowNode(state)
    skipFlowSpace(state)
    if (state.s[state.i] === ',') state.i += 1
    else if (state.s[state.i] === '}') {
      state.i += 1
      return obj
    }
  }
  return obj
}

function parseFlowList(state) {
  state.i += 1 // [
  const arr = []
  while (state.i < state.s.length) {
    skipFlowSpace(state)
    if (state.s[state.i] === ']') {
      state.i += 1
      return arr
    }
    arr.push(parseFlowNode(state))
    skipFlowSpace(state)
    if (state.s[state.i] === ',') state.i += 1
    else if (state.s[state.i] === ']') {
      state.i += 1
      return arr
    }
  }
  return arr
}

function parseFlowQuoted(state) {
  const quote = state.s[state.i]
  let out = ''
  state.i += 1
  while (state.i < state.s.length) {
    const ch = state.s[state.i]
    if (quote === "'") {
      if (ch === "'") {
        if (state.s[state.i + 1] === "'") {
          out += "'"
          state.i += 2
          continue
        }
        state.i += 1
        return out
      }
      out += ch
      state.i += 1
      continue
    }
    if (ch === '\\') {
      const next = state.s[state.i + 1]
      state.i += 2
      switch (next) {
        case 'n':
          out += '\n'
          break
        case 't':
          out += '\t'
          break
        case 'r':
          out += '\r'
          break
        case 'u': {
          const hex = state.s.slice(state.i, state.i + 4)
          const code = Number.parseInt(hex, 16)
          if (Number.isFinite(code)) {
            out += String.fromCharCode(code)
            state.i += 4
          }
          break
        }
        default:
          out += next ?? ''
      }
      continue
    }
    if (ch === '"') {
      state.i += 1
      return out
    }
    out += ch
    state.i += 1
  }
  return out
}

function readFlowKey(state) {
  let out = ''
  while (state.i < state.s.length) {
    const ch = state.s[state.i]
    if (ch === ':' || ch === ',' || ch === '}' || ch === ']') break
    out += ch
    state.i += 1
  }
  return out.trim()
}

function parseFlowPlain(state) {
  let out = ''
  while (state.i < state.s.length) {
    const ch = state.s[state.i]
    if (ch === ',' || ch === ']' || ch === '}') break
    out += ch
    state.i += 1
  }
  return interpretPlain(out)
}

function skipFlowSpace(state) {
  while (state.i < state.s.length && /\s/.test(state.s[state.i])) state.i += 1
}

/* ------------------------------------------------------------------ */
/* misc helpers                                                        */
/* ------------------------------------------------------------------ */

/** Find the index of the key/value separator ':' on a block line, or -1. */
function findKeyColon(text) {
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"') {
      i = skipQuoted(text, i)
      continue
    }
    if (ch === ':' && (i + 1 === text.length || text[i + 1] === ' ' || text[i + 1] === '\t')) {
      return i
    }
    i += 1
  }
  return -1
}

function skipQuoted(text, start) {
  const quote = text[start]
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]
    if (quote === '"' && ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        i += 2
        continue
      }
      return i + 1
    }
    i += 1
  }
  return text.length
}
