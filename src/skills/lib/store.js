import fs from "node:fs";
import path from "node:path";
import { STORE_DIR, CLI_ROOT } from "./paths.js";
import {
	parseSkillMd,
	getTriggers,
	getVersion,
	getLicense,
	getCompatibility,
	stringField,
} from "./frontmatter.js";

// --- M5: bounded reads/traversals (local-DoS guard) --------------------------
// A fetched skill is attacker-controlled: a giant SKILL.md or a zip-bomb tree
// must not make list/read/install/update spend unbounded time or memory.

/** Largest SKILL.md we will parse (1 MiB — real skill docs are a few KB). */
export const MAX_SKILL_MD_BYTES = 1 << 20;
/** Max entries visited by a recursive store walk (100k nested files is hostile). */
export const MAX_WALK_ENTRIES = 100_000;
/** Max recursion depth for a store walk. */
export const MAX_WALK_DEPTH = 24;

/**
 * Read a SKILL.md with a size cap. Returns null when the file is missing or
 * exceeds the cap (a hostile skill must not be parsed, listed, or executed).
 */
export function readSkillMdBounded(md) {
	let st;
	try {
		st = fs.statSync(md);
	} catch {
		return null;
	}
	if (!st.isFile() || st.size > MAX_SKILL_MD_BYTES) return null;
	return fs.readFileSync(md, "utf8");
}

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
	if (
		realStore &&
		realRoot &&
		realStore !== realRoot &&
		!realStore.startsWith(realRoot + path.sep)
	) {
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
	const stack = [{ d: dir, depth: 0 }];
	let visited = 0;
	while (stack.length) {
		const { d, depth } = stack.pop();
		if (depth > MAX_WALK_DEPTH) return true; // hostile depth — treat as unsafe
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			continue; // unreadable or vanished mid-walk — treated as clean
		}
		for (const e of entries) {
			if (visited++ > MAX_WALK_ENTRIES) return true; // zip-bomb — unsafe
			if (e.isSymbolicLink()) return true;
			if (e.isDirectory())
				stack.push({ d: path.join(d, e.name), depth: depth + 1 });
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

export function skillDir(name) {
	return path.join(STORE_DIR, name);
}
export function skillMdPath(name) {
	return path.join(skillDir(name), "SKILL.md");
}

// Scan the store for all skills (name, description, version, triggers, path)
export function listStore() {
	if (!fs.existsSync(STORE_DIR)) return [];
	const out = [];
	for (const entry of fs.readdirSync(STORE_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		// M1: a symlink/junction in the store must not be scanned (reads follow it).
		if (entry.isSymbolicLink()) continue;
		const md = skillMdPath(entry.name);
		if (!fs.existsSync(md)) continue;
		if (!isPlainSkillFile(md)) continue;
		// M5: a hostile skill with an oversized SKILL.md must not be listed/parsed.
		const raw = readSkillMdBounded(md);
		if (raw == null) continue;
		try {
			const { data, parseError } = parseSkillMd(raw);
			out.push({
				// GAP-6: frontmatter name/description/version are untrusted — only real
				// strings surface (a number `name` would crash padEnd/localeCompare;
				// an object `description` would render "[object Object]").
				name: stringField(data.name) || entry.name,
				dir: entry.name,
				description: stringField(data.description),
				version: getVersion(data) || "-",
				triggers: getTriggers(data),
				// Agent Skills spec fields, surfaced for display (agentskills.io).
				license: getLicense(data),
				compatibility: getCompatibility(data),
				path: md,
				// GAP-15: carry the YAML parse error so list/show can surface it bounded.
				parseError: parseError || null,
			});
		} catch {
			/* broken skill → skip */
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

// A skill name is a plain identifier (alnum/._-, starting alnum). Rejecting path
// separators and ".." closes a path-traversal surface: `skill cat ../../x` can't
// escape STORE_DIR via the dir-name path. Exported so install/update can reuse it
// on the WRITE path — the dangerous one: a malicious frontmatter `name: ../x`
// could otherwise rmSync/cpSync outside STORE_DIR.
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Returns a safe skill name (alnum/._- only, no "..", resolving strictly inside
// STORE_DIR) or null if `name` could escape the store. Call before joining any
// untrusted name (frontmatter `name`, fetched dir name) onto STORE_DIR.
export function sanitizeSkillName(name) {
	const n = String(name ?? "").trim();
	if (!SAFE_NAME.test(n) || n.includes("..")) return null;
	const root = path.resolve(STORE_DIR);
	const dest = path.resolve(STORE_DIR, n);
	if (dest !== root && !dest.startsWith(root + path.sep)) return null;
	return n;
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
	const n = String(nameOrDir);
	let md =
		SAFE_NAME.test(n) && !n.includes("..") && fs.existsSync(skillMdPath(n))
			? skillMdPath(n)
			: null;
	if (!md) {
		const hit = listStore().find((s) => s.name.toLowerCase() === n.toLowerCase());
		if (!hit) return null;
		md = hit.path;
	}
	if (!isPlainSkillFile(md)) return null;
	const raw = readSkillMdBounded(md);
	if (raw == null) return null; // missing or exceeds the size cap
	const { data, body, parseError } = parseSkillMd(raw);
	return {
		name: stringField(data.name) || n,
		data,
		body,
		path: md,
		parseError: parseError || null,
	};
}
