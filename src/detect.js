// src/detect.js — best-effort detection of which coding agents are installed (~).

import { TARGETS, pathFor } from "./targets.js";
import { homeExists } from "./util.js";

/** Target ids whose home marker exists. */
export async function detectInstalled() {
	const installed = [];
	for (const t of TARGETS) {
		if (!t.detect) continue;
		if (await homeExists(t.detect)) installed.push(t.id);
	}
	return installed;
}

/** Targets installed AND supporting a scope. */
export async function detectForScope(scope) {
	const set = new Set(await detectInstalled());
	return TARGETS.filter((t) => set.has(t.id) && pathFor(t, scope));
}
