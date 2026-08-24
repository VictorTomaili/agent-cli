// src/managed-resource.js — small shared core for "agent-cli owns this path".
//
// Three places in the codebase manage on-disk artifacts that "belong" to
// agent-cli: pointer stubs (src/pointer.js), share links (src/share.js), and
// hook entries (src/hooks.js). They all share the same conceptual state
// machine:
//
//   missing  → nothing at <path>
//   ours     → exists AND content matches what we wrote
//   stale    → exists AND content is ours, but drifted from what we'd write now
//   native   → exists AND content is NOT ours — user content we must not
//              clobber without --force
//
// And the same decision tree for `link()` / `unlink()`:
//
//   state | force | link action  | unlink action
//   ----- | ----- | ------------ | --------------
//   miss  | any   | write ours   | noop (missing)
//   ours  | any   | noop/idem    | delete ours
//   stale | any   | rewrite      | delete ours (still ours)
//   native| no    | BLOCK        | noop (not ours)
//   native| yes   | BACKUP+write | still BLOCK (refuse — unlink never force-deletes)
//
// This module owns the state machine + backup naming convention. It does NOT
// own the disk I/O — each consumer brings its own writeFn/readFn/isOursFn
// because pointer stubs are plain files, share links are symlinks, and hook
// entries are rows inside a JSON/YAML config. The lib's job is to keep the
// state names and decision table consistent across all three call sites
// so future invariants (e.g. "native-content always blocks unlink") live in
// one place instead of three.

import path from "node:path";

/** State names returned by classify(). */
export const STATES = Object.freeze({
	MISSING: "missing",
	OURS: "ours",
	STALE: "stale",
	NATIVE: "native",
});

/** Atomic "is this content ours?" check — supplied per consumer. */
export const NativeContentReason = "native-content";

/**
 * Classify a managed resource's state. Each consumer supplies the I/O
 * primitives so this lib never touches the disk directly.
 *
 * @param {object} opts
 * @param {string} opts.path  - absolute path of the resource (for logging)
 * @param {string|null|undefined} opts.content - current content (null → missing)
 * @param {boolean} [opts.isSymlink] - whether the path is currently a symlink
 *   (a symlink is ALWAYS "native" — user-owned, never ours). Optional because
 *   some consumers (hook entries) operate inside a file, not on the path itself.
 * @param {(content: string) => boolean} opts.isOurs - predicate: is this content
 *   something we wrote? Should be tolerant of legacy variants.
 * @param {(content: string) => boolean} [opts.isStale] - optional predicate:
 *   is the content ours but drifted? Defaults to "ours = not stale".
 *
 * @returns {{ state: 'missing'|'ours'|'stale'|'native', path: string,
 *             content: string|null, isSymlink: boolean }}
 */
export function classify(opts) {
	const { path: p, content, isSymlink = false, isOurs, isStale } = opts;
	if (content == null) return { state: STATES.MISSING, path: p, content: null, isSymlink };
	if (isSymlink) return { state: STATES.NATIVE, path: p, content, isSymlink };
	if (!isOurs(content)) return { state: STATES.NATIVE, path: p, content, isSymlink };
	if (isStale && isStale(content)) return { state: STATES.STALE, path: p, content, isSymlink };
	return { state: STATES.OURS, path: p, content, isSymlink };
}

/**
 * Decide what `link()` should do given the current state and a force flag.
 * Returns a discriminated union — caller maps each variant to its own I/O.
 *
 * @param {string} state - one of STATES
 * @param {boolean} force - the --force flag from the caller
 * @returns {'write' | 'noop' | 'block'}
 */
export function planLink(state, force) {
	if (state === STATES.MISSING) return "write";
	if (state === STATES.OURS) return "noop";
	if (state === STATES.STALE) return "write";
	if (state === STATES.NATIVE) return force ? "write" : "block";
	// Defensive default for unknown states — refuse rather than clobber.
	return "block";
}

/**
 * Decide what `unlink()` should do. unlink never force-deletes native content
 * — that's the cardinal invariant. If the path is native, refuse regardless of
 * force, because there's no mergeable notion of "remove the user's content."
 *
 * @param {string} state
 * @returns {'remove' | 'noop' | 'block'}
 */
export function planUnlink(state) {
	if (state === STATES.MISSING) return "noop";
	if (state === STATES.OURS || state === STATES.STALE) return "remove";
	if (state === STATES.NATIVE) return "block";
	return "block";
}

/**
 * Generate a timestamped backup path: <dst>.agent-cli-backup-<iso>.
 * Cross-platform safe — the `:` and `.` chars in ISO timestamps would otherwise
 * be illegal on Windows; we strip them. Used by share.js's "rename native dir
 * before linking" path and by anything else that force-overwrites a real file.
 */
export function backupPath(dst, now = new Date()) {
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	return `${dst}.agent-cli-backup-${stamp}`;
}

/**
 * Build the standard result shape for a `link()` operation. Consumers fill in
 * the I/O-specific fields (the `backup` path is filled by the caller when
 * `force=true && state=native`); this helper just keeps the shape consistent.
 */
export function linkResult({ path, action, force = false, backup = null, blocked = null, hint = null }) {
	const out = { path };
	if (action === "write") {
		out.linked = true;
		if (force && backup) out.backup = backup;
	} else if (action === "noop") {
		out.linked = true;
		out.unchanged = true;
	} else if (action === "block") {
		out.blocked = blocked || NativeContentReason;
		if (hint) out.hint = hint;
	}
	return out;
}

/** Build the standard result shape for an `unlink()` operation. */
export function unlinkResult({ path, action }) {
	const out = { path };
	if (action === "remove") out.unlinked = true;
	else if (action === "noop") out.missing = true;
	else if (action === "block") {
		out.skipped = NativeContentReason;
	}
	return out;
}