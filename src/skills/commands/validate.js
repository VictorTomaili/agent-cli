import fs from 'node:fs'
import path from 'node:path'
import c from 'picocolors'
import { parseSkillMd, getTriggers } from '../lib/frontmatter.js'
import { sanitizeSkillName, listStore, readSkill, skillMdPath, readSkillMdBounded } from '../lib/store.js'

// Resolve a user-supplied target: a store skill name, or a path to a
// SKILL.md (or a dir containing SKILL.md). Returns null if unresolvable.
export function resolveSkillTarget(target) {
  if (!target) return null
  // store name?
  if (sanitizeSkillName(target) && fs.existsSync(skillMdPath(target))) {
    return { kind: 'store', name: target, path: skillMdPath(target) }
  }
  const hit = listStore().find(s => s.name.toLowerCase() === target.toLowerCase())
  if (hit) return { kind: 'store', name: hit.name, path: hit.path }
  // path?
  const p = path.resolve(target)
  let md = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'SKILL.md') : p
  if (fs.existsSync(md)) return { kind: 'path', name: path.basename(path.dirname(md)), path: md }
  return null
}

export function loadSkillTarget(target) {
  const res = resolveSkillTarget(target)
  if (!res) return null
  // M5: an arbitrary user path (skill validate ./huge.md) must not be slurped.
  const raw = readSkillMdBounded(res.path)
  if (raw == null) return null
  const { data, body } = parseSkillMd(raw)
  return { ...res, data, body }
}

// The validation checks shared by `skill validate` (and usable by `install`).
// Returns { ok, name, errors[], warnings[], data, body }.
export function validateSkill(content, { fileName = 'SKILL.md' } = {}) {
  const { data, body } = parseSkillMd(content)
  const errors = []
  const warnings = []
  const name = data.name
  if (!name) errors.push('frontmatter `name` is required')
  else if (!sanitizeSkillName(name)) errors.push(`frontmatter \`name\` is not a safe skill name: "${name}"`)
  if (typeof data.description !== 'string' || !data.description.trim()) {
    warnings.push('frontmatter `description` is missing — add a one-line description (used by `skill active` proposals)')
  }
  if (data.version !== undefined && typeof data.version !== 'string' && typeof data.version !== 'number') {
    errors.push('frontmatter `version` must be a string or number')
  }
  const triggers = getTriggers(data)
  for (const t of triggers) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(t)) warnings.push(`trigger "/${t}" is not alphanumeric — may be hard to invoke`)
  }
  if (data.triggers !== undefined) {
    const ok =
      (Array.isArray(data.triggers) && data.triggers.every(t => typeof t === 'string')) ||
      typeof data.triggers === 'string'
    if (!ok) errors.push('frontmatter `triggers` must be a string or array of strings')
  }
  if (!body.trim()) warnings.push('SKILL.md has no body — add instructions for the agent')
  return { ok: errors.length === 0, name, errors, warnings, data, body, triggers }
}

// `skill validate <name|path>` — check a skill's SKILL.md frontmatter + body.
// Exits 0 on valid (warnings may print), 1 on invalid.
export function cmdValidate(args) {
  const target = args.find(a => !a.startsWith('-'))
  const res = target ? resolveSkillTarget(target) : null
  if (!res) {
    console.error(c.red('Not found: ' + (target || '<none>') + ' — give a store skill name or a path to SKILL.md'))
    console.error(c.gray('  Tip: after `skill create`, run `skill validate ./<name>`'))
    process.exit(1)
  }
  const content = fs.readFileSync(res.path, 'utf8')
  const v = validateSkill(content)
  console.log(c.bold('skill validate') + c.gray(' — ' + res.path))
  if (v.ok && v.warnings.length === 0) {
    console.log(c.green('✓ valid') + c.gray(' — ' + (v.name || '(no name)')))
    return
  }
  for (const e of v.errors) console.log(c.red('  ✗ ') + e)
  for (const w of v.warnings) console.log(c.yellow('  ⚠ ') + w)
  if (v.errors.length) {
    console.log()
    process.exit(1)
  }
  console.log()
  console.log(c.green('✓ frontmatter valid') + c.gray(' (address warnings for best UX)'))
}

// `skill preview <name|path>` — print what the agent would load (`skill cat`):
// frontmatter summary + full body. Useful for authoring/review.
export function cmdPreview(args) {
  const target = args.find(a => !a.startsWith('-'))
  const res = target ? resolveSkillTarget(target) : null
  if (!res) {
    console.error(c.red('Not found: ' + (target || '<none>')))
    process.exit(1)
  }
  const { data, body } = parseSkillMd(fs.readFileSync(res.path, 'utf8'))
  const name = data.name || res.name
  console.log(c.bold(name) + c.gray('  (' + res.path + ')'))
  if (data.description) console.log(c.gray('  ' + String(data.description).replace(/[\r\n]+/g, ' ')))
  const trg = getTriggers(data)
  if (trg.length) console.log(c.gray('  triggers: /' + trg.join(', /')))
  if (data.version) console.log(c.gray('  version: ' + data.version))
  console.log()
  console.log(body.trimEnd())
}

// `skill cat`-style body dump used by `preview --body` (agent-facing).
export function catBody(target) {
  const s = loadSkillTarget(target)
  if (!s) return null
  return { name: s.data.name || s.name, body: s.body, data: s.data }
}

// Re-export readSkill for other commands (run/test/capture) to share lookup.
export { readSkill }
