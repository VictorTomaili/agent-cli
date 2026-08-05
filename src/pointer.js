// src/pointer.js — generate + write + inspect the thin pointer stubs that redirect
// each agent's native config file to the canonical ~/AGENTS.md master.

import path from "node:path";
import { lstat } from "node:fs/promises";
import {
	readIfExists,
	writeFile,
	pretty,
	normalizeEndings,
	MASTER_FILE,
	POINTER_MASTER_FILE,
} from "./util.js";
import { pathFor, scopesFor, adaptContent } from "./targets.js";
import { resolveScope } from "./util.js";

export const POINTER_MARK = "<!-- agent-cli-pointer -->";

function pointerLines(target, scope, { masterAbs, masterTilde }) {
	const name = nativeName(target, scope);
	return [
		POINTER_MARK,
		`<!-- target: ${target.id} -->`,
		`<!-- scope: ${scope} -->`,
		`<!-- native: ${name} -->`,
		`<!-- master-abs: ${masterAbs} -->`,
		`<!-- master-tilde: ${masterTilde} -->`,
		"",
		`# ${name} → redirected by agent-cli`,
		"",
		"This file is a **pointer stub**. Your canonical agent instructions live in ONE",
		"shared source of truth, used by all your coding agents:",
		"",
		`    ${masterAbs}`,
		`    (short: ${masterTilde})`,
		"",
		"➡️ **Read that file now** with your file-reading tool and follow it as your",
		`   primary ${name}. Everything that belongs here is there.`,
		"",
		"Do NOT edit this pointer — it has no effect. Edit the canonical file instead",
		"(`agent edit`), or redeploy stubs with `agent link`.",
	];
}

// --- master-pointer stub (the agent-cli-managed pointer at ~/.agents/AGENTS.md) ---
// When the canonical master lives at ~/AGENTS.md, the old ~/.agents/AGENTS.md file
// becomes a self-pointing stub — a pointer file written by agent-cli itself, not by
// a target agent. It uses sentinel values for target/scope/native so the generic
// `parsePointer` (which compares against a real target's id) cannot match it.
const MASTER_POINTER_TARGET = "agent-cli-master-pointer";
const MASTER_POINTER_SCOPE = "agent-cli";
const MASTER_POINTER_NATIVE = "AGENTS.md";
const MASTER_POINTER_HEAD = "# AGENTS.md (agent-cli's local copy) → redirected by agent-cli";

/**
 * Build the on-disk body for the agent-cli self-pointer stub at
 * ~/.agents/AGENTS.md (POINTER_MASTER_FILE). Mirrors the shape of
 * `pointerContent` but with sentinel values that the generic parser ignores.
 */
export function masterPointerContent({ masterAbs, masterTilde }) {
	return [
		POINTER_MARK,
		`<!-- target: ${MASTER_POINTER_TARGET} -->`,
		`<!-- scope: ${MASTER_POINTER_SCOPE} -->`,
		`<!-- native: ${MASTER_POINTER_NATIVE} -->`,
		`<!-- master-abs: ${masterAbs} -->`,
		`<!-- master-tilde: ${masterTilde} -->`,
		"",
		MASTER_POINTER_HEAD,
		"",
		"This file is a **pointer stub**. Your canonical agent instructions live in ONE",
		"shared source of truth, used by all your coding agents:",
		"",
		`    ${masterAbs}`,
		`    (short: ${masterTilde})`,
		"",
		"➡️ **Read that file now** with your file-reading tool and follow it as your",
		"   primary AGENTS.md. Everything that belongs here is there.",
		"",
		"Do NOT edit this pointer — it has no effect. Edit the canonical file instead",
		"(`agent edit`), or redeploy with `agent init`.",
	].join("\n");
}

/**
 * Parse a self-pointer stub body (written by `masterPointerContent`).
 * Returns { ok: true, masterAbs, masterTilde } on match, else null.
 */
export function parseMasterPointer(content) {
	if (content == null) return null;
	const lines = normalizeEndings(content).split("\n");
	if (lines.length < 6) return null;
	if (lines[0] !== POINTER_MARK) return null;
	if (lines[1] !== `<!-- target: ${MASTER_POINTER_TARGET} -->`) return null;
	if (lines[2] !== `<!-- scope: ${MASTER_POINTER_SCOPE} -->`) return null;
	if (lines[3] !== `<!-- native: ${MASTER_POINTER_NATIVE} -->`) return null;
	const absMatch = lines[4].match(/^<!-- master-abs: (.+) -->$/);
	const tildeMatch = lines[5].match(/^<!-- master-tilde: (.+) -->$/);
	if (!absMatch || !tildeMatch) return null;
	return {
		ok: true,
		masterAbs: absMatch[1],
		masterTilde: tildeMatch[1],
	};
}


// --- ONE renderer/ownership contract ------------------------------------------
// Every operation that creates or recognizes agent-cli pointer stubs funnels
// through renderPointer (what a generated stub looks like on disk) and
// parsePointer (whether an on-disk file is one of ours). Targets with a native
// transform (e.g. Cursor .mdc alwaysApply frontmatter) get that wrapper applied
// around the raw pointer body, and parsePointer accepts both the plain and the
// transformed layout so writing/classify/stale/unlink all agree.

function renderPointer(target, scope, { masterAbs, masterTilde }) {
	const body = pointerLines(target, scope, { masterAbs, masterTilde }).join("\n");
	return adaptContent(target, body, { scope });
}

function parsePointer(content, target, scope) {
	const lines = normalizeEndings(content).split("\n");
	if (lines[0] === "---") {
		// Transformed targets wrap the pointer body in native frontmatter at the
		// very top (Cursor .mdc requires YAML first). Skip the `---`…`---` block
		// and the blank separator, then parse the body exactly like the plain form.
		let end = -1;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i] === "---") {
				end = i;
				break;
			}
		}
		if (end === -1 || end === 1) return null;
		let start = end + 1;
		if (lines[start] !== "") return null;
		return parsePointerBody(lines, start + 1, target, scope);
	}
	return parsePointerBody(lines, 0, target, scope);
}

function parsePointerBody(lines, start, target, scope) {
	const name = nativeName(target, scope);
	if (lines.length !== start + 20) return null;
	const L = (k) => lines[start + k];
	if (L(0) !== POINTER_MARK) return null;
	if (L(1) !== `<!-- target: ${target.id} -->`) return null;
	if (L(2) !== `<!-- scope: ${scope} -->`) return null;
	if (L(3) !== `<!-- native: ${name} -->`) return null;
	if (!L(4).startsWith("<!-- master-abs: ") || !L(4).endsWith(" -->")) return null;
	if (!L(5).startsWith("<!-- master-tilde: ") || !L(5).endsWith(" -->")) return null;
	if (L(6) !== "") return null;
	if (L(7) !== `# ${name} → redirected by agent-cli`) return null;
	if (L(8) !== "") return null;
	if (L(9) !== "This file is a **pointer stub**. Your canonical agent instructions live in ONE") return null;
	if (L(10) !== "shared source of truth, used by all your coding agents:") return null;
	if (L(11) !== "") return null;
	if (!L(12).startsWith("    ")) return null;
	if (!L(13).startsWith("    (short: ") || !L(13).endsWith(")")) return null;
	if (L(14) !== "") return null;
	if (L(15) !== "➡️ **Read that file now** with your file-reading tool and follow it as your") return null;
	if (L(16) !== `   primary ${name}. Everything that belongs here is there.`) return null;
	if (L(17) !== "") return null;
	if (L(18) !== "Do NOT edit this pointer — it has no effect. Edit the canonical file instead") return null;
	if (L(19) !== "(`agent edit`), or redeploy stubs with `agent link`.") return null;
	return { ok: true };
}

async function isSymlinkPath(p) {
	try {
		return (await lstat(p)).isSymbolicLink();
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

function pointerState(content, target, scope, desired) {
	const parsed = parsePointer(content, target, scope);
	if (!parsed) return "native";
	return normalizeEndings(content).trim() === normalizeEndings(desired).trim()
		? "pointer"
		: "pointer-stale";
}

/** Absolute path a target's stub resolves to in a given scope, or null. */
export function targetPath(target, scope) {
	const rel = pathFor(target, scope);
	if (!rel) return null;
	return resolveScope(rel, scope);
}

function nativeName(target, scope) {
	const rel =
		pathFor(target, scope) || target.project || target.global || "AGENTS.md";
	return path.basename(rel);
}

/** Build the full on-disk pointer stub for a target/scope (transformed form). */
export function pointerContent(target, scope, { masterAbs, masterTilde }) {
	return renderPointer(target, scope, { masterAbs, masterTilde });
}

// --- legacy aliases -----------------------------------------------------------
// Some targets carry a legacy alias path (e.g. windsurf .windsurfrules). It is
// managed with the SAME render/parse/state contract as the primary path so
// write/classify/unlink stay coherent across both files.

function legacyAliasPath(target, scope) {
	const rel = scope === "project" ? target.legacyProject : null;
	if (!rel) return null;
	return resolveScope(rel, scope);
}

async function legacyState(target, scope) {
	const p = legacyAliasPath(target, scope);
	if (!p) return null;
	if (await isSymlinkPath(p)) return { path: p, state: "native" };
	const content = await readIfExists(p);
	if (content == null) return { path: p, state: "missing" };
	const expected = pointerContent(target, scope, expectedCtx());
	return { path: p, state: pointerState(content, target, scope, expected) };
}

/** Classify a target file's current state. */
export async function classify(target, scope) {
	const p = targetPath(target, scope);
	if (!p) return { path: null, state: "unsupported" };
	if (await isSymlinkPath(p)) return { path: p, state: "native" };
	const content = await readIfExists(p);
	if (content == null) return { path: p, state: "missing" };
	const expected = pointerContent(target, scope, expectedCtx());
	const state = pointerState(content, target, scope, expected);
	const legacy = await legacyState(target, scope);
	return legacy ? { path: p, state, legacy } : { path: p, state };
}

let _ctx = null;
export function setExpectedCtx(ctx) {
	_ctx = ctx;
}
function expectedCtx() {
	return (
		_ctx || {
			masterAbs: pretty(MASTER_FILE),
			masterTilde: pretty(MASTER_FILE),
		}
	);
}

/**
 * Write a pointer stub for a target/scope (and its legacy alias, if any). If a
 * file has native (non-pointer) content, refuse unless `force` — caller should
 * `pull` it into the master first.
 */
export async function linkTarget(
	target,
	scope,
	{ masterAbs, masterTilde, force = false },
) {
	const p = targetPath(target, scope);
	if (!p) return { target, scope, path: null, skipped: "unsupported" };
	if (await isSymlinkPath(p)) {
		return { target, scope, path: p, blocked: "native-content", hint: "remove-symlink" };
	}
	if (p === MASTER_FILE || p === POINTER_MASTER_FILE) {
		// Both the canonical master and the agent-cli self-pointer stub are
		// never `linkTarget` targets — the master is content, the self-pointer
		// is owned by `ensureMasterPointer`. Skip silently.
		return { target, scope, path: p, skipped: "is-master" };
	}
	const desired = pointerContent(target, scope, { masterAbs, masterTilde });
	const existing = await readIfExists(p);
	let main;
	if (existing !== null) {
		const existingState = pointerState(existing, target, scope, desired);
		if (existingState === "native" && !force) {
			return { target, scope, path: p, blocked: "native-content", hint: "pull" };
		}
		if (
			normalizeEndings(existing).trim() === normalizeEndings(desired).trim()
		) {
			main = { ok: true, unchanged: true };
		}
	}
	if (!main) {
		await writeFile(p, desired);
		main = { linked: true };
	}
	const legacy = await linkLegacy(target, scope, desired, force);
	return { target, scope, path: p, ...main, ...(legacy ? { legacy } : {}) };
}

async function linkLegacy(target, scope, desired, force) {
	const p = legacyAliasPath(target, scope);
	if (!p) return null;
	const existing = await readIfExists(p);
	if (existing !== null) {
		const existingState = pointerState(existing, target, scope, desired);
		if (existingState === "native" && !force) {
			return { path: p, blocked: "native-content", hint: "pull" };
		}
		if (
			normalizeEndings(existing).trim() === normalizeEndings(desired).trim()
		) {
			return { path: p, ok: true, unchanged: true };
		}
	}
	await writeFile(p, desired);
	return { path: p, linked: true };
}

/** Remove a pointer stub (only deletes files that ARE pointers). */
export async function unlinkTarget(target, scope, { preserve = false } = {}) {
	const p = targetPath(target, scope);
	if (!p) return { target, scope, skipped: "unsupported" };
	const legacyPath = legacyAliasPath(target, scope);
	if (preserve) {
		return {
			target,
			scope,
			path: p,
			preserved: "shared-target-path",
			...(legacyPath
				? { legacy: { path: legacyPath, preserved: "shared-target-path" } }
				: {}),
		};
	}
	if (await isSymlinkPath(p)) {
		return { target, scope, path: p, skipped: "native-content" };
	}
	const existing = await readIfExists(p);
	if (existing == null) {
		const legacy = await unlinkLegacy(target, scope);
		return { target, scope, path: p, missing: true, ...(legacy ? { legacy } : {}) };
	}
	if (
		pointerState(
			existing,
			target,
			scope,
			pointerContent(target, scope, expectedCtx()),
		) === "native"
	) {
		return { target, scope, path: p, skipped: "native-content" };
	}
	const { rm } = await import("node:fs/promises");
	await rm(p);
	const legacy = await unlinkLegacy(target, scope);
	return { target, scope, path: p, unlinked: true, ...(legacy ? { legacy } : {}) };
}

async function unlinkLegacy(target, scope) {
	const p = legacyAliasPath(target, scope);
	if (!p) return null;
	if (await isSymlinkPath(p)) return { path: p, skipped: "native-content" };
	const existing = await readIfExists(p);
	if (existing == null) return { path: p, missing: true };
	if (
		pointerState(
			existing,
			target,
			scope,
			pointerContent(target, scope, expectedCtx()),
		) === "native"
	) {
		return { path: p, skipped: "native-content" };
	}
	const { rm } = await import("node:fs/promises");
	await rm(p);
	return { path: p, unlinked: true };
}

export function scopesForTarget(target) {
	return scopesFor(target);
}

export function prettyPath(p) {
	return pretty(p);
}
