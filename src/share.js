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
// Skills also link a hub: ~/.agents/skills → the store. pi natively
// reads ~/.agents/skills (and projects' .agents/skills), so the hub
// gives pi zero-config access to the whole store — and kills the
// historical seed-copy/store duplication.
//
// Contract mirrors pointer.js: link refuses to replace native
// (non-link) content unless force; force backs the native dir up
// (rename, never delete) before linking; unlink only ever removes a
// link that verifiably points at OUR source.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "./util.js";
import { TARGETS } from "./targets.js";
import { PATHS as SKILL_PATHS } from "./skill.js";

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

/** Home-relative share dirs a target reads (see targets.js `share`). */
export function sharePathFor(target, kind) {
	const rel = target?.share?.[kind];
	return rel ? path.join(HOME, rel) : null;
}

/** All targets that declare a share dir for `kind`. */
export function targetsWithShare(kind) {
	return TARGETS.filter((t) => t?.share?.[kind]);
}

/**
 * Classify one share link point. Returns { state, path }:
 *   linked  — our symlink/junction → the source
 *   native  — exists but is NOT our link (real dir/file/symlink elsewhere)
 *   missing — nothing there
 */
export function classifyShare(dst, srcAbs) {
	try {
		fs.lstatSync(dst);
	} catch {
		return { state: "missing", path: dst };
	}
	return {
		state: isOurLink(dst, srcAbs) ? "linked" : "native",
		path: dst,
	};
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
	if (cls.state === "linked")
		return { path: dst, linked: true, unchanged: true };
	if (cls.state === "native" && !force)
		return {
			path: dst,
			blocked: "native-content",
			hint:
				"move its contents into the shared source (or re-run with --force to back it up and link)",
		};
	let backup = null;
	if (cls.state === "native") {
		backup = `${dst}.agent-cli-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
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
 */
export function unlinkShareDir(dst, srcAbs) {
	const cls = classifyShare(dst, srcAbs);
	if (cls.state === "missing") return { path: dst, missing: true };
	if (cls.state === "native") return { path: dst, skipped: "native-content" };
	fs.rmSync(dst, { recursive: true, force: true });
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
