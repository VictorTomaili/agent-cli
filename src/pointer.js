// src/pointer.js — generate + write + inspect the thin pointer stubs that redirect
// each agent's native config file to the canonical ~/.agents/AGENTS.md master.

import path from "node:path";
import { readIfExists, writeFile, exists, pretty } from "./util.js";
import { pathFor, scopesFor } from "./targets.js";
import { resolveScope } from "./util.js";

export const POINTER_MARK = "<!-- agent-cli-pointer -->";

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

/** Build the pointer stub body for a target/scope. */
export function pointerContent(target, scope, { masterAbs, masterTilde }) {
	const name = nativeName(target, scope);
	return `${POINTER_MARK}
# ${name} → redirected by agent-cli

This file is a **pointer stub**. Your canonical agent instructions live in ONE
shared source of truth, used by all your coding agents:

    ${masterAbs}
    (short: ${masterTilde})

➡️ **Read that file now** with your file-reading tool and follow it as your
   primary ${name}. Everything that belongs here is there.

Do NOT edit this pointer — it has no effect. Edit the canonical file instead
(\`agent edit\`), or redeploy stubs with \`agent link\`.
`;
}

/** Classify a target file's current state. */
export async function classify(target, scope) {
	const p = targetPath(target, scope);
	if (!p) return { path: null, state: "unsupported" };
	const content = await readIfExists(p);
	if (content == null) return { path: p, state: "missing" };
	if (content.includes(POINTER_MARK)) {
		const expected = pointerContent(target, scope, expectedCtx());
		return {
			path: p,
			state: content.trim() === expected.trim() ? "pointer" : "pointer-stale",
		};
	}
	return { path: p, state: "native" };
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
 * Write a pointer stub for a target/scope. If the file has native (non-pointer)
 * content, refuse unless `force` — caller should `pull` it into the master first.
 */
export async function linkTarget(
	target,
	scope,
	{ masterAbs, masterTilde, force = false },
) {
	const p = targetPath(target, scope);
	if (!p) return { target, scope, path: null, skipped: "unsupported" };
	const existing = await readIfExists(p);
	if (existing && !existing.includes(POINTER_MARK) && !force) {
		return { target, scope, path: p, blocked: "native-content", hint: "pull" };
	}
	const desired = pointerContent(target, scope, { masterAbs, masterTilde });
	if (existing && existing.trim() === desired.trim()) {
		return { target, scope, path: p, ok: true, unchanged: true };
	}
	await writeFile(p, desired);
	return { target, scope, path: p, linked: true };
}

/** Remove a pointer stub (only deletes files that ARE pointers). */
export async function unlinkTarget(target, scope) {
	const p = targetPath(target, scope);
	if (!p) return { target, scope, skipped: "unsupported" };
	const existing = await readIfExists(p);
	if (existing == null) return { target, scope, path: p, missing: true };
	if (!existing.includes(POINTER_MARK)) {
		return { target, scope, path: p, skipped: "native-content" };
	}
	const { rm } = await import("node:fs/promises");
	await rm(p);
	return { target, scope, path: p, unlinked: true };
}

export function scopesForTarget(target) {
	return scopesFor(target);
}

export function prettyPath(p) {
	return pretty(p);
}
