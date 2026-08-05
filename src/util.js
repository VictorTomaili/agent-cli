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
/** ~/AGENTS.md — the canonical single source of truth (relocated from ~/.agents/AGENTS.md). */
export const MASTER_FILE = path.join(HOME, "AGENTS.md");
/** ~/.agents/AGENTS.md — the agent-cli-managed pointer stub that points at MASTER_FILE. */
export const POINTER_MASTER_FILE = path.join(AGENTS_DIR, "AGENTS.md");
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

/** Remove ANSI escape sequences (SGR/CSI) from a string — JSON must be plain. */
const ANSI_RE =
	/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
export function stripAnsi(s) {
	return String(s ?? "").replace(ANSI_RE, "");
}

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

/** M3: exclusive-create + fsync + atomic-rename. Write content to a unique temp
 *  file, fsync it, then rename over the target. Rename-over-existing is atomic
 *  on POSIX and on Windows (libuv uses MoveFileEx with REPLACE_EXISTING), so a
 *  reader never sees a partial or absent target except in the rare locked-file
 *  fallback, which we reach only after retrying. */
export async function writeFile(p, content) {
	await ensureDir(path.dirname(p));
	let tmp;
	for (let attempt = 0; ; attempt++) {
		tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
		try {
			// 'wx' = exclusive create: a symlink pre-planted at the tmp path is
			// never followed (EEXIST → fresh random name).
			const fh = await fsp.open(tmp, "wx");
			try {
				await fh.writeFile(content, "utf8");
				await fh.sync(); // promote only fully-durable bytes
			} finally {
				await fh.close();
			}
			break;
		} catch (error) {
			if (error?.code !== "EEXIST" || attempt >= 3) throw error;
		}
	}
	try {
		try {
			await fsp.rename(tmp, p);
		} catch (error) {
			// Windows: rename fails with EEXIST/EPERM/ENOTEMPTY when the target is
			// momentarily locked (open without FILE_SHARE_DELETE) or is a
			// directory. Transient locks clear fast — retry before any removal so
			// the target is never absent unless we truly must replace a directory.
			if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
			let renamed = false;
			for (let attempt = 0; attempt < 5 && !renamed; attempt++) {
				await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
				try {
					await fsp.rename(tmp, p);
					renamed = true;
				} catch (retryError) {
					if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(retryError.code))
						throw retryError;
				}
			}
			if (!renamed) {
				// Target is a directory or stays locked; remove only after the
				// complete temp file is durable, then rename once more.
				await fsp.rm(p, { force: true });
				await fsp.rename(tmp, p);
			}
		}
	} finally {
		await fsp.rm(tmp, { force: true });
	}
}

export async function ensureDir(p) {
	await fsp.mkdir(p, { recursive: true });
}

/** Sync atomic write (temp + fsync + rename) — single source of truth for
 *  modules that cannot await (models.js). HIGH-6: replaces the per-module
 *  duplicates that drifted (e.g. models.js lacked the random suffix). M3: same
 *  exclusive-create/fsync/rename-over-existing guarantees as writeFile. */
export function writeFileSync(p, content) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	let tmp;
	for (let attempt = 0; ; attempt++) {
		tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
		try {
			// 'wx' exclusive create: a pre-planted symlink at the tmp path is
			// never followed (EEXIST → fresh random name).
			const fd = fs.openSync(tmp, "wx");
			try {
				fs.writeFileSync(fd, content, "utf8");
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			break;
		} catch (error) {
			if (error?.code !== "EEXIST" || attempt >= 3) throw error;
		}
	}
	try {
		try {
			fs.renameSync(tmp, p);
		} catch (error) {
			if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
			// Transient Windows locks clear fast — retry before any removal so
			// the target is never absent unless we must replace a directory.
			let renamed = false;
			for (let attempt = 0; attempt < 5 && !renamed; attempt++) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
				try {
					fs.renameSync(tmp, p);
					renamed = true;
				} catch (retryError) {
					if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(retryError.code))
						throw retryError;
				}
			}
			if (!renamed) {
				fs.rmSync(p, { force: true });
				fs.renameSync(tmp, p);
			}
		}
	} finally {
		fs.rmSync(tmp, { force: true });
	}
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
	if (
		!normalized ||
		normalized.startsWith("/") ||
		/^[A-Za-z]:\//.test(normalized)
	)
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
