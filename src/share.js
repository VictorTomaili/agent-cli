// src/share.js — cross-tool sharing links ("manage once, use everywhere").
//
// Single sources of truth:
//   personas  ~/.agents/agents/        (agent-cli `agents` roster)
//   skills    ~/.skill-cli/store/      (the skill manager's store)
//
// Each agent-capable coding tool gets its own expected directory
// (e.g. ~/.claude/agents) linked to the source with a directory
// symlink (POSIX) or junction (Windows — works without admin rights
// for absolute directory targets). A linked directory propagates
// INSTANTLY: a persona or skill added to the source appears in every
// linked tool with no re-run.
//
// State-machine ownership lives in src/managed-resource.js — this file
// stays focused on the I/O (symlinks on disk) and the per-share-kind
// orchestration. The cardinal invariants it relies on:
//
//   - link refuses to replace native (non-link) content unless force
//   - force backs the native dir up (rename, never delete) before linking
//   - unlink only ever removes a link that verifiably points at OUR source

import fs from "node:fs";
import path from "node:path";
import { HOME } from "./util.js";
import { TARGETS } from "./targets.js";
import { PATHS as SKILL_PATHS } from "./skill.js";
import { STATES, planLink, planUnlink, backupPath } from "./managed-resource.js";

/** The single sources (agents dir, skill store). */
export const SHARE_SOURCES = {
	agents: path.join(HOME, ".agents", "agents"),
	skills: SKILL_PATHS.SKILL_STORE,
};

export const SHARE_KINDS = ["agents", "skills"];

// --- primitives --------------------------------------------------------------

/** Normalize a readlink result: Windows junctions may return \\?\-prefixed. */
function normalizeLinkTarget(p) {
	return String(p).replace(/^\\\\\?\\/, "");
}

/**
 * Is `dst` a symlink/junction that resolves to `srcAbs`?
 * readlink first (does not require the source to exist); realpath compare
 * as a fallback for exotic junction forms.
 */
export function isOurLink(dst, srcAbs) {
	let st;
	try {
		st = fs.lstatSync(dst);
	} catch {
		return false;
	}
	if (!st.isSymbolicLink()) return false;
	try {
		if (
			path.resolve(normalizeLinkTarget(fs.readlinkSync(dst))) ===
			path.resolve(srcAbs)
		)
			return true;
	} catch {
		/* fall through to realpath */
	}
	try {
		return fs.realpathSync(dst) === fs.realpathSync(srcAbs);
	} catch {
		return false;
	}
}

/** Home-relative share dirs a target reads (see targets.js `share`).
 *  Returns null when the target does not declare this kind, OR when the
 *  declared path would escape HOME via `..` traversal or absolute path —
 *  share is a hand-edited field in src/targets/<id>.js, so this is the
 *  containment boundary that keeps a buggy descriptor from symlinking
 *  anything outside HOME. */
export function sharePathFor(target, kind) {
	const rel = target?.share?.[kind];
	if (!rel) return null;
	if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return null;
	const resolved = path.join(HOME, rel);
	// Defense in depth: even if the descriptor is path.join-clean, ensure the
	// final result still lives under HOME (catches edge cases on Windows
	// where path.sep differs and on symlinked HOME setups).
	if (
		resolved !== HOME &&
		!resolved.startsWith(HOME + path.sep)
	) {
		return null;
	}
	return resolved;
}

/** All targets that declare a share dir for `kind`. */
export function targetsWithShare(kind) {
	return TARGETS.filter((t) => t?.share?.[kind]);
}

/**
 * Classify one share link point. Returns { state, path }:
 *   linked  — our symlink/junction → the source (mirrors managed-resource's "ours")
 *   native  — exists but is NOT our link (real dir/file/symlink elsewhere)
 *   missing — nothing there
 *
 * `linked` is the share.js vocabulary (the consumer-facing term). The lib uses
 * the more general "ours" elsewhere; we keep "linked" here for backward compat
 * (this function is consumed by doctor/brief/shareHealth).
 */
export function classifyShare(dst, srcAbs) {
	let st;
	try {
		st = fs.lstatSync(dst);
	} catch {
		return { state: "missing", path: dst };
	}
	// A symlink that points at our source → "linked" (managed-resource's "ours").
	// Any other lstat result (real dir, foreign symlink) → "native".
	if (st.isSymbolicLink() && isOurLink(dst, srcAbs)) {
		return { state: "linked", path: dst };
	}
	return { state: "native", path: dst };
}

/**
 * Map classifyShare()'s consumer-vocabulary state to the managed-resource
 * lib's general state names. share.js keeps "linked"/"native"/"missing" in
 * its public surface for compatibility; this mapper is the bridge.
 */
function shareStateToGeneral(s) {
	if (s === "linked") return STATES.OURS;
	return s; // "native" | "missing" pass through
}

/**
 * Link `dst` → `srcAbs` (directory symlink on POSIX, junction on Windows —
 * both need no elevation for absolute dir targets on Windows 10+ with
 * developer mode OFF: junctions never require it).
 *   missing          → create, { linked: true }
 *   already ours     → { linked: true, unchanged: true }
 *   native + !force  → { blocked: "native-content", hint: "merge-or-force" }
 *   native + force   → rename to `<dst>.agent-cli-backup-<ts>`, then link
 *                      (never deletes user content; { linked, backup })
 * The source directory is created if absent (a linked-but-empty source is
 * fine — content can appear later).
 */
export function linkShareDir(dst, srcAbs, { force = false } = {}) {
	const cls = classifyShare(dst, srcAbs);
	const general = shareStateToGeneral(cls.state);
	const action = planLink(general, force);
	if (action === "noop") {
		return { path: dst, linked: true, unchanged: true };
	}
	if (action === "block") {
		return {
			path: dst,
			blocked: "native-content",
			hint:
				"move its contents into the shared source (or re-run with --force to back it up and link)",
		};
	}
	let backup = null;
	if (general === STATES.NATIVE) {
		backup = backupPath(dst);
		fs.renameSync(dst, backup);
	}
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.mkdirSync(srcAbs, { recursive: true });
	const type = process.platform === "win32" ? "junction" : "dir";
	fs.symlinkSync(path.resolve(srcAbs), dst, type);
	return { path: dst, linked: true, ...(backup ? { backup } : {}) };
}

/**
 * Remove a share link — ONLY when it verifiably points at our source.
 * Native content and foreign links are never touched.
 *
 * The unlink path uses `fs.unlinkSync` (not `fs.rmSync({recursive:true})`):
 * the only correct target is our own symlink, which is always unlinkable
 * with unlinkSync. If something other than our link is at `dst` (a real
 * directory, a foreign symlink, …) unlinkSync fails with EISDIR/EPERM
 * instead of recursively deleting a directory the user did not intend to
 * surrender. The classify check is re-validated immediately before the
 * unlink to close the TOCTOU window between classify and the syscall.
 */
export function unlinkShareDir(dst, srcAbs) {
	const cls = classifyShare(dst, srcAbs);
	const general = shareStateToGeneral(cls.state);
	const action = planUnlink(general);
	if (action === "noop") return { path: dst, missing: true };
	if (action === "block") return { path: dst, skipped: "native-content" };
	// Re-check immediately before the destructive syscall. If something at
	// dst changed between the first classify and now, abort — better to
	// surface the error than silently rm what isn't ours.
	if (!isOurLink(dst, srcAbs)) {
		return {
			path: dst,
			skipped: "race-detected",
			hint: "path changed during unlink; retry to confirm the current state",
		};
	}
	try {
		fs.unlinkSync(dst);
	} catch (err) {
		if (err.code === "ENOENT") return { path: dst, missing: true };
		throw err;
	}
	return { path: dst, unlinked: true };
}

// --- orchestration ------------------------------------------------------------

/**
 * Link every capable target's `kind` directory (plus the skills hub for
 * `skills`). ids optionally restricts targets (validated by the caller).
 * Returns per-point results: [{ id, path, ...result }] where id is the
 * target id or "hub".
 */
export function linkShared(kind, ids = null, { force = false } = {}) {
	const src = SHARE_SOURCES[kind];
	const out = [];
	for (const t of targetsWithShare(kind)) {
		if (ids && !ids.includes(t.id)) continue;
		const dst = sharePathFor(t, kind);
		if (!dst) continue;
		out.push({ id: t.id, ...linkShareDir(dst, src, { force }) });
	}
	return out;
}

/** Unlink every (or selected) target's `kind` directory. */
export function unlinkShared(kind, ids = null) {
	const src = SHARE_SOURCES[kind];
	const out = [];
	for (const t of targetsWithShare(kind)) {
		if (ids && !ids.includes(t.id)) continue;
		const dst = sharePathFor(t, kind);
		if (!dst) continue;
		out.push({ id: t.id, ...unlinkShareDir(dst, src) });
	}
	return out;
}

/**
 * Health snapshot for doctor/brief: for each share-capable target that the
 * user actually has (enabled in cfg.global OR installed on this machine),
 * report agents/skills link states. The hub is reported as id "hub" under
 * skills. Returns [{ kind, id, state, path }].
 */
export function shareHealth(cfg, { kinds = SHARE_KINDS, installed = [] } = {}) {
	const enabled = new Set([...(cfg?.global ?? []), ...installed]);
	const out = [];
	for (const kind of kinds) {
		for (const t of targetsWithShare(kind)) {
			if (!enabled.has(t.id)) continue;
			const dst = sharePathFor(t, kind);
			if (!dst) continue;
			const c = classifyShare(dst, SHARE_SOURCES[kind]);
			out.push({ kind, id: t.id, state: c.state, path: c.path });
		}
	}
	return out;
}