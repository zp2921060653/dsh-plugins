// index.js — registers the bundled agent skill with DSH.
//
// Why register at runtime instead of letting the skill filesystem scan the package:
// dsh-skill-filesystem's default roots (project / user / bundled) do NOT scan inside
// node_modules plugin directories, so a SKILL.md shipped in a plugin package would never
// be discovered on its own. Same approach as dsh-ghidra.
import { loadSkillDefinition, SKILL_FILE } from './lib/skill.js'

export const name = 'wukong-trainer-skill'

// Soft dependency: headless compositions may not mount the skills service.
export const inject = []

export function apply(ctx) {
  ctx.inject(['skills'], (sctx) => {
    if (!sctx.skills || typeof sctx.skills.register !== 'function') {
      ctx.logger?.warn?.('[wukong-trainer-skill] skills service unavailable')
      return
    }
    const definition = loadSkillDefinition()
    if (!definition) {
      ctx.logger?.warn?.('[wukong-trainer-skill] SKILL.md missing or frontmatter incomplete: ' + SKILL_FILE)
      return
    }
    try {
      sctx.skills.register(definition)
      ctx.logger?.info?.('[wukong-trainer-skill] registered skill "' + definition.name + '"')
    } catch (e) {
      ctx.logger?.warn?.('[wukong-trainer-skill] register failed: ' + String(e?.message || e))
    }
  })
}
