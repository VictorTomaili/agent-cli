// src/util.js — path helpers, picocolors logger, fs utilities.
// Colors via picocolors to match the @victortomaili house style (see skill-cli).

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import c from "picocolors";

// AGENT_CLI_HOME overrides home — safe for testing (no real ~ touched),
// mirroring skill-cli's SKILL_CLI_HOME convention.
export const HOME = process.env.AGENT_CLI_HOME || os.homedir();

/** ~/.agents — the canonical source directory. */
export const AGENTS_DIR = path.join(HOME, ".agents");
/** ~/.agents/AGENTS.md — the single source of truth. */
export const MASTER_FILE = path.join(AGENTS_DIR, "AGENTS.md");
/** ~/.agents/config.json */
export const CONFIG_FILE = path.join(AGENTS_DIR, "config.json");
/** ~/.agents/backups */
export const BACKUP_DIR = path.join(AGENTS_DIR, "backups");

// --- logger ---
export const log = {
	info: (msg) => console.log(c.cyan("•"), msg),
	success: (msg) => console.log(c.green("✓"), msg),
	warn: (msg) => console.log(c.yellow("!"), msg),
	error: (msg) => console.error(c.red("✗"), msg),
	raw: (msg) => console.log(msg),
	dim: (msg) => console.log(c.dim("  " + msg)),
	kv: (k, v) => console.log(`  ${c.gray(k)} ${v}`),
};

// re-export colors for command formatting
export { c };

// --- fs helpers ---
export async function exists(p) {
	try {
		await fsp.access(p);
		return true;
	} catch {
		return false;
	}
}

export async function readFile(p) {
	return fsp.readFile(p, "utf8");
}

export async function writeFile(p, content) {
	await ensureDir(path.dirname(p));
	await fsp.writeFile(p, content, "utf8");
}

export async function ensureDir(p) {
	await fsp.mkdir(p, { recursive: true });
}

export async function readIfExists(p) {
	if (await exists(p)) return readFile(p);
	return null;
}

/** Tilde-shorten a path; normalize backslashes for cross-platform display. */
export function pretty(p) {
	if (!p) return p;
	const s = p.replace(/\\/g, "/");
	const h = HOME.replace(/\\/g, "/");
	if (s === h) return "~";
	if (s.startsWith(h + "/")) return "~" + s.slice(h.length);
	return s;
}

/** Resolve a target's relative path against home (global) or cwd (project). */
export function resolveScope(rel, scope) {
	const base = scope === "global" ? HOME : process.cwd();
	return path.resolve(base, rel);
}

/** Resolve a user-provided relative path while enforcing a filesystem root. */
export function resolveContained(root, rel) {
	if (typeof rel !== "string") return null;
	const normalized = rel.replace(/\\/g, "/");
	if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized))
		return null;
	const base = path.resolve(root);
	const candidate = path.resolve(base, normalized);
	return candidate === base || candidate.startsWith(base + path.sep)
		? candidate
		: null;
}

/** Normalize newlines for stable comparison. */
export function normalizeEndings(s) {
	return s.replace(/\r\n/g, "\n");
}

/** Check whether a home-relative marker path exists (best-effort install detection). */
export async function homeExists(rel) {
	if (!rel) return false;
	return exists(path.join(HOME, rel));
}

export { fs, fsp, path };
