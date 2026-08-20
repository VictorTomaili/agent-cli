// src/automation.js — automation layer: scheduled/reactive jobs, git hooks, and
// a file watcher. All read-only-safe; mutating only what the user configures.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AGENTS_DIR, exists, readFile, writeFile, pretty } from "./util.js";

export const AUTOMATION_FILE = path.join(AGENTS_DIR, "automation.json");

// Events the CLI can fire (via `automation run --event X`) plus the git-hook
// events emitted by `hooks install --git`.
export const EVENTS = [
	"session-start",
	"day-start",
	"sync",
	"memory",
	"snapshot",
	"post-merge",
	"post-checkout",
];

export function readJobs() {
	if (!fs.existsSync(AUTOMATION_FILE)) return [];
	try {
		const p = JSON.parse(fs.readFileSync(AUTOMATION_FILE, "utf8"));
		if (p && Array.isArray(p.jobs)) return p.jobs;
	} catch { /* corrupt → empty */ }
	return [];
}

export function writeJobs(jobs) {
	fs.mkdirSync(AGENTS_DIR, { recursive: true });
	fs.writeFileSync(AUTOMATION_FILE, JSON.stringify({ version: 1, jobs }, null, 2) + "\n", "utf8");
}

// Add a job. `name` must be unique. Returns the created job.
export function addJob({ name, event, command, cwd = null }) {
	const jobs = readJobs();
	if (jobs.some((j) => j.name === name)) {
		const err = new Error(`automation job already exists: ${name}`);
		err.code = "EEXIST";
		throw err;
	}
	const job = { name, event, command, cwd, createdAt: new Date().toISOString() };
	jobs.push(job);
	writeJobs(jobs);
	return job;
}

export function removeJob(name) {
	const jobs = readJobs();
	const next = jobs.filter((j) => j.name !== name);
	writeJobs(next);
	return jobs.length - next.length;
}

// Run all jobs matching `event` (or all when event === "*"). Each job's command
// is executed via the shell (user-authored config — trusted). Returns per-job
// results { name, status, code, output }.
export function runJobs({ event = "*", cwd = process.cwd() } = {}) {
	const jobs = readJobs().filter((j) => event === "*" || j.event === event);
	const results = [];
	for (const j of jobs) {
		try {
			const r = spawnSync(j.command, {
				cwd: j.cwd || cwd,
				shell: true,
				encoding: "utf8",
				timeout: 60000,
			});
			results.push({
				name: j.name,
				event: j.event,
				command: j.command,
				status: r.status === 0 ? "ok" : "failed",
				code: r.status,
				output: (r.stdout || "").trim() + (r.stderr ? "\n" + (r.stderr || "").trim() : ""),
			});
		} catch (e) {
			results.push({ name: j.name, event: j.event, command: j.command, status: "error", error: e.message });
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// Git hooks — wire `agent-cli link` (and job hooks) into post-merge/post-checkout.
// ---------------------------------------------------------------------------
const HOOK_TEMPLATE = (extra) => `#!/bin/sh
# Managed by agent-cli — ` + "`agent-cli hooks install --git`" + `
# Re-point agent-cli files after branch changes / merges.
command -v agent-cli >/dev/null 2>&1 && agent-cli link >/dev/null 2>&1
${extra ? extra + "\n" : ""}
`;

export function gitHookPath(cwd = process.cwd()) {
	return path.join(cwd, ".git", "hooks");
}

export function installGitHooks({ cwd = process.cwd(), withAutomation = false } = {}) {
	const hooksDir = gitHookPath(cwd);
	if (!fs.existsSync(hooksDir)) {
		const err = new Error("not a git repository (no .git/hooks)");
		err.code = "ENOGIT";
		throw err;
	}
	fs.mkdirSync(hooksDir, { recursive: true });
	const extra = withAutomation
		? 'command -v agent-cli >/dev/null 2>&1 && agent-cli automation run --event post-merge >/dev/null 2>&1'
		: "";
	for (const hook of ["post-merge", "post-checkout"]) {
		fs.writeFileSync(path.join(hooksDir, hook), HOOK_TEMPLATE(extra), "utf8");
		// best-effort +x (POSIX); ignored on Windows
		try { fs.chmodSync(path.join(hooksDir, hook), 0o755); } catch { /* Windows */ }
	}
	return ["post-merge", "post-checkout"];
}

export function removeGitHooks({ cwd = process.cwd() } = {}) {
	const hooksDir = gitHookPath(cwd);
	let removed = 0;
	for (const hook of ["post-merge", "post-checkout"]) {
		const p = path.join(hooksDir, hook);
		if (fs.existsSync(p)) {
			const content = fs.readFileSync(p, "utf8");
			if (content.includes("Managed by agent-cli")) {
				fs.rmSync(p, { force: true });
				removed++;
			}
		}
	}
	return removed;
}

// ---------------------------------------------------------------------------
// Watcher — poll a set of agent-state files/dirs and emit typed change events.
// Used by `agent-cli watch` (long-running) and available for cron-like loops.
// ---------------------------------------------------------------------------
export function watchTargets(cwd = process.cwd()) {
	const t = [
		{ type: "master", path: AGENTS_DIR, glob: false },
		{ type: "project", path: path.join(cwd, ".agents"), glob: false },
		{ type: "skill.config", path: path.join(cwd, "skill.config"), glob: true },
		{ type: "spect", path: path.join(cwd, ".spect"), glob: false },
	];
	return t.filter((x) => fs.existsSync(x.path));
}

// A cheap recursive "fingerprint" of a path (mtime + size, depth-limited) so we
// can detect additions/removals without a full hash of every file.
function fingerprint(p, depth = 0) {
	if (depth > 4) return null;
	let st;
	try { st = fs.statSync(p); } catch { return null; }
	if (st.isDirectory()) {
		let s = "";
		let entries = [];
		try { entries = fs.readdirSync(p); } catch { return null; }
		for (const e of entries.slice().sort()) {
			const sub = fingerprint(path.join(p, e), depth + 1);
			if (sub !== null) s += e + ":" + sub + ";";
		}
		return "d(" + s + ")";
	}
	return `${st.mtimeMs}|${st.size}`;
}

// Snapshot the current fingerprints. Returns a Map<path, fp>.
export function fingerprintAll(targets) {
	const out = new Map();
	for (const t of targets) {
		out.set(t.path, fingerprint(t.path));
	}
	return out;
}

// Compare two snapshots → list of { type, path } events.
export function diffFingerprints(before, after) {
	const events = [];
	for (const [p, fp] of after) {
		if (!before.has(p)) events.push({ type: "added", path: p });
		else if (before.get(p) !== fp) events.push({ type: "changed", path: p });
	}
	for (const p of before.keys()) {
		if (!after.has(p)) events.push({ type: "removed", path: p });
	}
	return events;
}

export { AGENTS_DIR, exists, readFile, writeFile, pretty };
