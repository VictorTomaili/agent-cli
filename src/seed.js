// src/seed.js — shipped default content (seed/) + safe staged-update primitives.
//
// agent-cli ships default sub-agent personalities (and later more) under `seed/`.
// The tool NEVER silently overwrites a user's existing ~/.agents/ files:
//   - First install (config.seedVersion == null): seed defaults land directly in
//     ~/.agents/ (skipping any file the user already has).
//   - Version upgrade (seedVersion != currentVersion): the new defaults are STAGED
//     into ~/.agents/update-<version>/ for the using-agent to review and migrate
//     with the user's consent. Existing user files are never touched.
//
// The tool provides primitives only. All migration decisions are the using-agent's.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	exists,
	readFile,
	writeFile,
	ensureDir,
	AGENTS_DIR,
	resolveContained,
} from "./util.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Bundled seed defaults: <pkg>/seed */
export const SEED_DIR = path.join(MODULE_DIR, "..", "seed");

const UPDATE_PREFIX = "update-";
const UPDATE_RE = /^update-(\d+\.\d+\.\d+(?:[-+].*)?)$/;

/**
 * Walk a directory tree, returning relative paths (posix-style) of all files.
 * M5: bounded — the shipped seed tree is repo-owned, but a packaging accident
 * (deep nesting or a huge tree) must not turn `agent init` into a DoS.
 */
const SEED_MAX_DEPTH = 8;
const SEED_MAX_ENTRIES = 5000;

async function walk(relRoot, depth = 0) {
	if (depth > SEED_MAX_DEPTH) return [];
	const out = [];
	let entries = [];
	try {
		entries = await fs.readdir(relRoot, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (out.length >= SEED_MAX_ENTRIES) return out;
		const full = path.join(relRoot, e.name);
		if (e.isDirectory()) {
			out.push(...(await walk(full, depth + 1)).map((p) => `${e.name}/${p}`));
		} else if (e.isFile()) {
			out.push(e.name);
		}
	}
	return out;
}

/** List shipped seed entries: [{ rel, abs }]. rel is posix-style (e.g. agents/scout.md). */
export async function listSeedFiles({ seedDir = SEED_DIR } = {}) {
	const rels = await walk(seedDir);
	return rels
		.filter((r) => r.endsWith(".md"))
		.map((rel) => ({ rel, abs: path.join(seedDir, ...rel.split("/")) }));
}

/**
 * First-install seeding: copy each seed into `home` (e.g. ~/.agents), SKIPPING any
 * file that already exists. Never clobbers. Returns { installed, skipped }.
 */
export async function installSeeds({
	home = AGENTS_DIR,
	seedDir = SEED_DIR,
	overwrite = false,
} = {}) {
	const seeds = await listSeedFiles({ seedDir });
	const installed = [];
	const skipped = [];
	for (const { rel, abs } of seeds) {
		const target = path.join(home, ...rel.split("/"));
		if (!overwrite && (await exists(target))) {
			skipped.push(rel);
			continue;
		}
		await ensureDir(path.dirname(target));
		await fs.copyFile(abs, target);
		installed.push(rel);
	}
	return { installed, skipped };
}

/** Realpath of `p`, or of its deepest existing ancestor (null at the fs root). */
async function realpathOfExisting(p) {
	let cur = p;
	for (;;) {
		try {
			return await fs.realpath(cur);
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return null;
			cur = parent;
		}
	}
}

/** true when `p` is inside `base` (or equal), with path.sep boundaries. */
function isInside(base, p) {
	return p === base || p.startsWith(base + path.sep);
}

/** lstat of `p`, or null when it does not exist. */
async function lstatIfExists(p) {
	try {
		return await fs.lstat(p);
	} catch {
		return null;
	}
}

/**
 * Guard a staging dir against symlink / reparse-point (Windows junction) escapes.
 * A pre-existing `update-<version>` link would let copyFile/ensureDir write through
 * to an arbitrary directory, so we reject it instead of writing. Node's lstat
 * reports Windows junctions as S_IFLNK (mode 0o120000), so isSymbolicLink() covers
 * both symlinks and junctions; realpath containment is the fallback for platforms
 * or Node versions where a reparse point reports differently.
 * Returns null when safe (create/write may proceed), or { ok:false, reason } when
 * the staging dir must be rejected.
 */
async function guardStageDir(home, stageDir) {
	const st = await lstatIfExists(stageDir);
	if (st?.isSymbolicLink()) {
		return {
			ok: false,
			reason: `refusing to stage: ${stageDir} already exists as a symlink or reparse point (junction)`,
		};
	}
	// Fallback: the fully-resolved staging dir must stay inside the real home.
	const realHome = await realpathOfExisting(home);
	const realStage = await realpathOfExisting(stageDir);
	if (realStage && realHome && !isInside(realHome, realStage)) {
		return {
			ok: false,
			reason: `refusing to stage: ${stageDir} resolves outside ${home}`,
		};
	}
	return null;
}

/**
 * Staged upgrade: copy every seed into `home/update-<version>/` for the using-agent
 * to review and migrate. Never touches the real files under `home` (except the new
 * staging dir). Rejects a pre-existing `update-<version>` symlink or Windows junction
 * (or any staging dir whose realpath escapes `home`) with a thrown error rather than
 * writing through it. Returns { version, path: stageDir, staged: [rel] } on success.
 */
export async function stageSeeds({
	home = AGENTS_DIR,
	seedDir = SEED_DIR,
	version,
	previousFiles = [],
}) {
	if (!version) throw new Error("stageSeeds: version is required");
	const stageDir = path.join(home, `${UPDATE_PREFIX}${version}`);
	const unsafe = await guardStageDir(home, stageDir);
	if (unsafe) throw new Error(`stageSeeds: ${unsafe.reason}`);
	const seeds = await listSeedFiles({ seedDir });
	const currentFiles = seeds.map(({ rel }) => rel).sort();
	const removed = previousFiles
		.filter((rel) => !currentFiles.includes(rel))
		.sort();
	const staged = [];
	for (const { rel, abs } of seeds) {
		const target = path.join(stageDir, ...rel.split("/"));
		await ensureDir(path.dirname(target));
		await fs.copyFile(abs, target);
		staged.push(rel);
	}
	await fs.writeFile(
		path.join(stageDir, "removed.json"),
		JSON.stringify(removed, null, 2) + "\n",
		"utf8",
	);
	return { version, path: stageDir, staged, removed };
}

/** Decide install-vs-stage given the previously-seeded version. Pure helper (no I/O). */
export function planSeedAction(prevSeedVersion, currentVersion) {
	if (prevSeedVersion == null) return { action: "install" };
	if (prevSeedVersion !== currentVersion)
		return { action: "stage", from: prevSeedVersion, to: currentVersion };
	return { action: "none" };
}

/** List staged update payloads under `home`: [{ version, path, files: [rel] }], newest last. */
export async function listStagedUpdates({ home = AGENTS_DIR } = {}) {
	if (!(await exists(home))) return [];
	let entries = [];
	try {
		entries = await fs.readdir(home, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const m = e.name.match(UPDATE_RE);
		if (!m) continue;
		const dir = path.join(home, e.name);
		const files = (await walk(dir)).filter((f) => f.endsWith(".md")).sort();
		let removed = [];
		try {
			removed = JSON.parse(
				await fs.readFile(path.join(dir, "removed.json"), "utf8"),
			);
			if (!Array.isArray(removed)) removed = [];
		} catch {
			removed = [];
		}
		out.push({ version: m[1], path: dir, files, removed });
	}
	return out.sort((a, b) =>
		a.version.localeCompare(b.version, undefined, { numeric: true }),
	);
}

/** Read one staged file's content (primitive for the using-agent to inspect/diff). */
export async function readStagedFile(version, rel, { home = AGENTS_DIR } = {}) {
	const stageDir = path.join(home, `${UPDATE_PREFIX}${version}`);
	const fp = resolveContained(stageDir, rel);
	if (!fp || !(await exists(fp))) return null;
	return readFile(fp);
}

/** Minimal LCS line diff with unified-style prefixes:
 *  ` ` common · `-` live-only · `+` staged-only. Pure (no I/O). */
export function diffLines(live, staged) {
	const split = (s) => {
		const t = s ?? "";
		return t === "" ? [] : t.split("\n");
	};
	const A = split(live);
	const B = split(staged);
	const m = A.length;
	const n = B.length;
	const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
	for (let i = m - 1; i >= 0; i--)
		for (let j = n - 1; j >= 0; j--)
			dp[i][j] =
				A[i] === B[j]
					? dp[i + 1][j + 1] + 1
					: Math.max(dp[i + 1][j], dp[i][j + 1]);
	const out = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (A[i] === B[j]) {
			out.push(" " + A[i]);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push("-" + A[i]);
			i++;
		} else {
			out.push("+" + B[j]);
			j++;
		}
	}
	while (i < m) out.push("-" + A[i++]);
	while (j < n) out.push("+" + B[j++]);
	return out.join("\n");
}

/** Remove a staged update payload dir once adopted or dismissed. */
export async function clearStaged(version, { home = AGENTS_DIR } = {}) {
	const name = `${UPDATE_PREFIX}${version ?? ""}`;
	if (!UPDATE_RE.test(name)) {
		return { ok: false, reason: "invalid version", version };
	}
	const dir = path.join(home, name);
	if (!(await exists(dir))) return { ok: false, reason: "not found", version };
	await fs.rm(dir, { recursive: true, force: true });
	return { ok: true, version, path: dir };
}

/**
 * Apply a staged update payload into the live brain. Non-destructive: a live
 * file that differs from the staged content is REFUSED (manual merge), and every
 * applied file is backed up to `backups/apply-<version>/` first. Clears the staged
 * payload on success. Returns { applied, skipped, backedUp }.
 */
export async function applyStaged(version, { home = AGENTS_DIR } = {}) {
	const payload = (await listStagedUpdates({ home })).find(
		(s) => s.version === version,
	);
	if (!payload) return { ok: false, reason: `no staged update for ${version}` };
	const applied = [];
	const skipped = [];
	const backedUp = [];
	for (const rel of payload.files) {
		const staged = await readStagedFile(version, rel, { home });
		const livePath = resolveContained(home, rel);
		if (!livePath || staged == null) {
			skipped.push({ rel, reason: "invalid or missing staged file" });
			continue;
		}
		if (await exists(livePath)) {
			const live = await readFile(livePath);
			if (live !== staged) {
				// diverged (user content or older seed) — refuse to clobber.
				skipped.push({ rel, reason: "diverged — manual merge required" });
				continue;
			}
			const backupDir = path.join(home, "backups", `apply-${version}`);
			const backupFile = path.join(backupDir, rel);
			await ensureDir(path.dirname(backupFile));
			await writeFile(backupFile, live);
			backedUp.push(rel);
		}
		await writeFile(livePath, staged);
		applied.push(rel);
	}
	if (skipped.length === 0) await clearStaged(version, { home });
	return {
		ok: true,
		version,
		applied,
		skipped,
		backedUp,
		diffStat: { applied: applied.length, skipped: skipped.length },
	};
}
