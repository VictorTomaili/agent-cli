import fs from 'node:fs'
import path from 'node:path'
import c from 'picocolors'
import { sanitizeSkillName } from '../lib/store.js'

const TEMPLATE = (name, description) => `---
name: ${name}
description: ${description || 'One-line description of what this skill does for the agent.'}
triggers: []
version: 1.0.0
---

# ${name}

Write the instructions here. Keep them concrete and task-focused: what the agent
should do, when to use this skill, and any rules or steps it must follow.

## When to use

- ...

## How to use

1. ...
2. ...
`

const TOOL_TEMPLATE = (name) => `// Optional executable tool for this skill.
// Runs via: skill run ${name} [args...]   (or  skill test ${name})
// Exports a single async run(argv) -> { ok, output } function.
export async function run(argv = []) {
  return { ok: true, output: '${name} tool executed with args: ' + argv.join(' ') }
}
`

// `skill create <name> [-d <dir>]` — scaffold a new skill directory with a
// SKILL.md (and an optional SKILL.tool.js). Creates in the current directory
// (or -d/--dir), NOT in the store, so the author can iterate + `skill install .`
// when ready. Refuses to overwrite an existing SKILL.md.
export function cmdCreate(args) {
  const raw = args.find(a => !a.startsWith('-'))
  if (!raw) {
    console.error(c.red('Usage: skill create <name> [-d <dir>] [--tool] [--desc "…"]'))
    console.error(c.gray('  Scaffolds a new skill (SKILL.md + optional SKILL.tool.js) in ./<name> (or -d).'))
    process.exit(1)
  }
  const name = sanitizeSkillName(raw)
  if (!name) {
    console.error(c.red('Invalid skill name: ' + raw))
    console.error(c.gray('  Use letters/digits/._- only (starting alnum). No path separators or "..".'))
    process.exit(1)
  }
  const dirIdx = args.indexOf('-d')
  const dirFlag = dirIdx >= 0 ? args[dirIdx + 1] : args.find((a, i) => args[i - 1] === '--dir')
  const outDir = path.resolve(dirFlag || '.')
  const hasTool = args.includes('--tool')
  const descArg = args.find((a, i) => args[i - 1] === '--desc')

  const skillPath = path.join(outDir, name)
  const mdPath = path.join(skillPath, 'SKILL.md')
  if (fs.existsSync(mdPath)) {
    console.error(c.red('Already exists: ' + mdPath))
    process.exit(1)
  }
  fs.mkdirSync(skillPath, { recursive: true })
  fs.writeFileSync(mdPath, TEMPLATE(name, descArg), 'utf8')
  if (hasTool) {
    fs.writeFileSync(path.join(skillPath, 'SKILL.tool.js'), TOOL_TEMPLATE(name), 'utf8')
  }
  fs.mkdirSync(path.join(skillPath, 'tests'), { recursive: true })
  console.log(c.green('✓') + ' created skill: ' + c.bold(name) + ' at ' + c.cyan(skillPath))
  console.log(c.gray('  Files: ') + (hasTool ? 'SKILL.md, SKILL.tool.js, tests/' : 'SKILL.md, tests/'))
  console.log(c.gray('  Edit SKILL.md, then: ') + c.cyan('skill validate ' + name) + c.gray(' → ') + c.cyan('skill install ' + skillPath))
}
