// src/sync.js — git-backed brain sync for ~/.agents.
// Portability: commit the brain to a local git repo and push/pull a remote.
// Secrets (.secrets.*) and machine-local files are excluded via .gitignore.

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import {
	AGENTS_DIR,
	readFileNoFollow,
	writeFileSync as writeFileAtomicSync,
} from "./util.js";

/** Files that must never leave the machine (default .gitignore entries). */
export const SYNC_EXCLUDES = [
	"config.json",
	"ENVIRONMENTS.md",
	"backups/",
	".consolidate-state.json",
	".secrets.json",
	".secrets.key",
	"update-*/",
];

const GIT_AUTHOR = ["-c", "user.name=agent-cli", "-c", "user.email=agent-cli@local"];

function git(args, { cwd = AGENTS_DIR, env = {} } = {}) {
	// cwd may not exist yet (fresh home) — git --version still needs a valid cwd.
	const runCwd = fs.existsSync(cwd) ? cwd : undefined;
	const r = spawnSync("git", args, {
		encoding: "utf8",
		cwd: runCwd,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
	});
	return {
		ok: r.status === 0,
		code: r.status,
		stdout: (r.stdout || "").trim(),
		stderr: (r.stderr || "").trim(),
	};
}

export function gitAvailable() {
	return git(["--version"]).ok;
}

export function isGitRepo(cwd = AGENTS_DIR) {
	return git(["rev-parse", "--is-inside-work-tree"], { cwd }).ok;
}

function remoteUrl(cwd = AGENTS_DIR) {
	const r = git(["remote", "get-url", "origin"], { cwd });
	return r.ok ? r.stdout : null;
}

function headHash(cwd = AGENTS_DIR) {
	const r = git(["rev-parse", "--short", "HEAD"], { cwd });
	return r.ok ? r.stdout : null;
}

/** Initialize the git repo + exclusion .gitignore. Never destroys content. */
export async function syncInit({ remote = null } = {}) {
	const dir = AGENTS_DIR;
	if (!gitAvailable()) return { ok: false, reason: "git is not installed" };
	fs.mkdirSync(dir, { recursive: true });
	if (!isGitRepo(dir)) {
		const init = git(["init", "-q"], { cwd: dir });
		if (!init.ok) return { ok: false, reason: init.stderr || "git init failed" };
	}
	// Brain files must roundtrip byte-stable: with git's Windows default
	// core.autocrlf=true, a rollback would rewrite LF working files to CRLF.
	git(["config", "core.autocrlf", "false"], { cwd: dir });
	const giPath = path.join(dir, ".gitignore");
	// CodeQL js/file-system-race: existsSync + readFileSync is a TOCTOU race.
	// Let readFileNoFollow throw ENOENT and translate it to an empty read.
	let existing = "";
	try {
		existing = readFileNoFollow(giPath);
	} catch (err) {
		if (err?.code === "ESYMLINKREFUSED") {
			// Fail closed rather than writing through the link (see the write below).
			return {
				ok: false,
				reason: `.gitignore in ${dir} is a symlink — refusing to read or write through it; remove the link and re-run`,
			};
		}
		if (err?.code !== "ENOENT") throw err;
	}
	const lines = existing ? existing.split(/\r?\n/) : [];
	const added = [];
	for (const pat of SYNC_EXCLUDES)
		if (!lines.includes(pat)) {
			lines.push(pat);
			added.push(pat);
		}
	if (added.length)
		// Symlink-safe: a raw fs.writeFileSync follows a symlinked .gitignore and
		// appends SYNC_EXCLUDES straight into the link's target. ~/.agents is a git
		// working tree that syncPull merges from a remote, and a repo can carry
		// .gitignore as a mode-120000 symlink that materializes on checkout — so a
		// hostile remote could turn `sync init` into an arbitrary-file append.
		// The atomic writer renames over the link instead of writing through it.
		writeFileAtomicSync(giPath, lines.join("\n") + "\n");
	if (remote) {
		git(["remote", "remove", "origin"], { cwd: dir });
		git(["remote", "add", "origin", remote], { cwd: dir });
	}
	return { ok: true, dir, gitignore: SYNC_EXCLUDES, added: added, remote: remote ?? remoteUrl(dir) };
}

/** Files whose exposure is unrecoverable: the store and the key that decrypts it. */
const SECRET_FILES = [".secrets.json", ".secrets.key"];

/**
 * Re-assert SYNC_EXCLUDES into .git/info/exclude.
 *
 * .gitignore is a TRACKED file, so syncPull merges whatever the remote says it
 * should contain — including a version with the .secrets lines removed. Anything
 * that relies on .gitignore alone is therefore only as trustworthy as the remote.
 * .git/info/exclude is never tracked and never merged, so a remote cannot reach
 * it. Written on every push, not just at init, so a brain that became a repo by
 * hand (git init, no `sync init`) is covered too.
 */
function writeLocalExcludes(dir) {
	const infoDir = path.join(dir, ".git", "info");
	try {
		fs.mkdirSync(infoDir, { recursive: true });
		const p = path.join(infoDir, "exclude");
		let existing = "";
		try {
			existing = fs.readFileSync(p, "utf8");
		} catch (err) {
			if (err?.code !== "ENOENT") throw err;
		}
		const lines = existing ? existing.split(/\r?\n/) : [];
		const added = SYNC_EXCLUDES.filter((pat) => !lines.includes(pat));
		if (added.length)
			writeFileAtomicSync(p, [...lines, ...added].join("\n") + "\n");
	} catch {
		// Best-effort hardening. If it fails, secretsWouldLeak below is still the
		// authoritative gate — never let this become the thing that blocks a push.
	}
}

/**
 * Names of secret files that `git add -A` would actually pick up right now.
 *
 * Asks git rather than reasoning about .gitignore ourselves: `check-ignore`
 * applies the full precedence chain, so it accounts for a remote-supplied
 * `!.secrets.json` negation — which WOULD override .git/info/exclude, since
 * .gitignore outranks it. Also reports a file already committed by an earlier
 * push, which no ignore rule can undo.
 */
function secretsWouldLeak(dir) {
	const exposed = [];
	for (const name of SECRET_FILES) {
		if (!fs.existsSync(path.join(dir, name))) continue;
		if (git(["ls-files", "--error-unmatch", "--", name], { cwd: dir }).ok) {
			exposed.push({ name, why: "tracked" });
			continue;
		}
		if (!git(["check-ignore", "-q", "--", name], { cwd: dir }).ok)
			exposed.push({ name, why: "not-ignored" });
	}
	return exposed;
}

/** Commit all tracked changes; push when a remote exists. */
export async function syncPush({ message = "agent-cli sync" } = {}) {
	const dir = AGENTS_DIR;
	if (!isGitRepo(dir)) return { ok: false, reason: "not a sync repo — run agent-cli sync init" };
	// Exclusion is a push-time precondition, not a one-time file write at init.
	// The key travels with the ciphertext, so a single leaked push hands over
	// plaintext — there is no residual protection from encryption to fall back on.
	writeLocalExcludes(dir);
	const exposed = secretsWouldLeak(dir);
	if (exposed.length) {
		const tracked = exposed.filter((e) => e.why === "tracked");
		return {
			ok: false,
			reason: tracked.length
				? `refusing to push: ${tracked.map((e) => e.name).join(", ")} ${tracked.length > 1 ? "are" : "is"} already tracked by git, so ${tracked.length > 1 ? "they are" : "it is"} in the remote's history. Purge ${tracked.length > 1 ? "them" : "it"} from history and rotate every stored secret — untracking now would not unpublish what was already pushed.`
				: `refusing to push: ${exposed.map((e) => e.name).join(", ")} would be committed — the .gitignore in ${dir} no longer excludes ${exposed.length > 1 ? "them" : "it"}. Restore the .secrets entries (or run agent-cli sync init) and push again.`,
			exposedSecrets: exposed,
		};
	}
	const add = git(["add", "-A"], { cwd: dir });
	if (!add.ok) return { ok: false, reason: add.stderr || "git add failed" };
	const changed = git(["diff", "--cached", "--name-only"], { cwd: dir }).stdout;
	if (!changed) return { ok: true, changed: false, nothingToDo: true, files: [] };
	const commit = git([...GIT_AUTHOR, "commit", "-q", "-m", message], { cwd: dir });
	if (!commit.ok) return { ok: false, reason: commit.stderr || "git commit failed" };
	const files = changed.split("\n").filter(Boolean);
	const remote = remoteUrl(dir);
	let pushed = false;
	if (remote) {
		const p = git(["push", "-q", "origin", "HEAD"], { cwd: dir });
		if (!p.ok) return { ok: false, reason: p.stderr || "git push failed" };
		pushed = true;
	}
	return { ok: true, changed: true, nothingToDo: false, commit: headHash(dir), files, pushed, remote };
}

/** Fetch + merge the remote; auto-resolve conflicts with --take. */
export async function syncPull({ take = null } = {}) {
	const dir = AGENTS_DIR;
	if (!isGitRepo(dir)) return { ok: false, reason: "not a sync repo — run agent-cli sync init" };
	const remote = remoteUrl(dir);
	if (!remote)
		return { ok: false, reason: "no remote configured — run agent-cli sync init --remote <url>" };
	const fetch = git(["fetch", "-q", "origin"], { cwd: dir });
	if (!fetch.ok) return { ok: false, reason: fetch.stderr || "git fetch failed" };
	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).stdout || "master";
	const merge = git(["merge", "-q", "--no-edit", `origin/${branch}`], { cwd: dir });
	if (merge.ok) return { ok: true, pulled: true, conflict: false, branch, relink: true };
	if (take === "remote" || take === "local") {
		const side = take === "remote" ? "--theirs" : "--ours";
		git(["-c", "core.autocrlf=false", "checkout", side, "."], { cwd: dir });
		git(["add", "-A"], { cwd: dir });
		const c = git([...GIT_AUTHOR, "commit", "-q", "-m", `agent-cli sync: take ${take}`], { cwd: dir });
		return {
			ok: true,
			pulled: true,
			conflict: true,
			resolved: take,
			commit: headHash(dir),
			relink: true,
			...(c.ok ? {} : { commitError: c.stderr }),
		};
	}
	return {
		ok: false,
		conflict: true,
		reason: "merge conflict — resolve manually or pass --take local|remote",
	};
}

/** Working-tree + remote sync status. */
export async function syncStatus() {
	const dir = AGENTS_DIR;
	if (!isGitRepo(dir)) return { ok: false, reason: "not a sync repo — run agent-cli sync init" };
	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).stdout || "none";
	const head = headHash(dir);
	const remote = remoteUrl(dir);
	const dirty = git(["status", "--porcelain"], { cwd: dir }).stdout
		.split("\n")
		.filter(Boolean);
	let ahead = 0;
	let behind = 0;
	if (remote) {
		const r = git(["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`], { cwd: dir });
		if (r.ok) {
			const [a, b] = r.stdout.split(/\s+/).map((n) => parseInt(n, 10) || 0);
			ahead = a;
			behind = b;
		}
	}
	return { ok: true, repo: dir, branch, head, remote, ahead, behind, dirtyFiles: dirty };
}

/** Recent commit history. */
export async function syncLog({ limit = 20 } = {}) {
	const dir = AGENTS_DIR;
	if (!isGitRepo(dir)) return { ok: false, reason: "not a sync repo — run agent-cli sync init" };
	const r = git(
		["log", `-${limit}`, "--pretty=format:%h|%ad|%s", "--date=short"],
		{ cwd: dir },
	);
	if (!r.ok) return { ok: false, reason: r.stderr || "git log failed" };
	const entries = r.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [hash, date, ...rest] = line.split("|");
			return { hash, date, message: rest.join("|") };
		});
	return { ok: true, entries };
}

/** Diff of a commit, or uncommitted working changes when no commit given. */
export async function syncDiff({ commit = null } = {}) {
	const dir = AGENTS_DIR;
	if (!isGitRepo(dir)) return { ok: false, reason: "not a sync repo — run agent-cli sync init" };
	if (commit) {
		const summary = git(["show", "--stat", "--oneline", commit], { cwd: dir });
		if (!summary.ok) return { ok: false, reason: `no such commit: ${commit}` };
		const body = git(["show", "--format=", commit], { cwd: dir }).stdout;
		return { ok: true, commit, summary: summary.stdout, diff: body };
	}
	const r = git(["diff", "HEAD"], { cwd: dir });
	return { ok: true, diff: r.stdout || "(no uncommitted changes)" };
}

/** Restore the brain working tree to a past commit; caller should re-link. */
export async function syncRollback({ commit = null } = {}) {
	const dir = AGENTS_DIR;
	if (!isGitRepo(dir)) return { ok: false, reason: "not a sync repo — run agent-cli sync init" };
	if (!commit) return { ok: false, reason: "usage: agent-cli sync rollback <commit>" };
	const check = git(["cat-file", "-e", `${commit}^{commit}`], { cwd: dir });
	if (!check.ok) return { ok: false, reason: `no such commit: ${commit}` };
	const previousHead = headHash(dir);
	// reset --hard makes index + working tree exactly match `commit`:
	// restores changed files AND removes files that were added after `commit`.
	// (A plain `checkout <commit> -- .` restores tracked files but leaves
	// post-commit additions in the tree, so a rollback would not actually
	// remove them.) This is a full-brain restore by definition.
	// -c core.autocrlf=false also covers repos initialized before syncInit
	// started pinning it (otherwise the reset smudges LF files to CRLF on
	// Windows configs with autocrlf=true).
	const co = git(["-c", "core.autocrlf=false", "reset", "--hard", commit], { cwd: dir });
	if (!co.ok) return { ok: false, reason: co.stderr || "reset failed" };
	return { ok: true, commit, previousHead, relink: true };
}

/** Toggle / read the auto-commit flag stored in config.json. */
export function setAutoCommit(cfg, on) {
	cfg.sync = cfg.sync || {};
	cfg.sync.autoCommit = !!on;
	return cfg.sync.autoCommit;
}

export function autoCommitEnabled(cfg) {
	return !!(cfg.sync && cfg.sync.autoCommit);
}

/** Commit automatically when auto-commit is enabled (called after mutations). */
export async function maybeAutoSync(cfg) {
	if (!autoCommitEnabled(cfg)) return { ok: true, auto: false, nothingToDo: true };
	const r = await syncPush({ message: "agent-cli sync (auto)" });
	return { ok: r.ok, auto: true, ...r };
}

export { AGENTS_DIR };
