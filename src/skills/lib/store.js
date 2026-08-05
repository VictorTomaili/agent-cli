import fs from 'node:fs'
import path from 'node:path'
import { STORE_DIR, CLI_ROOT } from './paths.js'
import { parseSkillMd, getTriggers } from './frontmatter.js'

// --- M1: symlink / Windows-junction containment for the skill store ----------
// The store base and every skill dir inside it must be REAL directories. A
// symlinked or junctioned store (or skill dir) would let install/update/remove
// write or delete THROUGH the link into an arbitrary directory. Node's lstat
// reports Windows junctions as S_IFLNK, so isSymbolicLink() covers both.

/** Realpath of `p`, or of its deepest existing ancestor (null at the fs root). */
function realpathOfExisting(p) {
	let cur = p;
	for (;;) {
		try {
			return fs.realpathSync(cur);
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return null;
			cur = parent;
		}
	}
}

/** lstat of `p`, or null when it does not exist. */
function lstatIfExists(p) {
	try {
		return fs.lstatSync(p);
	} catch {
		return null;
	}
}

/**
 * Guard the store base: STORE_DIR must either not exist (it will be created) or
 * resolve strictly inside CLI_ROOT. A pre-existing symlink/junction at the store
 * path would make every write escape. Returns null when safe, else an Error.
 */
export function guardStoreBase() {
	const st = lstatIfExists(STORE_DIR);
	if (st?.isSymbolicLink()) {
		return new Error(
			`refusing to use skill store: ${STORE_DIR} is a symlink or reparse point (junction)`,
		);
	}
	const realRoot = realpathOfExisting(CLI_ROOT);
	const realStore = realpathOfExisting(STORE_DIR);
	if (realStore && realRoot && realStore !== realRoot && !realStore.startsWith(realRoot + path.sep)) {
		return new Error(
			`refusing to use skill store: ${STORE_DIR} resolves outside ${CLI_ROOT}`,
		);
	}
	return null;
}

/**
 * true when `dir` (or any entry inside it, recursively) is a symlink or Windows
 * junction. Fetched skills are attacker-controlled: a planted `helper.js ->
 * ../../victim` would otherwise be copied as a link and every later read would
 * follow it out of the store.
 */
export function containsSymlinks(dir) {
	let stack = [dir];
	while (stack.length) {
		const cur = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(cur, { withFileTypes: true });
		} catch {
			continue; // unreadable or vanished mid-walk — treated as clean
		}
		for (const e of entries) {
			if (e.isSymbolicLink()) return true;
			if (e.isDirectory()) stack.push(path.join(cur, e.name));
		}
	}
	return false;
}

/**
 * Copy a fetched skill dir into the store, refusing any tree that contains
 * symlinks/junctions (they'd escape on later reads). The dest must not already
 * be a symlink either — cpSync would write THROUGH it. Returns null on success,
 * else the rejection reason.
 */
export function copySkillIntoStore(srcDir, dest) {
	if (lstatIfExists(dest)?.isSymbolicLink()) {
		return `${dest} already exists as a symlink or reparse point (junction)`;
	}
	if (containsSymlinks(srcDir)) {
		return `fetched skill contains a symlink or junction — refusing to install`;
	}
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	// dereference:false is the default (symlinks as links); we already verified
	// none exist, so a plain recursive copy is safe.
	fs.cpSync(srcDir, dest, { recursive: true });
	return null;
}

export function skillDir(name) { return path.join(STORE_DIR, name) }
export function skillMdPath(name) { return path.join(skillDir(name), 'SKILL.md') }

// Scan the store for all skills (name, description, version, triggers, path)
export function listStore() {
  if (!fs.existsSync(STORE_DIR)) return []
  const out = []
  for (const entry of fs.readdirSync(STORE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    // M1: a symlink/junction in the store must not be scanned (reads follow it).
    if (entry.isSymbolicLink()) continue
    const md = skillMdPath(entry.name)
    if (!fs.existsSync(md)) continue
    if (!isPlainSkillFile(md)) continue
    try {
      const { data } = parseSkillMd(fs.readFileSync(md, 'utf8'))
      out.push({
        name: data.name || entry.name,
        dir: entry.name,
        description: data.description || '',
        version: data.version || '-',
        triggers: getTriggers(data),
        path: md,
      })
    } catch { /* broken skill → skip */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// A skill name is a plain identifier (alnum/._-, starting alnum). Rejecting path
// separators and ".." closes a path-traversal surface: `skill cat ../../x` can't
// escape STORE_DIR via the dir-name path. Exported so install/update can reuse it
// on the WRITE path — the dangerous one: a malicious frontmatter `name: ../x`
// could otherwise rmSync/cpSync outside STORE_DIR.
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// Returns a safe skill name (alnum/._- only, no "..", resolving strictly inside
// STORE_DIR) or null if `name` could escape the store. Call before joining any
// untrusted name (frontmatter `name`, fetched dir name) onto STORE_DIR.
export function sanitizeSkillName(name) {
  const n = String(name ?? '').trim()
  if (!SAFE_NAME.test(n) || n.includes('..')) return null
  const root = path.resolve(STORE_DIR)
  const dest = path.resolve(STORE_DIR, n)
  if (dest !== root && !dest.startsWith(root + path.sep)) return null
  return n
}

/**
 * M1 read-side guard: a SKILL.md (or its skill dir) that is a symlink/junction
 * must be skipped, not followed — a planted link could point anywhere. Returns
 * true when the file is a plain regular file inside a real directory.
 */
export function isPlainSkillFile(md) {
  try {
    if (fs.lstatSync(md).isSymbolicLink()) return false;
    const dirSt = fs.lstatSync(path.dirname(md));
    if (dirSt.isSymbolicLink()) return false;
    return true;
  } catch {
    return false;
  }
}

export function readSkill(nameOrDir) {
  const n = String(nameOrDir)
  let md = SAFE_NAME.test(n) && !n.includes('..') && fs.existsSync(skillMdPath(n)) ? skillMdPath(n) : null
  if (!md) {
    const hit = listStore().find(s => s.name.toLowerCase() === n.toLowerCase())
    if (!hit) return null
    md = hit.path
  }
  if (!isPlainSkillFile(md)) return null
  const { data, body } = parseSkillMd(fs.readFileSync(md, 'utf8'))
  return { name: data.name || n, data, body, path: md }
}
