// src/dispatch-ledger.js — session-scoped dispatch ledger (P7).
//
// Append-only JSON-lines ledger under `~/.agents/.logs/<session>.dispatch.log`.
// One JSON object per line, closed schema:
//   { ts, session, role, task, model, status, ms, note? }
// Every line is JSON.parse-able in isolation, so a later reader (P6's eval
// harness, P8's retro persistence) can aggregate without a shared manifest.
//
// This is the coarse measurement floor for the dev-team KPIs (routing
// accuracy, validation catch rate, delegation ratio) that the Aug-20 role
// cards introduced — the orchestrator's CLI host calls recordDispatch /
// startDispatch directly. It makes NO harness/plugin integration (that is the
// host's responsibility, not this repo's) and derives no KPIs yet (P6).
//
// Best-effort by design: a failed append logs to stderr once per session and
// never throws, so a write error can never break the calling orchestrator.
//
// Append strategy: `fs.appendFileSync` (a true append-only log) rather than
// `util.writeFileSync` (atomic temp+rename) — the ledger is append-only and
// must not rewrite the whole file on every record; see the self-review note in
// the P7 report. The parent dir is created on demand; a missing ledger file is
// created by the first append.

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { sanitizePathSegment } from "./util.js";

/** The session this process writes to when nothing else pins one. Generated
 *  once per process (UUIDv4), so sibling writes in one host process share a
 *  single ledger.
 *
 *  This is the IN-PROCESS default and it is deliberately NOT enough on its
 *  own: an LLM orchestrator reaches this module by shelling out, so every
 *  `agent-cli ledger record` is a fresh process with a fresh id — N dispatches
 *  would land in N one-line files and P6 would aggregate nothing. `startSession`
 *  below pins an id to disk so separate processes share one ledger. */
const SESSION_ID = crypto.randomUUID();

/** The pinned-session pointer: a one-line file holding the current session id.
 *
 *  Deliberately explicit rather than inferred. An earlier design attached to
 *  "the newest .dispatch.log touched within N hours", which has two failure
 *  modes we do not want: a long request that crosses the window splits into two
 *  sessions mid-flight, and two concurrent requests silently merge into one
 *  ledger. A pointer written by an explicit `ledger start` has neither — a new
 *  request re-pins, and `--session` overrides for anything that needs its own. */
function pointerPath() {
	return path.join(logDir(), ".current-session");
}

/** Closed status enum. Any other value is coerced to `failed` so downstream
 *  aggregation never sees an out-of-schema status. */
const STATUSES = new Set(["started", "succeeded", "failed", "cancelled"]);
const STATUS_FALLBACK = "failed";

/** Best-effort stderr guard: log a failed ledger op once per session (process),
 *  then stay silent — a ledger that can't be written shouldn't spam the host. */
let warned = false;
function warnOnce(prefix, err) {
	if (warned) return;
	warned = true;
	try {
		const msg = err && err.message ? err.message : String(err);
		console.error(`[dispatch-ledger] ${prefix}: ${msg}`);
	} catch {
		/* never let logging throw either */
	}
}

/** Resolve the home the ledger lives under. Computed at call time (not import
 *  time) so tests can flip AGENT_CLI_HOME between assertions. */
function homeDir() {
	return process.env.AGENT_CLI_HOME || os.homedir();
}

function logDir() {
	return path.join(homeDir(), ".agents", ".logs");
}

/** Read the pinned session id, or null when nothing is pinned/readable. */
function readPointer() {
	try {
		return sanitizePathSegment(fs.readFileSync(pointerPath(), "utf8").trim());
	} catch {
		return null;
	}
}

/**
 * Resolve the session a call should act on, in priority order:
 *   1. an explicit id (the `--session` flag) — always wins;
 *   2. the pinned pointer written by `startSession`;
 *   3. this process's own SESSION_ID.
 *
 * Every id is folded through `sanitizePathSegment` because it becomes a
 * filename. An explicit id that sanitizes to nothing falls through rather than
 * silently writing to a `.dispatch.log` with an empty name.
 */
export function resolveSession(session) {
	return sanitizePathSegment(session) || readPointer() || SESSION_ID;
}

/**
 * Pin a session id so later, separate `agent-cli` processes append to ONE
 * ledger. Mints a UUIDv4 when no id is given. Best-effort: a failed pin still
 * returns the id, so the caller degrades to per-process sessions rather than
 * erroring out.
 *
 * @returns {{session: string, path: string, pinned: boolean}}
 */
export function startSession(session) {
	const id = sanitizePathSegment(session) || crypto.randomUUID();
	let pinned = false;
	try {
		fs.mkdirSync(logDir(), { recursive: true });
		fs.writeFileSync(pointerPath(), id + "\n", "utf8");
		pinned = true;
	} catch (err) {
		warnOnce("pin failed", err);
	}
	return { session: id, path: ledgerPath(id), pinned };
}

/** Remove the pin, so the next write falls back to a per-process session. */
export function endSession() {
	const session = readPointer();
	try {
		fs.rmSync(pointerPath(), { force: true });
		return { ok: true, session, cleared: !!session };
	} catch (err) {
		warnOnce("unpin failed", err);
		return { ok: false, session, cleared: false };
	}
}

/** The ledger path for `session` (or the resolved current session). */
export function ledgerPath(session) {
	return path.join(logDir(), `${resolveSession(session)}.dispatch.log`);
}

/** Most-recent existing .dispatch.log under the session .logs dir (or null).
 *  Used by show/clear so an operator — or a later `agent-cli ledger` process,
 *  which carries its own fresh SESSION_ID — can reach the ledger a prior
 *  writing process left behind. */
function findCurrentLedgerPath() {
	let entries;
	try {
		entries = fs.readdirSync(logDir());
	} catch {
		return null;
	}
	const logs = [];
	for (const name of entries) {
		if (!name.endsWith(".dispatch.log")) continue;
		const full = path.join(logDir(), name);
		try {
			logs.push({ full, mtime: fs.statSync(full).mtimeMs });
		} catch {
			/* raced away — skip it */
		}
	}
	if (!logs.length) return null;
	logs.sort((a, b) => b.mtime - a.mtime);
	return logs[0].full;
}

/** Clamp `task` to the schema's 120-char cap. */
function clampTask(task) {
	const s = String(task ?? "");
	return s.length > 120 ? s.slice(0, 120) : s;
}

/** Build one ledger entry. The closed field set + field ordering on the line. */
function buildEntry({ role, task, model, status, note, ms, session }) {
	const entry = {
		ts: new Date().toISOString(),
		session: resolveSession(session),
		role: String(role ?? "orchestrator"),
		task: clampTask(task),
		model: String(model && String(model).trim() ? model : "unknown"),
		status: STATUSES.has(status) ? status : STATUS_FALLBACK,
		ms: typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0,
	};
	if (note != null && String(note).trim() !== "") entry.note = String(note);
	return entry;
}

/** Append one ledger line. Never throws. */
function append(entry) {
	// The entry already carries its resolved session — write to THAT ledger,
	// not to whatever resolveSession() would answer a second time.
	const p = ledgerPath(entry.session);
	try {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
	} catch (err) {
		warnOnce("append failed", err);
	}
	return entry;
}

/**
 * Record one dispatch as a single line. Direct, timing-free: `ms` is recorded
 * as 0 (there is no start reference here). For elapsed timing use startDispatch.
 * Returns the entry (best-effort: an entry object even when the write failed).
 */
export function recordDispatch({
	role,
	task,
	model,
	status,
	note,
	ms = 0,
	session,
} = {}) {
	return append(
		buildEntry({
			role,
			task,
			model,
			status: status ?? "started",
			note,
			ms,
			session,
		}),
	);
}

/**
 * Begin a dispatch and hand back a terminal `finish` callback. Captures `ts`
 * at call time; `finish(status, note?)` records the succeeded/failed/cancelled
 * line with `ms = Date.now() - ts`. Best-effort: always returns the entry.
 */
export function startDispatch({ role, task, model, session } = {}) {
	const ts = Date.now();
	// Resolve the session at START, not at finish: a `ledger start` landing
	// mid-dispatch must not move the terminal line to a different ledger.
	const pinned = resolveSession(session);
	return function finish(status, note) {
		return append(
			buildEntry({
				role,
				task,
				model,
				status: status ?? "failed",
				note,
				ms: Date.now() - ts,
				session: pinned,
			}),
		);
	};
}

/**
 * Resolve which ledger a READER should open:
 *   - an explicit `--session`, or a pinned pointer, names the file directly
 *     (even when it does not exist yet — an empty read is the honest answer);
 *   - with neither, fall back to the newest `.dispatch.log`, so `ledger show`
 *     still reaches a ledger an earlier process left behind.
 */
function readPathFor(session) {
	const explicit = sanitizePathSegment(session) || readPointer();
	if (explicit) return path.join(logDir(), `${explicit}.dispatch.log`);
	return findCurrentLedgerPath();
}

/**
 * Read a session's ledger — the explicit/pinned one, else the most-recent
 * .dispatch.log under ~/.agents/.logs. Returns { ok, entries, path }.
 * Malformed lines are skipped.
 */
export function readLedger({ session } = {}) {
	const p = readPathFor(session);
	if (!p || !fs.existsSync(p)) return { ok: true, entries: [], path: null };
	let content;
	try {
		content = fs.readFileSync(p, "utf8");
	} catch (err) {
		warnOnce("read failed", err);
		return { ok: false, entries: [], path: p };
	}
	const entries = [];
	for (const line of content.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			entries.push(JSON.parse(t));
		} catch {
			/* skip a malformed line — P6 aggregation never chokes on one */
		}
	}
	return { ok: true, entries, path: p };
}

/**
 * Truncate the current session's ledger. Returns { ok, cleared, path }.
 * A missing ledger is a no-op (no file is created just to clear nothing).
 *
 * The previous version checked `fs.existsSync(p)` first; that check-then-write
 * is a TOCTOU race (CodeQL js/file-system-race). Use `flag: "r+"` (open
 * existing for read+write, fail ENOENT if missing) and translate ENOENT into
 * the "nothing to clear" branch.
 */
export function clearLedger({ session } = {}) {
	const p = readPathFor(session);
	if (!p) return { ok: true, cleared: false, path: null };
	try {
		fs.writeFileSync(p, "", { flag: "r+" });
		return { ok: true, cleared: true, path: p };
	} catch (err) {
		if (err?.code === "ENOENT") return { ok: true, cleared: false, path: p };
		warnOnce("clear failed", err);
		return { ok: false, cleared: false, path: p };
	}
}
