#!/usr/bin/env node
// .claude/hooks/team-event.mjs — the team event bus for this repo.
//
// Every Claude session working in this project is a seat on one team (see
// COMPANY.md). Sessions are separate OS processes and cannot see each other, so
// this hook is how a seat's lifecycle becomes visible to the orchestrator: each
// registered event appends ONE line to a shared JSONL log, and the orchestrator
// tails that log.
//
// WHERE THE LOG LIVES. `git rev-parse --git-common-dir` resolves to the SHARED
// .git directory for every worktree of a repo — the one place that is both
// common to all seats and never committed. A path inside the worktree would
// give each seat its own private log, which defeats the point; a path in the
// user's home would leak across unrelated projects. This is the per-project
// location, which is exactly the granularity the team is organized at.
//
// FAIL-OPEN, ALWAYS. A hook that throws blocks the session it fired in. Nothing
// here is important enough to cost a teammate their turn, so every failure path
// exits 0 silently. An observability bus that can halt the thing it observes is
// worse than no bus.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MAX_FIELD = 500;

/** Read all of stdin (fd 0). Returns "" rather than throwing when there is
 *  none — a hook invoked with no payload must still exit cleanly. */
function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

function git(args, cwd) {
	try {
		const r = spawnSync("git", args, { cwd, encoding: "utf8" });
		return r.status === 0 ? (r.stdout || "").trim() : null;
	} catch {
		return null;
	}
}

/** Trim any string that reaches the log — a transcript path or a title can be
 *  long, and one runaway field would make the log unreadable for everyone. */
function clip(v) {
	if (v === undefined || v === null) return undefined;
	const s = String(v);
	return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
}

try {
	const raw = readStdin();
	let payload = {};
	try {
		payload = raw ? JSON.parse(raw) : {};
	} catch {
		// Not JSON. Still worth recording that something fired.
		payload = {};
	}

	const cwd = payload.cwd || process.cwd();
	const commonDir = git(["rev-parse", "--git-common-dir"], cwd);
	if (!commonDir) process.exit(0); // not a repo — nothing to attach to

	const abs = path.isAbsolute(commonDir)
		? commonDir
		: path.resolve(cwd, commonDir);
	const dir = path.join(abs, "team");
	mkdirSync(dir, { recursive: true });

	const line =
		JSON.stringify({
			ts: new Date().toISOString(),
			event: clip(payload.hook_event_name) || "unknown",
			session: clip(payload.session_id),
			cwd: clip(cwd),
			branch: clip(git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)),
			head: clip(git(["rev-parse", "--short", "HEAD"], cwd)),
			// Stop/SubagentStop carry this; it distinguishes "finished a turn"
			// from "was interrupted", which is the difference the orchestrator
			// actually acts on.
			stopHookActive: payload.stop_hook_active,
			reason: clip(payload.reason),
		}) + "\n";

	appendFileSync(path.join(dir, "events.jsonl"), line, "utf8");
} catch {
	/* fail-open: never block a teammate's turn */
}
process.exit(0);
