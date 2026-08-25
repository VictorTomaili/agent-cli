// src/sync.js — git-backed brain sync for ~/.agents.
// Portability: commit the brain to a local git repo and push/pull a remote.
// Secrets (.secrets.*) and machine-local files are excluded via .gitignore.

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { AGENTS_DIR, readFileNoFollow } from "./util.js";

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
		fs.writeFileSync(giPath, lines.join("\n") + "\n", "utf8");
	if (remote) {
		git(["remote", "remove", "origin"], { cwd: dir });
		git(["remote", "add", "origin", remote], { cwd: dir });
	}
	return { ok: true, dir, gitignore: SYNC_EXCLUDES, added: added, remote: remote ?? remoteUrl(dir) };
}

/** Commit all tracked changes; push when a remote exists. */
export async function syncPush({ message = "agent-cli sync" } = {}) {
	const dir = AGENTS_DIR;
	if (!isGitRepo(dir)) return { ok: false, reason: "not a sync repo — run agent-cli sync init" };
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
