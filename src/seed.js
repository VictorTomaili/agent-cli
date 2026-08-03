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
import { exists, readFile, ensureDir, AGENTS_DIR } from "./util.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Bundled seed defaults: <pkg>/seed */
export const SEED_DIR = path.join(MODULE_DIR, "..", "seed");

const UPDATE_PREFIX = "update-";
const UPDATE_RE = /^update-(\d+\.\d+\.\d+(?:[-+].*)?)$/;

/** Walk a directory tree, returning relative paths (posix-style) of all files. */
async function walk(relRoot) {
	const out = [];
	let entries = [];
	try {
		entries = await fs.readdir(relRoot, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const full = path.join(relRoot, e.name);
		if (e.isDirectory()) {
			out.push(...(await walk(full)).map((p) => `${e.name}/${p}`));
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

/**
 * Staged upgrade: copy every seed into `home/update-<version>/` for the using-agent
 * to review and migrate. Never touches the real files under `home` (except the new
 * staging dir). Returns { version, path, staged: [rel] }.
 */
export async function stageSeeds({
	home = AGENTS_DIR,
	seedDir = SEED_DIR,
	version,
}) {
	if (!version) throw new Error("stageSeeds: version is required");
	const stageDir = path.join(home, `${UPDATE_PREFIX}${version}`);
	const seeds = await listSeedFiles({ seedDir });
	const staged = [];
	for (const { rel, abs } of seeds) {
		const target = path.join(stageDir, ...rel.split("/"));
		await ensureDir(path.dirname(target));
		await fs.copyFile(abs, target);
		staged.push(rel);
	}
	return { version, path: stageDir, staged };
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
		out.push({ version: m[1], path: dir, files });
	}
	return out.sort((a, b) =>
		a.version.localeCompare(b.version, undefined, { numeric: true }),
	);
}

/** Read one staged file's content (primitive for the using-agent to inspect/diff). */
export async function readStagedFile(version, rel, { home = AGENTS_DIR } = {}) {
	const fp = path.join(home, `${UPDATE_PREFIX}${version}`, ...rel.split("/"));
	if (!(await exists(fp))) return null;
	return readFile(fp);
}

/** Remove a staged update payload dir once adopted or dismissed. */
export async function clearStaged(version, { home = AGENTS_DIR } = {}) {
	const dir = path.join(home, `${UPDATE_PREFIX}${version}`);
	if (!(await exists(dir))) return { ok: false, reason: "not found", version };
	await fs.rm(dir, { recursive: true, force: true });
	return { ok: true, version, path: dir };
}
