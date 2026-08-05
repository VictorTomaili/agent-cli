import fs from 'node:fs'
import path from 'node:path'
import c from 'picocolors'
import { resolveSkillTarget, loadSkillTarget } from './validate.js'

const LESSONS_HEADING = '## Lessons'

// `skill capture <name> [lesson…]` — append a lesson learned to the skill's
// SKILL.md under a `## Lessons` section (created if missing). This is how an
// agent or author records "what to do differently next time" while using a
// skill, without hand-editing the body.
export function cmdCapture(args) {
  const name = args.find(a => !a.startsWith('-'))
  if (!name) {
    console.error(c.red('Usage: skill capture <name> <lesson…>'))
    console.error(c.gray("  Appends a lesson to the skill's SKILL.md `## Lessons` section."))
    process.exit(1)
  }
  const res = resolveSkillTarget(name)
  if (!res) {
    console.error(c.red('Not found: ' + name))
    process.exit(1)
  }
  const lesson = args.filter(a => a !== name && !a.startsWith('-')).join(' ').trim()
  if (!lesson) {
    console.error(c.red('Usage: skill capture <name> <lesson…>'))
    console.error(c.gray('  Example: skill capture code-review "always check the PR description first"'))
    process.exit(1)
  }
  const mdPath = res.path
  let content = fs.readFileSync(mdPath, 'utf8')
  // strip a trailing newline so we append cleanly
  content = content.replace(/\s*$/, '\n')
  const idx = content.lastIndexOf(LESSONS_HEADING)
  if (idx === -1) {
    content += '\n' + LESSONS_HEADING + '\n\n- ' + lesson + '\n'
  } else {
    // insert after the heading, before the first subsequent heading (if any)
    const after = content.slice(idx + LESSONS_HEADING.length)
    const nextHeading = after.search(/\n#{1,3} /)
    const insertAt = nextHeading === -1 ? content.length : idx + LESSONS_HEADING.length + nextHeading
    content = content.slice(0, insertAt).replace(/\s*$/, '\n') + '\n- ' + lesson + '\n' + content.slice(insertAt).replace(/^\s*/, '\n')
  }
  fs.writeFileSync(mdPath, content, 'utf8')
  console.log(c.green('✓') + ' captured lesson in ' + c.bold(res.name) + c.gray(' — ' + mdPath))
  console.log(c.gray('  - ' + lesson))
}

// Convenience: read the lessons (if any) of a skill — used by `skill show`.
export function skillLessons(target) {
  const s = loadSkillTarget(target)
  if (!s) return []
  const idx = s.body.lastIndexOf(LESSONS_HEADING)
  if (idx === -1) return []
  const section = s.body.slice(idx + LESSONS_HEADING.length)
  return section
    .split('\n')
    .map(l => l.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean)
}
