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
/** ~/.agents/AGENTS.md — the canonical single source of truth. */
export const MASTER_FILE = path.join(AGENTS_DIR, "AGENTS.md");
/** ~/AGENTS.md — the agent-cli-managed home pointer stub that points at MASTER_FILE. */
export const HOME_POINTER_FILE = path.join(HOME, "AGENTS.md");
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
export function writeFileSync(p, content, { mode } = {}) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	let tmp;
	for (let attempt = 0; ; attempt++) {
		tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
		try {
			// 'wx' exclusive create: a pre-planted symlink at the tmp path is
			// never followed (EEXIST → fresh random name). `mode` is applied at
			// creation so a confidential target (e.g. a 0600 secrets store) never
			// exists on disk with looser permissions.
			const fd = fs.openSync(tmp, "wx", mode);
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

/**
 * Write `content` to `p` only if `p` does not already exist.
 *
 * Uses the exclusive `wx` flag: the kernel atomically refuses to follow a
 * pre-planted symlink at `p` because the open returns EEXIST before any
 * data is read or written. Same primitive used at src/secrets.js:35 — that
 * site was the reference fix for the file-system-race family. Returns
 * `{ created: true }` on success, `{ created: false }` if the file already
 * exists. Throws through any other error (EPERM, EACCES, ENOSPC, ...).
 *
 * @param {string} p  target path
 * @param {string|Buffer} content
 * @param {{ mode?: number }} [opts]
 * @returns {{ created: boolean }}
 */
export function writeFileIfAbsent(p, content, { mode } = {}) {
	try {
		fs.writeFileSync(p, content, { mode, flag: "wx" });
		return { created: true };
	} catch (e) {
		if (e?.code === "EEXIST") return { created: false };
		throw e;
	}
}

/** The symlink refusal thrown by readFileNoFollow. Carries a stable `code` so
 *  callers can fail closed on it without matching the message text. */
function symlinkRefusal(p) {
	const err = new Error(`refusing to follow symlink: ${p}`);
	err.code = "ESYMLINKREFUSED";
	return err;
}

/**
 * Read `p`, refusing to follow symlinks or read non-regular files.
 *
 * Decodes as utf-8 by default; pass `encoding: null` for a Buffer, which is
 * what binary content such as the 32-byte secrets key needs (utf8 decoding
 * would silently corrupt it).
 *
 * Opens with O_NOFOLLOW where available (POSIX), so the kernel refuses the open
 * when the final component is a symlink.
 *
 * On Windows O_NOFOLLOW does not exist at all, and fstat() on an opened fd
 * describes the TARGET — libuv only reports S_IFLNK from its lstat path, so
 * fstatSync().isSymbolicLink() is ALWAYS false there and can never serve as a
 * second line of defense. (It previously claimed to; a planted symlink or
 * junction was silently followed, and the junction case that comment cited is
 * actually caught by the isFile() check below.) lstat is the only call that
 * observes the link itself, so on win32 refuse before opening, then confirm the
 * fd still refers to that same file to shrink the check-then-open window.
 *
 * Throws ENOENT if missing. Throws when `p` is a symlink, directory, device,
 * or exceeds `opts.maxBytes` (the size cap is per-call; pass `MAX_SKILL_MD_BYTES`
 * from src/skills/lib/store.js for the skill-store path).
 *
 * @param {string} p
 * @param {{ maxBytes?: number, encoding?: string|null }} [opts]
 * @returns {string|Buffer} a string unless `encoding` is null
 */
export function readFileNoFollow(p, { maxBytes, encoding = "utf8" } = {}) {
	const isWin = process.platform === "win32";
	const flags = isWin
		? fs.constants.O_RDONLY
		: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
	// Windows has no O_NOFOLLOW: the link must be rejected before the open.
	// lstatSync throws ENOENT for a missing path, matching the POSIX branch.
	const pre = isWin ? fs.lstatSync(p) : null;
	if (pre?.isSymbolicLink()) {
		throw symlinkRefusal(p);
	}
	let fd;
	try {
		fd = fs.openSync(p, flags);
	} catch (err) {
		// POSIX: O_NOFOLLOW on the final symlink component fails the open
		// with ELOOP before fstat runs. Translate to the same message the
		// Windows fstat-guard path produces so callers see one consistent
		// error regardless of platform.
		if (err?.code === "ELOOP") {
			throw symlinkRefusal(p);
		}
		throw err;
	}
	try {
		const st = fs.fstatSync(fd);
		if (st.isSymbolicLink()) {
			throw symlinkRefusal(p);
		}
		// win32: the fd must still be the file lstat approved above, or the path
		// was swapped between the two calls. Compared only when the filesystem
		// reports a usable identity (some volumes report ino 0).
		if (pre && pre.ino && st.ino && (pre.ino !== st.ino || pre.dev !== st.dev)) {
			throw symlinkRefusal(p);
		}
		if (!st.isFile()) {
			throw new Error(`not a regular file: ${p}`);
		}
		if (maxBytes != null && st.size > maxBytes) {
			throw new Error(`file exceeds ${maxBytes}-byte cap: ${p}`);
		}
		// `encoding: null` returns a Buffer — required for binary content such as
		// the 32-byte secrets key, which utf8 decoding would silently corrupt.
		return fs.readFileSync(fd, encoding);
	} finally {
		fs.closeSync(fd);
	}
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

/**
 * Resolve `<cwd>/.agents` for project scope, refusing a redirected base.
 *
 * Project scope trusts the CHECKOUT to say where its brain lives, and a checkout
 * can be hostile: `.agents` is committable as a symlink (mode 120000), and on
 * Windows a junction needs no privilege to create. Point it at `~/.agents` and
 * every project-scope write lands on the GLOBAL brain instead — which matters
 * more than a normal path escape, because SOUL.md and LESSONS.md are loaded into
 * every session on the machine. Repo-scoped text would be promoted to standing,
 * machine-wide agent instructions. Point it anywhere else and the same writes
 * drop brain files into that directory.
 *
 * Reads are guarded for the mirror-image reason: readFileNoFollow only refuses a
 * link at the FINAL component, so a linked `.agents` would let a project-scope
 * read serve the global file's contents while reporting a project-scope path.
 *
 * Mirrors guardStageDir (seed.js) and guardStoreBase (skills/lib/store.js): lstat
 * first, since Node reports Windows junctions as symlinks, then realpath
 * containment as the fallback for reparse points that report differently.
 *
 * @returns {string} the resolved `<cwd>/.agents`
 * @throws {Error} code EPROJECTBASEREDIRECTED when the base escapes cwd
 */
export function projectBrainDir(cwd = process.cwd()) {
	// Resolve INSIDE the helper rather than asking every call site to remember.
	// A relative cwd would otherwise return a relative base while the containment
	// check below compared fully-resolved paths — the two halves disagreeing is
	// exactly the kind of seam a guard should not have.
	const root = path.resolve(cwd);
	const base = path.join(root, ".agents");
	let st = null;
	try {
		st = fs.lstatSync(base);
	} catch (err) {
		// Absent is fine — it will be created inside cwd by the caller.
		if (err?.code === "ENOENT") return base;
		throw err;
	}
	const refuse = (why) => {
		const e = new Error(
			`refusing to use project scope: ${base} ${why}. Remove the link and re-run, or use global scope (-g).`,
		);
		e.code = "EPROJECTBASEREDIRECTED";
		throw e;
	};
	if (st.isSymbolicLink()) refuse("is a symlink or reparse point (junction)");
	let realBase;
	let realCwd;
	try {
		realBase = fs.realpathSync(base);
		realCwd = fs.realpathSync(root);
	} catch {
		// Unresolvable is not evidence of an escape; the lstat check above stands.
		return base;
	}
	if (realBase !== path.join(realCwd, ".agents"))
		refuse(`resolves outside ${root} (to ${realBase})`);
	return base;
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

/**
 * Fold a caller-supplied identifier into a single safe path SEGMENT.
 *
 * `resolveContained` above is the right tool when the input is meant to be a
 * relative path and an escape should be refused. This is for the other case:
 * an id (a session id, a task id) that is only ever interpolated INTO a
 * filename, where an escape is never meaningful and the id should simply be
 * flattened. Everything outside `[A-Za-z0-9._-]` folds to `-`, leading and
 * trailing dots/dashes are stripped (so `..` cannot survive, and no dotfile is
 * created), and the result is length-capped.
 *
 * Case is preserved deliberately — task ids like `T1` must not collide with
 * `t1` just because they passed through here.
 *
 * @returns {string|null} the segment, or null when nothing usable remains.
 */
export function sanitizePathSegment(raw, { max = 64 } = {}) {
	const s = String(raw ?? "")
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, max);
	return s || null;
}

/**
 * Escape a string for literal use inside a `new RegExp(...)`.
 *
 * Interpolating caller-supplied text into a pattern makes every regex
 * metacharacter live: a field named `.*` stops meaning "that field" and starts
 * matching anything, and a pathological value can be made to backtrack. Anything
 * that is meant to be matched literally goes through here first.
 */
export function escapeRegExp(s) {
	return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// --- L1: shell-free $EDITOR spawning -----------------------------------------
// `agent-cli edit` used to spawn the raw $VISUAL/$EDITOR string with shell:true —
// a poisoned env var meant arbitrary command execution. These helpers keep the
// convenience ("code -w", quoted exe paths) without any shell interpretation.

/**
 * Quote-aware split of an $EDITOR-style value into an argv array.
 * Handles double quotes (with \" escapes) and single quotes; unquoted tokens
 * split on whitespace. Returns null when the value is empty or contains an
 * unterminated quote — the caller must fail closed, never fall back to a shell.
 */
export function parseEditorCommand(editor) {
	const s = String(editor ?? "").trim();
	if (!s) return null;
	const args = [];
	let cur = "";
	let quoted = false; // current token included a quoted segment ("" is a real arg)
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === '"') {
			quoted = true;
			i++;
			while (i < s.length && s[i] !== '"') {
				if (s[i] === "\\" && s[i + 1] === '"') {
					cur += '"';
					i += 2;
					continue;
				}
				cur += s[i];
				i++;
			}
			if (i >= s.length) return null; // unterminated quote
			i++;
			continue;
		}
		if (ch === "'") {
			quoted = true;
			i++;
			while (i < s.length && s[i] !== "'") {
				cur += s[i];
				i++;
			}
			if (i >= s.length) return null; // unterminated quote
			i++;
			continue;
		}
		if (/\s/.test(ch)) {
				if (cur || quoted) {
					args.push(cur);
					cur = "";
					quoted = false;
				}
				i++;
			continue;
		}
		cur += ch;
		i++;
	}
	if (cur || quoted) args.push(cur);
	if (args.length === 0 || !args[0]) return null;
	return args;
}

/** cmd.exe syntax characters — rejected outright for the Windows shim fallback. */
const CMD_METACHARS = /[&|<>^%"]/;

/** Quote one cmd.exe argument when it contains whitespace. */
function quoteCmdArg(a) {
	return /\s/.test(a) ? `"${a}"` : a;
}

/**
 * Windows-only fallback for editors shipped as .cmd/.bat shims ("code",
 * "nano" via scoop, …): Node cannot CreateProcess a batch file directly, so
 * the shim must run through cmd.exe. Security: the EDITOR portion must be free
 * of cmd metacharacters (fail closed → null), the target is our own file path,
 * and every argument is re-quoted — no raw string ever reaches a shell verbatim.
 */
export function cmdShimSpawnSync(spawnSync, editorArgs, target) {
	const all = [...editorArgs.slice(1), target];
	if (all.some((a) => CMD_METACHARS.test(a)) || CMD_METACHARS.test(editorArgs[0]))
		return null;
	const cmdline = [editorArgs[0], ...all].map(quoteCmdArg).join(" ");
	const comspec = process.env.ComSpec || "cmd.exe";
	return spawnSync(comspec, ["/d", "/s", "/c", cmdline], { stdio: "inherit" });
}

export { fs, fsp, path };
