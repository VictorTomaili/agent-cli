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

export function restore(name) {
	const src = path.join(SNAP_DIR, name);
	if (!fs.existsSync(src)) return { ok: false, reason: "no such snapshot" };
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
