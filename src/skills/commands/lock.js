import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import c from 'picocolors'
import { resolveSkillTarget } from './validate.js'
import { skillDir } from '../lib/store.js'

export const LOCK_FILE = 'skill.lock'

// Content hash of SKILL.md — the fingerprint used to detect drift between the
// store copy and what `update` would re-fetch.
export function skillContentHash(mdPath) {
  return createHash('sha256').update(fs.readFileSync(mdPath, 'utf8')).digest('hex').slice(0, 16)
}

// Try to read the git HEAD short sha of a dir (temp fetch checkouts). Best-effort.
function gitRevision(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 5000,
    }).trim()
    return out || null
  } catch { return null }
}

// Write <dest>/skill.lock recording the provenance + content hash. Used by
// `install` after moving a fetched skill into the store, and by `skill lock` to
// (re)create it for locally-authored skills.
export function writeLock(destDir, source, { revision = null } = {}) {
  const mdPath = path.join(destDir, 'SKILL.md')
  const hash = fs.existsSync(mdPath) ? skillContentHash(mdPath) : null
  const lock = {
    version: 1,
    source: source || null,
    revision: revision || gitRevision(destDir),
    contentHash: hash,
    installedAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(destDir, LOCK_FILE), JSON.stringify(lock, null, 2) + '\n', 'utf8')
  return lock
}

export function readLock(name) {
  const p = path.join(skillDir(name), LOCK_FILE)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// `skill lock <name> [--source <src>]` — (re)write the provenance lock for a
// skill. For store skills the lock records source + content hash; running it
// after hand-editing a store skill refreshes the hash.
export function cmdLock(args) {
  const name = args.find(a => !a.startsWith('-'))
  if (!name) {
    console.error(c.red('Usage: skill lock <name> [--source <source>]'))
    process.exit(1)
  }
  const res = resolveSkillTarget(name)
  if (!res) {
    console.error(c.red('Not found: ' + name))
    process.exit(1)
  }
  const srcIdx = args.indexOf('--source')
  const source = srcIdx >= 0 ? args[srcIdx + 1] : readLock(res.name)?.source
  const lock = writeLock(path.dirname(res.path), source)
  console.log(c.green('✓') + ' locked ' + c.bold(res.name) + c.gray(' — ' + res.path))
  console.log(c.gray('  source: ') + (lock.source || '—'))
  console.log(c.gray('  revision: ') + (lock.revision || '—'))
  console.log(c.gray('  contentHash: ') + lock.contentHash)
}
