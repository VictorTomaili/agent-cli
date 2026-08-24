// src/api/write.js — write SDK for the v0.8.1 MCP write tools (Phase 6.2).
//
// Every function here returns the SAME envelope shape `docs/contract.md`
// defines for the CLI `--json` output — constructed via ok() / err() from
// ./envelope.js. The MCP layer (src/serve.js, wired in T6.2.5) wraps the
// returned envelope in the MCP wire shape.
//
// Phase 6.2 split:
//   - src/api/index.js  — read-only SDK (the "old half", docstring preserved).
//   - src/api/write.js  — write SDK (this file). Re-exported from
//                         src/api/index.js so a single
//                         `import * as sdk from "./api/index.js"`
//                         in src/serve.js sees both halves.
//   - src/api/envelope.js — shared envelope constructor.
//
// Per MASTER-PLAN §1 decision 1 (sdk split) and §3.5 (T6.2.1).
//
// This file exports 8 placeholder functions today; T6.2.2 fills them in with
// real bodies. The placeholder bodies are intentionally inert — they return
// the envelope shape with `{ implemented: false }` so the wire surface is
// stable across the skeleton → filled-in transition.
//
// Two conditionally-shipped tools (`snapshot_now` after T6.2.4a,
// `lesson_consolidate` after T6.2.4b) are deliberately excluded from this
// skeleton: the registry's WRITE_TOOLS set in src/serve/registry.js still
// names only the 8 core tools. T6.2.2 adds the conditional tools and updates
// WRITE_TOOLS in the same commit when the B1 / B2 refactors land.

import { ok } from "./envelope.js";

/** PLACEHOLDER — T6.2.2 fills in with the real scope-matrix-aware body. */
export async function brainWrite({
	kind,
	content,
	scope = "global",
	applyChanges = true,
	cwd = process.cwd(),
} = {}) {
	return ok("brain_write", { implemented: false, kind, scope });
}

/** PLACEHOLDER — T6.2.2 fills in with addInboxCapture for both project + global. */
export async function lessonCapture({
	topic,
	body,
	cwd = process.cwd(),
} = {}) {
	return ok("lesson_capture", { implemented: false, topic });
}

/** PLACEHOLDER — T6.2.2 fills in with atomicEnableGlobal/atomicEnableProjectTarget. */
export async function targetEnable({
	id,
	scope = "global",
	cwd = process.cwd(),
} = {}) {
	return ok("target_enable", { implemented: false, id, scope });
}

/** PLACEHOLDER — T6.2.2 fills in with atomicDisableGlobal/atomicDisableProjectTarget. */
export async function targetDisable({
	id,
	scope = "global",
	cwd = process.cwd(),
} = {}) {
	return ok("target_disable", { implemented: false, id, scope });
}

/** PLACEHOLDER — T6.2.2 fills in with linkTarget (pointer stub write + config CAS). */
export async function link({
	id,
	scope = "global",
	force = false,
	applyChanges = true,
	cwd = process.cwd(),
} = {}) {
	return ok("link", { implemented: false, id, scope, force, applyChanges });
}

/** PLACEHOLDER — T6.2.2 fills in with unlinkTarget (pointer-only deletion, A9). */
export async function unlink({
	id,
	scope = "global",
	preserve = false,
	cwd = process.cwd(),
} = {}) {
	return ok("unlink", { implemented: false, id, scope, preserve });
}

/** PLACEHOLDER — T6.2.2 fills in with prepareMigration (atomic backup, scope matrix). */
export async function memoryUpgradePrepare({
	id,
	scope = "global",
	cwd = process.cwd(),
} = {}) {
	return ok("memory_upgrade_prepare", { implemented: false, id, scope });
}

/** PLACEHOLDER — T6.2.2 fills in with markApplied; requires applyChanges:true (default false). */
export async function memoryUpgradeApply({
	id,
	scope = "global",
	applyChanges = false,
	cwd = process.cwd(),
} = {}) {
	return ok("memory_upgrade_apply", {
		implemented: false,
		id,
		scope,
		applyChanges,
	});
}