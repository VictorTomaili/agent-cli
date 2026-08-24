// src/targets/index.js — central loader for the per-target registry.
//
// Recipe for adding a NEW target:
//
//   1. Drop a new file under `src/targets/<id>.js` exporting a default object
//      with the documented fields (id, name, docs, global, project, detect,
//      hooks?, share?, transform?, note?, legacyProject?).
//   2. Add ONE import line below — `import <id> from "./<id>.js";`.
//   3. Add the id to the TARGETS array below.
//
// That's it. Everything downstream — detection, hooks installation, share
// links, schema validation, manifest — re-uses the same shape, so new
// targets pick up every feature automatically.
//
// Why static imports instead of fs.readdirSync + dynamic import()? Three
// reasons:
//   - Static analysis: bundlers, linters, and `npm run check` all see the
//     files without any extra plugin.
//   - Predictable load order: TARGETS is the source of truth, not the
//     directory listing.
//   - Synchronous module loading keeps the existing public API
//     (TARGETS, getTarget, etc.) — no async reshape required.
//
// The per-target files are also valid imports in isolation: importing a
// single target by path yields its descriptor object plus any helpers
// (e.g. `cursorTransform`) — useful for tests.

import claude from "./claude.js";
import codex from "./codex.js";
import pi from "./pi.js";
import gemini from "./gemini.js";
import qwen from "./qwen.js";
import cursor from "./cursor.js";
import windsurf from "./windsurf.js";
import cline from "./cline.js";
import copilot from "./copilot.js";
import aider from "./aider.js";
import junie from "./junie.js";
import trae from "./trae.js";
import zed from "./zed.js";
import warp from "./warp.js";
import opencode from "./opencode.js";
import goose from "./goose.js";
import deepseek from "./deepseek.js";

// The canonical, ordered registry. Order matters: it's what `agent-cli
// targets --json` reports, what the LLM manifest inherits, and what
// `agent-cli init` walks in. Add new entries at the END so the existing
// indices stay stable across versions.
export const TARGETS = [
	claude,
	codex,
	pi,
	gemini,
	qwen,
	cursor,
	windsurf,
	cline,
	copilot,
	aider,
	junie,
	trae,
	zed,
	warp,
	opencode,
	goose,
	deepseek,
];

/** Quick id -> target lookup. */
export const TARGET_MAP = Object.fromEntries(TARGETS.map((t) => [t.id, t]));

export function getTarget(id) {
	return TARGET_MAP[id] ?? null;
}

export function knownIds() {
	return TARGETS.map((t) => t.id);
}

/** Native path for a target in a given scope, or null if unsupported. */
export function pathFor(target, scope) {
	if (scope === "global") return target.global ?? null;
	if (scope === "project") return target.project ?? null;
	return null;
}

/** Targets that support a given scope. */
export function targetsWithScope(scope) {
	return TARGETS.filter((t) => pathFor(t, scope));
}

/** All scopes a target supports. */
export function scopesFor(target) {
	const scopes = [];
	if (target.global) scopes.push("global");
	if (target.project) scopes.push("project");
	return scopes;
}

/** Targets that declare a native startup hook we can install. */
export function targetsWithHooks() {
	return TARGETS.filter((t) => t.hooks && t.hooks.event && t.hooks.configFile);
}

/**
 * Adapt master content to a target's native format (e.g. Cursor frontmatter).
 * ctx = { scope }.
 */
export function adaptContent(target, content, ctx) {
	if (typeof target.transform === "function") {
		return target.transform(content, ctx);
	}
	return content;
}

// Re-export the cursor transform for tests / external use. Other per-target
// helpers can be added similarly when needed.
export { cursorTransform } from "./cursor.js";