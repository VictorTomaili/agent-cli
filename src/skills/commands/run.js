import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import c from 'picocolors'
import { resolveSkillTarget } from './validate.js'
import { isPlainSkillFile, readSkillMdBounded, MAX_SKILL_MD_BYTES } from '../lib/store.js'

// Tool modules may only import from this allowlist of Node builtins. Anything
// that reaches the network or spawns processes (child_process, net, http,
// https, dns, tls, worker_threads, vm, repl) is rejected — a skill is
// instructions + a small pure helper, not an arbitrary script. We ALSO statically
// reject dynamic `import()`/`require()` so the allowlist can't be bypassed.
export const TOOL_ALLOWLIST = new Set([
  'node:fs', 'fs', 'node:fs/promises', 'node:path', 'path',
  'node:os', 'os', 'node:util', 'util', 'node:crypto', 'crypto',
  'node:url', 'url', 'node:stream', 'node:events', 'node:buffer',
])
// Two capture groups:
//   group 1 — static-form quoted spec ("x" after `from` or `import "x"`)
//
//   group 2 — dynamic-form quoted spec ("x" inside import()/require())
//   group 3 — dynamic-form unquoted identifier (always banned)
// The previous regex required `require` to be followed by a quote (no paren),
// so even `require("node:child_process")` slipped through, and required a
// quote after the static `import\s+` (so dynamic `import(s)` where
// `s = "node:child_process"` slipped through too). This regex splits the
// static and dynamic forms so static imports only ever carry a quoted spec,
// while dynamic imports carry either — and an unquoted identifier in a
// dynamic position is always banned.
const IMPORT_SPEC = /(?:from\s+|\bimport\s+)\s*['"]([^'"]+)['"]|(?:\brequire\s*\(|\bimport\s*\()\s*(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$.]*))/g

// Static import allowlist check on the tool's source. Returns
// { ok, banned: [specs] }.
export function checkToolImports(source) {
  const banned = new Set()
  let m
  IMPORT_SPEC.lastIndex = 0
  while ((m = IMPORT_SPEC.exec(source))) {
    if (m[3] !== undefined) {
      // Unquoted identifier in a dynamic-import position — e.g.
      //   const s = "node:child_process"; return import(s)
      // The previous implementation accepted this and skipped the allowlist.
      // Always banned.
      banned.add(m[3])
    } else {
      const spec = m[1] ?? m[2]
      if (!TOOL_ALLOWLIST.has(spec)) banned.add(spec)
    }
  }
  return { ok: banned.size === 0, banned: [...banned] }
}

// Load + execute a skill's SKILL.tool.js with the given argv. The module must
// export `run(argv) -> { ok, output }`. `run()` is called in-process after a
// static allowlist check (no network/child_process imports). `toolPath` must be
// inside the skill dir. Returns { ok, output, error }.
export async function runSkillTool(toolPath, argv = []) {
  // M5: the executed tool source is attacker-controlled (a fetched skill) —
  // refuse anything over the SKILL.md cap instead of slurping a multi-GB file.
  const st = fs.statSync(toolPath)
  if (!st.isFile() || st.size > MAX_SKILL_MD_BYTES) {
    throw new Error('SKILL.tool.js exceeds the size cap — refusing to run')
  }
  const source = fs.readFileSync(toolPath, 'utf8')
  const check = checkToolImports(source)
  if (!check.ok) {
    throw new Error('SKILL.tool.js imports are not in the allowlist: ' + check.banned.join(', ') +
      ' (allowed: fs, path, os, util, crypto, url, stream, events, buffer)')
  }
  const url = pathToFileURL(toolPath).href + '?t=' + Date.now()
  const mod = await import(url)
  if (typeof mod.run !== 'function') {
    throw new Error('SKILL.tool.js must export a `run(argv)` function')
  }
  const out = await mod.run(argv)
  if (!out || typeof out.ok !== 'boolean') {
    throw new Error('SKILL.tool.js run() must return { ok: boolean, output }')
  }
  return { ok: out.ok, output: String(out.output ?? '') }
}

// `skill run <name> [-- args...]` — execute a skill's SKILL.tool.js (if any).
export async function cmdRun(args) {
  const nameIdx = args.findIndex(a => !a.startsWith('-'))
  if (nameIdx < 0) {
    console.error(c.red('Usage: skill run <name> [-- args...]'))
    console.error(c.gray('  Executes the skill\'s SKILL.tool.js (if present) with the given args.'))
    process.exit(1)
  }
  const name = args[nameIdx]
  const dash = args.indexOf('--')
  const argv = dash >= 0 ? args.slice(dash + 1) : []
  const res = resolveSkillTarget(name)
  if (!res) {
    console.error(c.red('Not found: ' + name))
    process.exit(1)
  }
  const toolPath = path.join(path.dirname(res.path), 'SKILL.tool.js')
  if (!fs.existsSync(toolPath)) {
    console.error(c.red(name + ' has no SKILL.tool.js'))
    process.exit(1)
  }
  // M1: never execute a symlinked/junctioned tool file — a planted link could
  // point at an arbitrary script outside the store.
  if (!isPlainSkillFile(toolPath)) {
    console.error(c.red(name + ' tool file is a symlink/junction — refusing to run'))
    process.exit(1)
  }
  try {
    const r = await runSkillTool(toolPath, argv)
    if (r.output) console.log(r.output.endsWith('\n') ? r.output : r.output + '\n')
    if (r.ok) console.log(c.green('✓ ') + c.bold(name) + c.gray(' tool: ok'))
    else {
      console.error(c.red('✗ ') + c.bold(name) + c.gray(' tool: returned ok=false'))
      process.exit(1)
    }
  } catch (e) {
    console.error(c.red('tool error: ') + e.message)
    process.exit(1)
  }
}
