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

/** The session this process writes to. Generated once per process (UUIDv4),
 *  so sibling writes in one host process share a single ledger. It is NOT
 *  persisted: each agent host process is its own session. */
const SESSION_ID = crypto.randomUUID();

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

/** The ledger path for this process's session. */
export function ledgerPath() {
	return path.join(logDir(), `${SESSION_ID}.dispatch.log`);
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
function buildEntry({ role, task, model, status, note, ms }) {
	const entry = {
		ts: new Date().toISOString(),
		session: SESSION_ID,
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
	const p = ledgerPath();
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
export function recordDispatch({ role, task, model, status, note } = {}) {
	return append(
		buildEntry({ role, task, model, status: status ?? "started", note, ms: 0 }),
	);
}

/**
 * Begin a dispatch and hand back a terminal `finish` callback. Captures `ts`
 * at call time; `finish(status, note?)` records the succeeded/failed/cancelled
 * line with `ms = Date.now() - ts`. Best-effort: always returns the entry.
 */
export function startDispatch({ role, task, model } = {}) {
	const ts = Date.now();
	return function finish(status, note) {
		return append(
			buildEntry({
				role,
				task,
				model,
				status: status ?? "failed",
				note,
				ms: Date.now() - ts,
			}),
		);
	};
}

/**
 * Read the current session's ledger (the most-recent .dispatch.log under
 * ~/.agents/.logs). Returns { ok, entries, path }. Malformed lines are skipped.
 */
export function readLedger() {
	const p = findCurrentLedgerPath();
	if (!p) return { ok: true, entries: [], path: null };
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
 */
export function clearLedger() {
	const p = findCurrentLedgerPath();
	if (!p) return { ok: true, cleared: false, path: null };
	try {
		fs.writeFileSync(p, "", "utf8");
		return { ok: true, cleared: true, path: p };
	} catch (err) {
		warnOnce("clear failed", err);
		return { ok: false, cleared: false, path: p };
	}
}
