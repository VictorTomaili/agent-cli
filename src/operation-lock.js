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
