// src/operation-lock.js — cross-process operation lock.
//
// PURPOSE
// -------
// This file is the cross-process operation lock for compound brain mutations.
// It serializes the multi-file writes performed by `src/snapshot.js`,
// `src/consolidate.js`, and any future multi-file write path so they cannot
// race against each other (e.g. a `snapshot` clobbering files a `consolidate`
// is mid-flight on). It is deliberately distinct from `config.js`'s
// `withConfigLock`, which is scoped to `config.json` only and is owned by
// config.js's CAS-layer style — see "BOUNDARY" below.
//
// BOUNDARY WITH config.js
// -----------------------
// `config.json` already has its own lock primitive — `withConfigLock` in
// `src/config.js`, implemented at config.js's CAS-layer style (atomic
// compare-and-swap on the file itself). That lock is, and remains, the
// ONLY sanctioned lock for `config.json`. This operation lock is NOT a
// replacement for it and must NOT be wired into the `config` row of the
// conflict matrix below.
//
// Compound mutations that touch both brain files and `config.json` must
// acquire BOTH locks (this one for the brain side, `withConfigLock` for the
// config side). Always acquire `withConfigLock` LAST so its shorter critical
// section cannot starve longer-running brain mutations.
//
// LOCK TIMEOUT
// ------------
// The default acquisition timeout is **5000 ms** (deferred implementation
// decision per USER-DECISIONS.md — T6.0.2 will codify the constant). The
// timeout is bounded: an acquisition that does not succeed within the
// window returns a structured refusal —
//
//     { ok: false, reason: "operation busy", lock, waitedMs }
//
// — and the caller is responsible for surfacing or retrying. There is no
// infinite wait, no silent blocking, and NO public MCP force-release tool;
// recovery of stale locks is automatic (see STALE-LOCK RECOVERY below), but
// manual release is an operator-only path.
//
// STALE-LOCK RECOVERY
// -------------------
// Lock files live at `~/.agents/.locks/<name>.lock` and carry metadata so a
// new acquisition can decide whether the recorded holder is still alive:
//
//     {
//       pid:        <number>,   // process id of the holder
//       hostname:   <string>,   // host the holder ran on
//       operation:  <string>,   // caller-supplied tag for forensics
//       startedAt:  <number>,   // epoch ms when the lock was taken
//       timeoutMs:  <number>,   // the timeout the holder declared
//     }
//
// Before treating an existing lock file as held, an acquirer checks whether
// the recorded `pid` is still alive on `hostname`. The aliveness probe uses
// `process.kill(pid, 0)` and treats `ESRCH` (no such process) as
// "stale — recover": the stale lock file is replaced atomically and the
// acquisition proceeds. `EPERM` (process exists but not ours to signal) is
// treated as "alive — keep waiting". A stale-on-different-host lock is
// always recovered regardless of pid.
//
// === LOCK CONFLICT MATRIX (canonical — do not edit without team review) ===
//
// snapshot     conflicts with: brain_write (all kinds), lesson_capture, lesson_consolidate, restore
// consolidate conflicts with: lesson_capture, brain_write (LESSONS kind)
// config       already handled by config.js CAS (do NOT add to this lock)
//
// (Implementation: T6.0.2 — withOperationLock(name, fn, { timeoutMs }).)
//
// === END T6.0.4 spec (lines above preserved verbatim from commit 65d2b36) ===
//
// === T6.0.2 implementation ===============================================
//
// Design notes
// ------------
// I chose the ALIASING approach: multiple operation names share the same
// lock file. Two lock files total:
//
//   - snapshot.lock    — held by: snapshot, brain_write (all kinds),
//                        lesson_capture, lesson_consolidate, restore
//   - consolidate.lock — held by: consolidate, brain_write (kind === "LESSONS")
//
// Aliasing loses per-operation forensics (a held lock file can't tell you
// which of the aliased ops is running), but keeps the on-disk surface to
// two files, which makes operator reasoning simpler ("is anything running?"
// = "is either file present?"). The alternative — one file per operation
// name — costs 6 files for marginally better forensics; we judged that not
// worth it for v0.8.x.
//
// Two edge cases the aliasing map makes explicit:
//
//   1. `lesson_capture` is in BOTH conflict sets (snapshot AND consolidate),
//      so it acquires both lock files. We acquire `consolidate.lock` first
//      (smaller critical section) and then `snapshot.lock`. This order is
//      the same one `brain_write` (kind=LESSONS) follows.
//
//   2. `brain_write` always conflicts with `snapshot` and additionally
//      conflicts with `consolidate` ONLY when `opts.kind === "LESSONS"`.
//      The conditional is handled at the call site: we accept `opts.kind`
//      and only add `consolidate.lock` to the acquisition set when
//      `kind === "LESSONS"`. The `brain_write` row in CONFLICTS shows the
//      LESSONS-shape; the non-LESSONS branch is handled by resolveLockFiles.
//
// Lock-acquisition algorithm
// --------------------------
// 1. Resolve the list of lock files to acquire from CONFLICTS + opts.kind
//    (see resolveLockFiles). Lock files are tried in declaration order;
//    when more than one is needed, consolidate.lock is tried first.
//
// 2. For each lock file, acquire under the OVERALL timeoutMs budget:
//    a. Try fs.openSync(lock, "wx") (atomic exclusive-create on POSIX and
//       Windows). On success, write the metadata JSON, close, and add the
//       path to the "acquired" list.
//    b. On EEXIST, check stale recovery (see below). If stale, unlink and
//       retry immediately. If not stale, sleep briefly and retry.
//    c. If the overall deadline elapses during step 2, release any partial
//       acquisitions (ownership-guarded unlink) and throw a structured
//       OPERATION_BUSY error { code, lock, waitedMs, lockFiles }.
//
// 3. Run fn(). On success or failure, release all acquired locks in
//    finally (ownership-guarded: only unlink if the content still matches
//    our metadata string).
//
// Stale-lock recovery
// -------------------
// When EEXIST is hit, the existing lock file is examined. It is treated as
// stale (unlinked, acquisition retried) when ANY of these holds:
//   - The metadata is unparseable / malformed (readMetadata returned null).
//   - metadata.hostname !== os.hostname() (different host).
//   - process.kill(metadata.pid, 0) throws ESRCH (pid is dead).
//   - The holder's pid is alive AND (now - metadata.startedAt) has
//     overrun metadata.timeoutMs * 2 — a defensive upper bound on
//     "still working" for a holder that did not release cleanly.
// Otherwise we keep waiting: EPERM (alive but not signalable) and no-throw
// (alive and signalable) both count as "holder is alive, lock is fresh".
//
// Why the backoff is `await new Promise(setTimeout)` (not Atomics.wait):
// withConfigLock uses Atomics.wait because its caller is synchronous — the
// event loop is fine to block briefly. withOperationLock is async: if the
// backoff blocked the main thread, it would starve the very async work we
// need to make progress (another caller's `fn()` releasing its lock,
// setTimeout callbacks, etc.). Promise-based sleep yields to the event loop
// so concurrent acquirers can interleave.
//
// Release
// -------
// In finally, for each acquired lock file: read current content; if it
// matches our metadata string, unlink. Tolerate ENOENT (someone else got
// there first, or we already released).
//
// Imports
// -------
// Pure Node: node:fs / node:os / node:path. No new npm dependencies.
// HOME is imported from util.js (computed at module load — tests must set
// AGENT_CLI_HOME BEFORE importing this module, matching the convention in
// test/util.test.js and test/config.test.js).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME } from "./util.js";

const LOCKS_DIR = path.join(HOME, ".agents", ".locks");
const DEFAULT_TIMEOUT_MS = 5000;

/** Operation -> list of lock files it acquires, in declaration order.
 *
 *  Order matters: when more than one lock file is needed, consolidate.lock
 *  is tried first (smaller critical section). brain_write's row reflects
 *  its LESSONS shape; the non-LESSONS branch is handled by
 *  resolveLockFiles because the conditional lives in opts.kind, not here.
 *
 *  `config` is NOT in this matrix — it is handled separately by
 *  `withConfigLock` in src/config.js.
 */
const CONFLICTS = Object.freeze({
	snapshot:           ["snapshot.lock"],
	consolidate:        ["consolidate.lock"],
	brain_write:        ["consolidate.lock", "snapshot.lock"], // only when opts.kind === "LESSONS"
	lesson_capture:     ["consolidate.lock", "snapshot.lock"],
	lesson_consolidate: ["snapshot.lock"],
	restore:            ["snapshot.lock"],
});

function resolveLockFiles(name, opts) {
	if (name === "brain_write") {
		// Conditional: consolidate.lock is only added when opts.kind === "LESSONS".
		// The non-LESSONS shape (just snapshot.lock) is the common case.
		return opts.kind === "LESSONS"
			? ["consolidate.lock", "snapshot.lock"]
			: ["snapshot.lock"];
	}
	const fixed = CONFLICTS[name];
	if (!fixed) {
		throw new Error(
			`withOperationLock: unknown operation ${JSON.stringify(name)}; known: brain_write, ${Object.keys(CONFLICTS).join(", ")}`,
		);
	}
	// Return a fresh array so callers can mutate without freezing the table.
	return fixed.slice();
}

/** Read and parse the existing lock metadata. Returns null on any
 *  read/parse failure or unparseable payload — callers should treat null
 *  as stale (recover). */
function readMetadata(lockFile) {
	let raw;
	try {
		raw = fs.readFileSync(lockFile, "utf8");
	} catch {
		return null;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	if (typeof parsed.pid !== "number") return null;
	if (typeof parsed.hostname !== "string") return null;
	if (typeof parsed.startedAt !== "number") return null;
	if (typeof parsed.timeoutMs !== "number") return null;
	return parsed;
}

/** Returns true if the existing lock should be treated as stale (recover).
 *  See the stale-lock-recovery block in the file header for the rules. */
function isStale(metadata) {
	if (!metadata) return true;
	if (metadata.hostname !== os.hostname()) return true;
	let alive = true;
	try {
		process.kill(metadata.pid, 0);
	} catch (e) {
		if (e.code === "ESRCH") return true;
		if (e.code === "EPERM") {
			alive = false;
		} else {
			throw e; // unexpected — propagate so it isn't silently swallowed
		}
	}
	if (alive) {
		// Pid is alive — only treat as stale if the holder has grossly
		// overrun their declared timeout (now - startedAt >= timeoutMs * 2).
		// This is a defensive upper bound on "still working".
		const age = Date.now() - metadata.startedAt;
		return age >= metadata.timeoutMs * 2;
	}
	// EPERM: pid exists but not ours to signal. Treat as alive — keep waiting.
	return false;
}

// Non-blocking backoff helper. We MUST NOT use Atomics.wait here — it would
// block the Node.js main thread and starve the very async work (another
// withOperationLock caller's fn() releasing its lock, setTimeout callbacks,
// etc.) we need to make progress. 10 ms yields control to the event loop.
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/** Acquire a single lock file. On deadline, throws a structured
 *  OPERATION_BUSY error (already shaped per the file header contract). */
async function acquireOne(lockFile, metadataStr, ctx) {
	for (;;) {
		if (Date.now() > ctx.deadline) {
			const err = new Error(
				ctx.lastTransient
					? `operation busy (last acquire error: ${ctx.lastTransient} — if this persists, check permissions on ${lockFile})`
					: "operation busy",
			);
			err.code = "OPERATION_BUSY";
			err.lock = ctx.name;
			err.waitedMs = Date.now() - ctx.startTime;
			err.lockFiles = ctx.lockFiles;
			// A genuine permission fault and a busy lock both end up here on win32.
			// Surfacing the last code keeps them distinguishable to a caller.
			if (ctx.lastTransient) err.lastAcquireError = ctx.lastTransient;
			throw err;
		}
		try {
			const fd = fs.openSync(lockFile, "wx");
			try {
				fs.writeFileSync(fd, metadataStr, "utf8");
			} finally {
				fs.closeSync(fd);
			}
			return;
		} catch (e) {
			// Windows reports a CONTENDED lock as EPERM/EACCES, not EEXIST.
			// Unlinking a file another process still holds open leaves it in a
			// pending-delete state, and opening it again returns ERROR_ACCESS_DENIED
			// until the last handle closes. Under concurrent acquire/release — six
			// `target enable` processes, say — that is ordinary contention, but the
			// old code threw it straight out and failed the whole operation.
			//
			// Retrying is safe: the deadline check at the top of the loop still
			// bounds the wait, so a real permission fault times out as
			// OPERATION_BUSY (carrying lastAcquireError) instead of spinning.
			// There is no metadata to inspect in this state — the file is mid-delete
			// — so staleness cannot be evaluated and backing off is all we can do.
			const winContended =
				process.platform === "win32" &&
				(e.code === "EPERM" || e.code === "EACCES");
			if (e.code !== "EEXIST" && !winContended) throw e;
			if (winContended) {
				ctx.lastTransient = e.code;
				await sleep(10);
				continue;
			}
			// Ordinary EEXIST contention: clear any earlier transient code so a
			// timeout here reports a busy lock rather than blaming a permission
			// error the loop has since recovered from. Without this, one EPERM
			// early in a long wait would mislabel every later timeout.
			ctx.lastTransient = null;
			const meta = readMetadata(lockFile);
			if (isStale(meta)) {
				try {
					fs.unlinkSync(lockFile);
				} catch (unlinkErr) {
					if (unlinkErr.code !== "ENOENT") throw unlinkErr;
				}
				continue;
			}
			// Not stale — brief backoff so concurrent acquirers don't spin hot.
			await sleep(10);
		}
	}
}

/** Ownership-guarded unlink: only remove the lock file if its current
 *  content still matches our metadata string. Tolerate ENOENT (someone
 *  else got there first, or we already released). */
function releaseOne(lockFile, metadataStr) {
	try {
		const cur = fs.readFileSync(lockFile, "utf8");
		if (cur === metadataStr) fs.unlinkSync(lockFile);
	} catch {
		/* best-effort */
	}
}

/**
 * Cross-process operation lock — see file header for the conflict matrix
 * and algorithm. Acquires all lock files implied by `name` (and `opts.kind`
 * for `brain_write`) before running `fn()`. Releases them all on the way
 * out, regardless of whether `fn` returned or threw.
 *
 * Same-process re-entry: not specially handled. Two `withOperationLock`
 * calls in the same process serialize naturally — the first releases the
 * lock before the second tries to acquire it. Truly nested calls (a
 * critical section that calls withOperationLock for another op) will block
 * forever; this matches `withConfigLock`'s behavior and is the caller's
 * responsibility.
 *
 * @param {string} name  one of the keys of CONFLICTS (or `brain_write`).
 * @param {() => any} fn the critical section. May be sync or async.
 * @param {{ timeoutMs?: number, kind?: string }} [opts]
 *        timeoutMs — total wait for ALL lock files to be acquired
 *                    (default 5000 per USER-DECISIONS Item 5).
 *        kind      — only `brain_write` reads it: opts.kind === "LESSONS"
 *                    adds `consolidate.lock` to the conflict set.
 * @returns the value returned by `fn()`.
 * @throws on lock acquisition timeout, with err.code === "OPERATION_BUSY",
 *         err.lock === name, err.waitedMs === <observed wait>,
 *         err.lockFiles === <list of files we were trying to take>.
 *         Also propagates any error thrown by `fn()`.
 */
export async function withOperationLock(name, fn, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const startTime = Date.now();
	const deadline = startTime + timeoutMs;
	const lockFileBases = resolveLockFiles(name, opts);
	// resolveLockFiles returns BASENAMES (e.g. "snapshot.lock") so the
	// conflict matrix above stays readable. Join them with LOCKS_DIR to get
	// full paths before handing them to the fs layer.
	const lockFiles = lockFileBases.map((b) => path.join(LOCKS_DIR, b));

	const metadata = {
		pid: process.pid,
		hostname: os.hostname(),
		operation: name,
		startedAt: startTime,
		timeoutMs,
	};
	const metadataStr = JSON.stringify(metadata);

	fs.mkdirSync(LOCKS_DIR, { recursive: true });

	const ctx = { name, lockFiles, startTime, deadline };
	const acquired = [];
	try {
		for (const lockFile of lockFiles) {
			await acquireOne(lockFile, metadataStr, ctx);
			acquired.push(lockFile);
		}
		return await fn();
	} finally {
		// Release in reverse acquisition order so a partial acquisition
		// (deadline hit mid-acquire) doesn't leave a lock orphaned.
		for (let i = acquired.length - 1; i >= 0; i--) {
			releaseOne(acquired[i], metadataStr);
		}
	}
}