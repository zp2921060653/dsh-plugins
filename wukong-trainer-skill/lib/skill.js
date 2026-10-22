// lib/skill.js — read skills/wukong-trainer-re/SKILL.md into a ctx.skills.register() definition.
// Frontmatter is parsed line by line on purpose: the file is maintained in this repo and
// description / whenToUse stay single-line, so no YAML dependency is needed.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SKILL_NAME = 'wukong-trainer-re'
export const SKILL_DIR = join(HERE, '..', 'skills', SKILL_NAME)
export const SKILL_FILE = join(SKILL_DIR, 'SKILL.md')

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function field(frontmatter, key) {
  const m = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm').exec(frontmatter)
  if (!m) return undefined
  let v = m[1].trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1)
  }
  return v || undefined
}

/** Read and parse the bundled SKILL.md. Any problem returns null — never let a skill break plugin load. */
export function loadSkillDefinition() {
  let raw
  try { raw = readFileSync(SKILL_FILE, 'utf8') } catch { return null }
  const m = FRONTMATTER.exec(raw)
  if (!m) return null
  const name = field(m[1], 'name')
  const description = field(m[1], 'description')
  const whenToUse = field(m[1], 'whenToUse')
  const content = raw.slice(m[0].length).trim()
  if (!name || !description || !content) return null
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return null
  return { name, description, whenToUse, content, source: SKILL_FILE }
}
