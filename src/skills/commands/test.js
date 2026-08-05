import fs from 'node:fs'
import path from 'node:path'
import c from 'picocolors'
import { resolveSkillTarget, validateSkill } from './validate.js'
import { runSkillTool } from './run.js'

// `skill test <name|path>` — validate the skill, then execute SKILL.tool.js (if
// present) in the allowlisted sandbox. Exits 0 on PASS, 1 on FAIL/invalid.
export async function cmdTest(args) {
  const target = args.find(a => !a.startsWith('-'))
  if (!target) {
    console.error(c.red('Usage: skill test <name|path>'))
    console.error(c.gray('  Validates SKILL.md + runs SKILL.tool.js (allowlisted builtins only).'))
    process.exit(1)
  }
  const res = resolveSkillTarget(target)
  if (!res) {
    console.error(c.red('Not found: ' + target))
    process.exit(1)
  }
  const content = fs.readFileSync(res.path, 'utf8')
  const v = validateSkill(content)
  let failed = false
  console.log(c.bold('skill test') + c.gray(' — ' + res.path))
  if (!v.ok) {
    for (const e of v.errors) console.log(c.red('  ✗ ') + e)
    failed = true
  } else if (v.warnings.length) {
    for (const w of v.warnings) console.log(c.yellow('  ⚠ ') + w)
    console.log(c.green('✓ SKILL.md valid') + c.gray(' (warnings above)'))
  } else {
    console.log(c.green('✓ SKILL.md valid'))
  }

  const toolPath = path.join(path.dirname(res.path), 'SKILL.tool.js')
  if (fs.existsSync(toolPath)) {
    try {
      const r = await runSkillTool(toolPath, ['--test'])
      console.log(c.green('✓ SKILL.tool.js: ') + c.gray('ok' + (r.output ? ' — ' + r.output.trim() : '')))
      if (!r.ok) failed = true
    } catch (e) {
      console.log(c.red('✗ SKILL.tool.js: ') + e.message)
      failed = true
    }
  } else {
    console.log(c.gray('· no SKILL.tool.js — skipped tool test'))
  }

  if (failed) process.exit(1)
  console.log()
  console.log(c.green('PASS') + c.gray(' — ' + (v.name || res.name)))
}
