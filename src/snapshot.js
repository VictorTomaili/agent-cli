// src/snapshot.js — snapshot/restore the whole ~/.agents "brain" (recursive copy, no tar dep).
// Snapshots live in ~/.agents/backups/snapshots/<ts>/ (backups/ itself is excluded from copies).

import fs from "node:fs";
import path from "node:path";
import { HOME, ensureDir } from "./util.js";

const BRAIN = path.join(HOME, ".agents");
export const SNAP_DIR = path.join(BRAIN, "backups", "snapshots");

function ts() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}
function rm(p) {
	try {
		fs.rmSync(p, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}
function copyDir(src, dst, skipNames) {
	fs.mkdirSync(dst, { recursive: true });
	for (const e of fs.readdirSync(src, { withFileTypes: true })) {
		if (skipNames && skipNames.has(e.name)) continue;
		if (e.name.startsWith(".secrets.")) continue; // never back up encrypted secrets
		const s = path.join(src, e.name);
		const d = path.join(dst, e.name);
		if (e.isDirectory()) copyDir(s, d, skipNames);
		else fs.copyFileSync(s, d);
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

export function snapshot() {
	ensureDir(SNAP_DIR);
	const name = ts();
	const dst = path.join(SNAP_DIR, name);
	copyDir(BRAIN, dst, new Set(["backups"]));
	const files = countFiles(dst);
	fs.writeFileSync(
		path.join(dst, ".snapshot.json"),
		JSON.stringify({ created: new Date().toISOString(), files }, null, 2),
	);
	return { ok: true, name, path: dst, files };
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

function validateSnapshot(src) {
	try {
		if (!fs.statSync(src).isDirectory()) return false;
		const metadata = path.join(src, ".snapshot.json");
		if (!fs.lstatSync(metadata).isFile()) return false;
		const parsed = JSON.parse(fs.readFileSync(metadata, "utf8"));
		if (!parsed || typeof parsed !== "object") return false;
		const stack = [src];
		while (stack.length) {
			const dir = stack.pop();
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.isSymbolicLink()) return false;
				if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
			}
		}
		return true;
	} catch {
		return false;
	}
}

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
			const p = path.join(d, e.name);
			const rel = path.relative(dir, p).split(path.sep).join("/");
			if (e.isDirectory()) stack.push(p);
			else out[rel] = fs.readFileSync(p, "utf8");
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

export function restore(name) {
	const src = snapshotWithinRoot(name);
	if (!src) return { ok: false, reason: "invalid snapshot name" };
	if (!fs.existsSync(src)) return { ok: false, reason: "no such snapshot" };
	if (!validateSnapshot(src))
		return { ok: false, reason: "invalid snapshot contents" };
	// safety: back up current brain first
	const pre = path.join(SNAP_DIR, `pre-restore-${ts()}`);
	copyDir(BRAIN, pre, new Set(["backups"]));
	// wipe brain (except backups/), then copy snapshot in
	for (const e of fs.readdirSync(BRAIN, { withFileTypes: true })) {
		if (e.name !== "backups") rm(path.join(BRAIN, e.name));
	}
	copyDir(src, BRAIN, new Set([".snapshot.json"]));
	return { ok: true, name, restoredFrom: src, preRestoreBackup: pre };
}
