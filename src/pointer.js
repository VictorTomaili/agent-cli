// src/pointer.js — generate + write + inspect the thin pointer stubs that redirect
// each agent's native config file to the canonical ~/.agents/AGENTS.md master.

import path from "node:path";
import { lstat } from "node:fs/promises";
import { readIfExists, writeFile, pretty, normalizeEndings } from "./util.js";
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
			masterAbs: "~/.agents/AGENTS.md",
			masterTilde: "~/.agents/AGENTS.md",
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
