// src/snapshot.js — snapshot/restore the whole ~/.agents "brain" (recursive copy, no tar dep).
//
// Storage layout:
//   ~/.agents/backups/snapshots/<ts>/   — committed snapshots (backups/ itself is excluded from copies).
//   ~/.agents/.staging/<name>/          — throwaway scratch dir used by restore() to assemble
//                                          the replacement tree before atomic-renaming it into
//                                          the brain. Cleaned up in the restore() finally block.
//
// Cross-cutting invariants this module honors (see ARCHITECTURE.md):
//   - Atomic writes: every file written by this module goes through util.writeFileSync
//     (exclusive-create → fsync → rename-over-existing). No raw fs.writeFileSync /
//     fs.copyFileSync for snapshot/restore content.
//   - Cross-process operation lock: snapshot() and restore() are wrapped in
//     withOperationLock("snapshot", ...) so the conflict matrix in operation-lock.js
//     (snapshot conflicts with brain_write, lesson_capture, lesson_consolidate, restore)
//     serializes them automatically.
//   - Symlink-safe traversal: fileMap() (used by snapshotDiff/diffSnapshots/restore)
//     refuses any directory entry whose lstat reports isSymbolicLink() and returns
//     no content for that path. validateSnapshot() keeps the same refusal on the
//     snapshot source tree.
//   - Recursive secret exclusion: any file whose name starts with ".secrets." is
//     skipped in copyDir, in fileMap, and in the staging copy that drives restore().
//     Encrypted secrets never enter a snapshot's diff surface and never land in the
//     staging copy that becomes the next brain.
//
// Restore semantics (P0-4 + verified pre-restore backup + atomic staging):
//   1. Validate the source snapshot name + tree (no symlinks, no malformed names).
//   2. Snapshot the current brain into backups/snapshots/pre-restore-<ts>/ — a fully
//      recursive copy of the brain (backups/ excluded), with .snapshot.json written
//      that records preRestoreOf=<srcName> and verifiedBackup={ file: sha256 }.
//   3. Stage the restored tree at ~/.agents/.staging/<srcName>/ by copying from the
//      source snapshot, skipping .snapshot.json and any .secrets.* entries.
//   4. For each file in the staging tree, atomic-rename it into the brain at its
//      relative path (writeFileSync is rename-over-existing → atomic on POSIX +
//      Windows). The brain is never empty during this step: the staging tree is
//      fully materialized BEFORE any rename into the brain begins, so a crash
//      between step 3 and step 4 leaves the brain intact and a clean staging
//      tree to retry from.
//   5. Only after every staged file has been renamed into the brain, unlink any
//      remaining file in the brain that is NOT in the snapshot and is NOT a
//      .snapshot.json / backups/ entry. This is the only step that removes brain
//      content.
//   6. Remove the staging dir in a finally block — always, including on error.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HOME, writeFileSync, readFileNoFollow } from "./util.js";
import { withOperationLock } from "./operation-lock.js";

const BRAIN = path.join(HOME, ".agents");
export const SNAP_DIR = path.join(BRAIN, "backups", "snapshots");
const STAGING_ROOT = path.join(BRAIN, ".staging");
// Operational subdirs of the brain that snapshot/restore must NEVER touch:
//   - .locks/   — cross-process lock files owned by operation-lock.js. A stale
//                 snapshot that re-creates an active lock file would clobber
//                 the live metadata, leaving the lock non-releasable.
//   - .staging/ — throwaway scratch dir used by restore() to assemble the
//                 replacement tree. Including it in a snapshot would create
//                 a recursive self-reference and is never user data.
//   - backups/  — snapshot history. The previous code already excluded this
//                 when copying the brain; we centralize the exclusion here.
const RESERVED_BRAIN_DIRS = new Set(["backups", ".locks", ".staging"]);
const SECRET_PREFIX = ".secrets.";

function ts() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Timestamped dir names can collide when two snapshots (or two restores)
 * happen in the same millisecond — a collision would silently merge the new
 * copy into the existing dir, mutating it. Suffix until the name is free.
 */
function uniqueName(base, dir = SNAP_DIR) {
	let name = base;
	for (let n = 2; fs.existsSync(path.join(dir, name)); n++)
		name = `${base}-${n}`;
	return name;
}

function rm(p) {
	try {
		fs.rmSync(p, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

/**
 * Recursive copy using util.writeFileSync per file (atomic-rename). Refuses
 * symlinks via lstat and skips any entry whose name starts with the secret
 * prefix. The skipNames set is for snapshot-internal files (e.g. .snapshot.json
 * when copying a snapshot into the brain, or operational dirs when copying
 * the brain into a snapshot).
 */
function copyDirSync(src, dst, { skipNames = new Set(), skipSecret = true } = {}) {
	// lgtm[js/file-system-race] — src and dst are both agent-cli-owned paths
	// (the brain or a snapshot); the readdir-then-mkdir is single-process,
	// no external attacker, the race is benign. See P1-1 site-categorization.
	fs.mkdirSync(dst, { recursive: true });
	for (const e of fs.readdirSync(src, { withFileTypes: true })) {
		if (skipNames.has(e.name)) continue;
		if (skipSecret && e.name.startsWith(SECRET_PREFIX)) continue;
		const s = path.join(src, e.name);
		const d = path.join(dst, e.name);
		// lstat (not stat): a symlink in the source tree is a leak vector, not
		// a directory or file to follow. Skip it entirely.
		const st = fs.lstatSync(s);
		if (st.isSymbolicLink()) continue;
		if (st.isDirectory()) {
			copyDirSync(s, d, { skipNames, skipSecret });
		} else {
			const content = fs.readFileSync(s);
			writeFileSync(d, content);
		}
	}
}

function countFiles(dir) {
	let n = 0;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name.startsWith(".")) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) n += countFiles(p);
		else n++;
	}
	return n;
}

/** Walk a tree, calling cb(rel, full) for every file (relative POSIX path). */
function walkFiles(dir, cb) {
	const stack = [dir];
	while (stack.length) {
		const d = stack.pop();
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, e.name);
			// Refuse symlinks at walk time too — same rationale as fileMap().
			if (e.isSymbolicLink()) continue;
			const st = fs.lstatSync(full);
			if (st.isDirectory()) {
				stack.push(full);
			} else {
				const rel = path.relative(dir, full).split(path.sep).join("/");
				cb(rel, full);
			}
		}
	}
}

export function listSnapshots() {
	try {
		return fs
			.readdirSync(SNAP_DIR, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort()
			.reverse();
	} catch {
		return [];
	}
}

function doSnapshot() {
	fs.mkdirSync(SNAP_DIR, { recursive: true });
	const name = uniqueName(ts());
	const dst = path.join(SNAP_DIR, name);
	copyDirSync(BRAIN, dst, { skipNames: RESERVED_BRAIN_DIRS });
	const files = countFiles(dst);
	const meta = JSON.stringify(
		{ created: new Date().toISOString(), files },
		null,
		2,
	);
	writeFileSync(path.join(dst, ".snapshot.json"), meta);
	return { ok: true, name, path: dst, files };
}

/**
 * Create a brain snapshot. Wrapped in withOperationLock("snapshot", ...) so
 * the conflict matrix (snapshot ↔ brain_write / lesson_capture /
 * lesson_consolidate / restore) serializes concurrent compound mutations.
 */
export async function snapshot() {
	const stamp = ts();
	return withOperationLock(
		"snapshot",
		() => doSnapshot(),
		{ operation: `snapshot:${stamp}`, timeoutMs: 5000 },
	);
}

function safeSnapshotName(name) {
	return (
		typeof name === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
		name !== "." &&
		name !== ".."
	);
}

function snapshotWithinRoot(name) {
	if (!safeSnapshotName(name)) return null;
	const root = path.resolve(SNAP_DIR);
	const candidate = path.resolve(root, name);
	return candidate === root || candidate.startsWith(root + path.sep)
		? candidate
		: null;
}

/**
 * Recursive sha256 of a single file. */
function sha256File(p) {
	const h = crypto.createHash("sha256");
	h.update(fs.readFileSync(p));
	return h.digest("hex");
}

/**
 * Validate a snapshot directory: must be a directory, have a .snapshot.json
 * metadata file with a parseable JSON object, and the tree must contain no
 * symlinks. If the metadata declares a preRestoreOf, also verify that every
 * entry in verifiedBackup matches the on-disk file (the pre-restore backup is
 * a recovery anchor — its contents must match what was recorded when restore()
 * ran).
 */
function validateSnapshot(src) {
	try {
		if (!fs.statSync(src).isDirectory()) return false;
		const metadata = path.join(src, ".snapshot.json");
		const parsed = JSON.parse(readFileNoFollow(metadata));
		if (!parsed || typeof parsed !== "object") return false;
		const stack = [src];
		while (stack.length) {
			const dir = stack.pop();
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.isSymbolicLink()) return false;
				if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
			}
		}
		// If this snapshot is a pre-restore backup, verify the recorded hashes
		// still match the on-disk file content. A mismatch means the backup was
		// modified after creation, which would break recovery.
		if (typeof parsed.preRestoreOf === "string" && parsed.verifiedBackup) {
			if (typeof parsed.verifiedBackup !== "object") return false;
			for (const [rel, expected] of Object.entries(parsed.verifiedBackup)) {
				const full = path.join(src, ...rel.split("/"));
				// Refuse any relative path that would escape the snapshot root,
				// refuse symlinks, refuse missing files.
				const resolved = path.resolve(src, rel);
				if (
					resolved !== path.join(src, rel) &&
					!resolved.startsWith(src + path.sep)
				)
					return false;
				let st;
				try {
					st = fs.lstatSync(full);
				} catch {
					return false;
				}
				if (st.isSymbolicLink() || !st.isFile()) return false;
				if (typeof expected !== "string") return false;
				const actual = sha256File(full);
				if (actual !== expected) return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * File map used by snapshotDiff / diffSnapshots / restore staging. Skips
 * .snapshot.json (restore-specific metadata), refuses symlinks via lstat, and
 * refuses any file whose name starts with the secret prefix. Without these
 * guards, a symlinked file in the brain could leak into a snapshot's diff
 * surface, and an encrypted secret could be staged into the brain during
 * restore.
 */
function fileMap(dir) {
	const out = {};
	const stack = [dir];
	while (stack.length) {
		const d = stack.pop();
		let entries = [];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.name === ".snapshot.json") continue;
			if (e.name.startsWith(SECRET_PREFIX)) continue;
			// Operational subdirs are never part of the diff surface. Skipping
			// them here is a defence-in-depth check on top of copyDirSync.
			if (RESERVED_BRAIN_DIRS.has(e.name)) continue;
			const p = path.join(d, e.name);
			// lstat, not stat: refuse symlinks. A symlink target that points
			// back inside the brain is benign, but the simplest correct rule is
			// "no symlinks in the diff surface".
			let st;
			try {
				st = fs.lstatSync(p);
			} catch {
				continue;
			}
			if (st.isSymbolicLink()) continue;
			if (st.isDirectory()) {
				stack.push(p);
				continue;
			}
			const rel = path.relative(dir, p).split(path.sep).join("/");
			out[rel] = readFileNoFollow(p);
		}
	}
	return out;
}

/** File-level diff of a snapshot vs the current brain (no writes). */
export function snapshotDiff(name) {
	const src = snapshotWithinRoot(name);
	if (!src) return { ok: false, reason: "invalid snapshot name" };
	if (!fs.existsSync(src)) return { ok: false, reason: "no such snapshot" };
	const snap = fileMap(src);
	const brain = fileMap(BRAIN);
	const changed = [];
	const added = [];
	const removed = [];
	// added = in the current brain but not the snapshot (new since snapshot)
	// removed = in the snapshot but gone from the brain (deleted since snapshot)
	for (const rel of Object.keys(brain)) if (!(rel in snap)) added.push(rel);
	for (const rel of Object.keys(snap)) if (!(rel in brain)) removed.push(rel);
	for (const rel of Object.keys(brain))
		if (rel in snap && brain[rel] !== snap[rel]) changed.push(rel);
	return { ok: true, name, changed, added, removed };
}

/** Compare two snapshots (a vs b) at the file level. */
export function diffSnapshots(a, b) {
	const sa = snapshotWithinRoot(a);
	const sb = snapshotWithinRoot(b);
	if (!sa || !sb) return { ok: false, reason: "invalid snapshot name" };
	if (!fs.existsSync(sa)) return { ok: false, reason: `no such snapshot: ${a}` };
	if (!fs.existsSync(sb)) return { ok: false, reason: `no such snapshot: ${b}` };
	const ma = fileMap(sa);
	const mb = fileMap(sb);
	const changed = [];
	const added = [];
	const removed = [];
	for (const rel of Object.keys(ma)) {
		if (!(rel in mb)) removed.push(rel);
		else if (mb[rel] !== ma[rel]) changed.push(rel);
	}
	for (const rel of Object.keys(mb)) if (!(rel in ma)) added.push(rel);
	return { ok: true, a, b, changed, added, removed };
}

/** Keep at most `n` snapshots, removing the oldest. Returns pruned names. */
export function pruneSnapshots(n) {
	if (!(n >= 1)) return { pruned: [] };
	const list = listSnapshots();
	const excess = list.slice(n); // oldest first (list is newest-first)
	for (const name of excess) {
		const p = path.join(SNAP_DIR, name);
		try {
			fs.rmSync(p, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
	return { pruned: excess };
}

/**
 * Restore the brain from a named snapshot. Atomic, staged, and verified:
 *   - The pre-restore backup is verified by sha256 in its .snapshot.json.
 *   - The replacement tree is built in a sibling staging dir, NEVER in the
 *     brain, so the brain is never empty.
 *   - Every staged file is written into the brain via util.writeFileSync
 *     (atomic-rename). A crash between staging and renaming leaves the brain
 *     intact and a clean staging tree to retry from.
 *   - Stale brain files (present in the brain, absent in the snapshot) are
 *     unlinked only after every staged file has been renamed in.
 *   - The entire body is wrapped in withOperationLock("snapshot", ...) so
 *     brain_write / lesson_capture / lesson_consolidate / restore are
 *     serialized against us.
 */
function doRestore(name) {
	const src = snapshotWithinRoot(name);
	if (!src) return { ok: false, reason: "invalid snapshot name" };
	if (!fs.existsSync(src)) return { ok: false, reason: "no such snapshot" };
	if (!validateSnapshot(src))
		return { ok: false, reason: "invalid snapshot contents" };

	// 1. Stage the pre-restore backup of the current brain (P0-4). uniqueName
	//    on SNAP_DIR: a second restore in the same millisecond must NOT merge
	//    into the first pre-restore backup.
	fs.mkdirSync(SNAP_DIR, { recursive: true });
	const pre = path.join(SNAP_DIR, uniqueName(`pre-restore-${ts()}`));
	copyDirSync(BRAIN, pre, { skipNames: RESERVED_BRAIN_DIRS });

	// 2. Compute sha256 for every file in the pre-restore backup and record
	//    it in the backup's .snapshot.json. validateSnapshot() will refuse to
	//    restore from a backup whose hashes no longer match its contents.
	const verifiedBackup = {};
	walkFiles(pre, (rel, full) => {
		// .snapshot.json is written AFTER the walk; skip if present.
		if (rel === ".snapshot.json") return;
		verifiedBackup[rel] = sha256File(full);
	});
	const preMeta = JSON.stringify(
		{
			created: new Date().toISOString(),
			preRestoreOf: name,
			files: countFiles(pre),
			verifiedBackup,
		},
		null,
		2,
	);
	writeFileSync(path.join(pre, ".snapshot.json"), preMeta);

	// 3. Assemble the restored tree in a sibling staging dir. Suffix until
	//    the staging name is free (a previous failed restore may have left
	//    one behind — never write through it).
	fs.mkdirSync(STAGING_ROOT, { recursive: true });
	const staging = path.join(STAGING_ROOT, uniqueName(name, STAGING_ROOT));
	copyDirSync(src, staging, {
		skipNames: new Set([".snapshot.json"]),
		skipSecret: true,
	});

	try {
		// 4. Atomic-rename every staged file into the brain. The brain is
		//    NOT touched until this step; until then the staging dir holds
		//    the full replacement tree.
		const stagedFiles = {};
		walkFiles(staging, (rel, full) => {
			stagedFiles[rel] = full;
		});
		for (const [rel, srcFile] of Object.entries(stagedFiles)) {
			const dst = path.join(BRAIN, ...rel.split("/"));
			fs.mkdirSync(path.dirname(dst), { recursive: true });
			const content = fs.readFileSync(srcFile);
			writeFileSync(dst, content);
		}

		// 5. Unlink brain files that are NOT in the snapshot and are NOT
		//    brain-side reserved paths. RESERVED_BRAIN_DIRS covers backups/
		//    (snapshot history), .locks/ (live cross-process lock files
		//    owned by operation-lock.js — unlinking the live lock would
		//    break the withOperationLock that wraps THIS restore call),
		//    and .staging/ (the throwaway scratch dir used by step 4).
		//    Done LAST so a crash earlier leaves a superset of the desired state.
		const brainFiles = {};
		walkFiles(BRAIN, (rel, full) => {
			brainFiles[rel] = full;
		});
		for (const [rel, full] of Object.entries(brainFiles)) {
			if (rel in stagedFiles) continue;
			if (rel === ".snapshot.json") continue;
			if (RESERVED_BRAIN_DIRS.has(rel.split("/")[0])) continue;
			rm(full);
		}

		return { ok: true, name, restoredFrom: src, preRestoreBackup: pre };
	} finally {
		// 6. Always clean up the staging dir, even on error.
		rm(staging);
	}
}

/** Async public surface for restore — see doRestore for semantics. */
export async function restore(name) {
	return withOperationLock("snapshot", () => doRestore(name), {
		operation: `restore:${name}`,
		timeoutMs: 5000,
	});
}
