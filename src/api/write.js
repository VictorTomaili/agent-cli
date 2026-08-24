// src/api/write.js — write SDK for the v0.8.1 MCP write tools (Phase 6.2).
//
// Every function here returns the SAME envelope shape `docs/contract.md`
// defines for the CLI `--json` output — constructed via ok() / err() from
// ./envelope.js. The MCP layer (src/serve.js, wired in T6.2.5) wraps the
// returned envelope in the MCP wire shape `{ content: [{ type: "text", text:
// JSON.stringify(envelope) }], isError: !envelope.ok }`.
//
// Phase 6.2 split (MASTER-PLAN §1 decision 1):
//   - src/api/index.js  — read-only SDK (the "old half"; docstring preserved).
//   - src/api/write.js  — write SDK (this file). Re-exported from
//                         src/api/index.js so a single
//                         `import * as sdk from "./api/index.js"` in
//                         src/serve.js sees both halves — no consumer change.
//   - src/api/envelope.js — shared envelope constructor.
//
// Cross-cutting invariants honored by every write function below
// (see ARCHITECTURE.md + MASTER-PLAN §2.2 #5):
//   1. Scope matrix (USER-DECISIONS.md Item 1, A17): IDENTITY / USER /
//      MODELS accept `scope: "global"` only; SOUL / LESSONS / ENVIRONMENTS
//      accept `scope: "global"` (default) or `scope: "project"` (resolves to
//      <cwd at serve launch>/.agents/<kind>.md). Invalid `{kind, scope}`
//      combinations reject with `err(..., { code: "SCOPE_INVALID" })`
//      BEFORE any library call.
//   2. Invalid kind rejects with `err(..., { code: "INVALID_KIND" })` BEFORE
//      any library call (A17 + master-plan decision 7).
//   3. Mutations wrap in `withOperationLock(name, fn, { timeoutMs: 5000 })`
//      so the conflict matrix in src/operation-lock.js serializes compound
//      mutations (master-plan §2.2 #5 + USER-DECISIONS Item 7).
//   4. File writes use `util.writeFile` (atomic-rename), never raw
//      `fs.writeFileSync`. Config reads/writes go through `config.js`'s
//      locked helpers (atomicEnable*/atomicDisable*, withConfigLock).
//   5. The cwd argument is captured at MODULE LOAD time — the server's launch
//      cwd is the trust boundary (A17 + master-plan §10.1 Item 1). Callers
//      cannot smuggle in a host-controlled path; the `cwd` arg is ignored for
//      scope resolution and only retained for diagnostic echoing.
//   6. `applyChanges` is opt-in for destructive tools: `link` defaults
//      `applyChanges: true` (immediate; CLI parity), `memory_upgrade_apply`
//      defaults `applyChanges: false` (preview). Truthy strings fail closed
//      (master-plan §1 decision 4 — sec A11-w).
//   7. No stack traces, no absolute paths, no raw fs errors in error envelopes
//      (A12 + A15). The lib throws structured errors with `.code`; we map
//      known codes (ESCAPE, OPERATION_BUSY, BACKUP_FAILED) into the envelope's
//      `code` field.

import path from "node:path";
import { ok, err } from "./envelope.js";
import { writeFile, HOME } from "../util.js";
import { withOperationLock } from "../operation-lock.js";
import { identityFilePath } from "../agents-lib.js";
import {
	atomicEnableGlobal,
	atomicDisableGlobal,
	atomicEnableProjectTarget,
	atomicDisableProjectTarget,
} from "../config.js";
import { getTarget, pathFor } from "../targets.js";
import { linkTarget, unlinkTarget } from "../pointer.js";
import {
	addInboxCapture,
} from "../lessons-lib.js";
import {
	prepareMigration,
	markApplied,
} from "../memory-upgrade.js";
import { snapshot } from "../snapshot.js";
import { consolidate } from "../consolidate.js";

// Server-launch cwd is the trust boundary (A17). Captured at module load so
// callers cannot smuggle in a project root via the `cwd` argument; the arg
// is still accepted (callers don't have to special-case us) but only the
// launch-time cwd is consulted for path resolution.
const LAUNCH_CWD = process.cwd();

/**
 * Strict-boolean check for `applyChanges`. Truthy strings, omitted fields, or
 * unrelated values all fail closed — only literal `true` activates the path.
 * Returns the explicit boolean. (Master-plan §1 decision 4 + sec A11-w.)
 */
function isApplyChangesTrue(v) {
	return v === true;
}

// --- 1. brainWrite --------------------------------------------------------
//
// Write `content` to the brain file for `kind` under the requested scope.
//
//   kind ∈ { SOUL, IDENTITY, USER, LESSONS, ENVIRONMENTS, MODELS }
//     - SOUL / LESSONS / ENVIRONMENTS accept project scope (project override).
//     - IDENTITY / USER / MODELS are global-only; project scope rejected.
//
// `applyChanges: true` (default) writes to disk. `false` is a preview that
// returns the dry-run shape WITHOUT touching the filesystem (master-plan §1
// decision 4). For brain writes, the default is `true` because the CLI
// `identity/soul/user set` commands are immediate.

const ALLOWED_KINDS = Object.freeze([
	"SOUL",
	"IDENTITY",
	"USER",
	"LESSONS",
	"ENVIRONMENTS",
	"MODELS",
]);
const PROJECT_OVERRIDABLE_KINDS = Object.freeze([
	"SOUL",
	"LESSONS",
	"ENVIRONMENTS",
]);

export async function brainWrite({
	kind,
	content,
	scope = "global",
	applyChanges = true,
	cwd = LAUNCH_CWD,
} = {}) {
	if (typeof kind !== "string" || !ALLOWED_KINDS.includes(kind)) {
		return err(
			"brain_write",
			`kind ${JSON.stringify(kind)} not allowed; expected one of ${ALLOWED_KINDS.join(", ")}`,
			{ code: "INVALID_KIND" },
		);
	}
	if (scope !== "global" && scope !== "project") {
		return err(
			"brain_write",
			`scope ${JSON.stringify(scope)} not allowed; expected "global" or "project"`,
			{ code: "SCOPE_INVALID" },
		);
	}
	if (scope === "project" && !PROJECT_OVERRIDABLE_KINDS.includes(kind)) {
		return err(
			"brain_write",
			`kind ${kind} does not support project scope (only ${PROJECT_OVERRIDABLE_KINDS.join(", ")} do)`,
			{ code: "SCOPE_INVALID" },
		);
	}
	if (typeof content !== "string") {
		return err(
			"brain_write",
			"content must be a string",
			{ code: "INVALID_ARGUMENT" },
		);
	}
	const targetPath = identityFilePath(kind, scope, cwd);
	if (!targetPath) {
		return err(
			"brain_write",
			`could not resolve path for kind ${kind} (${scope})`,
			{ code: "SCOPE_INVALID" },
		);
	}

	if (!isApplyChangesTrue(applyChanges)) {
		// Preview path: report the would-be write without touching disk.
		return ok("brain_write", {
			dryRun: true,
			kind,
			scope,
			path: targetPath,
			bytes: content.length,
		});
	}

	return withOperationLock(
		"brain_write",
		async () => {
			await writeFile(targetPath, content);
			return ok("brain_write", {
				kind,
				scope,
				path: targetPath,
				bytes: content.length,
				written: true,
			});
		},
		{ kind, timeoutMs: 5000 },
	);
}

// --- 2. lessonCapture ------------------------------------------------------
//
// Append a raw capture to BOTH the project inbox AND the global inbox. Scope
// is intentionally NOT a matrix — a lesson capture mirrors the lessons lib's
// `addInboxCapture` behavior (per T6.2.2 explicit instruction in the spec).

export async function lessonCapture({
	topic,
	body = null,
	cwd = LAUNCH_CWD,
} = {}) {
	if (typeof topic !== "string" || !topic.trim()) {
		return err(
			"lesson_capture",
			"topic is required (non-empty string)",
			{ code: "INVALID_ARGUMENT" },
		);
	}
	return withOperationLock(
		"lesson_capture",
		async () => {
			const results = [];
			for (const scope of ["project", "global"]) {
				const r = await addInboxCapture(topic, {
					body,
					scope,
					cwd,
				});
				results.push({ scope, file: r.file, ok: r.ok });
			}
			return ok("lesson_capture", {
				topic,
				captured: results,
			});
		},
		{ timeoutMs: 5000 },
	);
}

// --- 3. targetEnable -------------------------------------------------------
//
// Enable a target — writes the pointer stub AND updates config.json via the
// atomic CAS helpers. `applyChanges` is not consulted here: `target enable`
// is always-immediate (CLI parity).

export async function targetEnable({
	id,
	scope = "global",
	cwd = LAUNCH_CWD,
} = {}) {
	if (typeof id !== "string" || !id.trim()) {
		return err(
			"target_enable",
			"id is required",
			{ code: "INVALID_ARGUMENT" },
		);
	}
	if (scope !== "global" && scope !== "project") {
		return err(
			"target_enable",
			`scope ${JSON.stringify(scope)} not allowed`,
			{ code: "SCOPE_INVALID" },
		);
	}
	const t = getTarget(id);
	if (!t) {
		return err(
			"target_enable",
			`unknown target: ${id}`,
			{ code: "INVALID_KIND" },
		);
	}
	if (!pathFor(t, scope)) {
		return err(
			"target_enable",
			`target ${id} does not support ${scope} scope`,
			{ code: "SCOPE_INVALID" },
		);
	}

	return withOperationLock(
		"target_enable",
		async () => {
			const masterAbs = path.join(HOME, ".agents", "AGENTS.md");
			const masterTilde = "~/.agents/AGENTS.md";
			const link = await linkTarget(t, scope, { masterAbs, masterTilde });
			if (link.blocked === "native-content" || link.skipped) {
				return err(
					"target_enable",
					`cannot enable ${id} (${scope}): ${link.blocked ?? link.skipped}`,
					{ code: "BLOCKED" },
				);
			}
			const cfg =
				scope === "global"
					? atomicEnableGlobal(id)
					: atomicEnableProjectTarget(cwd, id);
			return ok("target_enable", {
				id,
				scope,
				linked: link,
				config: {
					global: cfg.global,
					project: cfg.project,
					projectTargets: cfg.projectTargets,
				},
			});
		},
		{ timeoutMs: 5000 },
	);
}

// --- 4. targetDisable ------------------------------------------------------

export async function targetDisable({
	id,
	scope = "global",
	cwd = LAUNCH_CWD,
} = {}) {
	if (typeof id !== "string" || !id.trim()) {
		return err(
			"target_disable",
			"id is required",
			{ code: "INVALID_ARGUMENT" },
		);
	}
	if (scope !== "global" && scope !== "project") {
		return err(
			"target_disable",
			`scope ${JSON.stringify(scope)} not allowed`,
			{ code: "SCOPE_INVALID" },
		);
	}
	const t = getTarget(id);
	if (!t) {
		return err(
			"target_disable",
			`unknown target: ${id}`,
			{ code: "INVALID_KIND" },
		);
	}
	if (!pathFor(t, scope)) {
		return err(
			"target_disable",
			`target ${id} does not support ${scope} scope`,
			{ code: "SCOPE_INVALID" },
		);
	}

	return withOperationLock(
		"target_disable",
		async () => {
			const unlink = await unlinkTarget(t, scope, { preserve: false });
			if (unlink.skipped === "native-content" || unlink.blocked) {
				return err(
					"target_disable",
					`cannot disable ${id} (${scope}): ${unlink.skipped ?? unlink.blocked}`,
					{ code: "BLOCKED" },
				);
			}
			const cfg =
				scope === "global"
					? atomicDisableGlobal(id)
					: atomicDisableProjectTarget(cwd, id);
			return ok("target_disable", {
				id,
				scope,
				unlinked: unlink,
				config: {
					global: cfg.global,
					project: cfg.project,
					projectTargets: cfg.projectTargets,
				},
			});
		},
		{ timeoutMs: 5000 },
	);
}

// --- 5. link ---------------------------------------------------------------
//
// Write a pointer stub for a target. When the on-disk file holds native
// (non-pointer) content, `linkTarget` refuses unless `force` is set; with
// `force`, the existing native file is FIRST copied to a timestamped
// `.agent-cli-backup-<iso>` sibling (src/pointer.js#backupPath) before the
// stub replaces it (A10 — backup-first destructive ops).
//
// `applyChanges` defaults `true` because the CLI `link` command is
// immediate. The pointer.js lib already gates `force` on user intent;
// `applyChanges` adds the MCP-side protocol gate (master-plan §1 decision
// 4 + meeting A7 refinement).

export async function link({
	id,
	scope = "global",
	force = false,
	applyChanges = true,
	cwd = LAUNCH_CWD,
} = {}) {
	if (typeof id !== "string" || !id.trim()) {
		return err("link", "id is required", { code: "INVALID_ARGUMENT" });
	}
	if (scope !== "global" && scope !== "project") {
		return err(
			"link",
			`scope ${JSON.stringify(scope)} not allowed`,
			{ code: "SCOPE_INVALID" },
		);
	}
	const t = getTarget(id);
	if (!t) {
		return err("link", `unknown target: ${id}`, { code: "INVALID_KIND" });
	}
	if (!pathFor(t, scope)) {
		return err(
			"link",
			`target ${id} does not support ${scope} scope`,
			{ code: "SCOPE_INVALID" },
		);
	}
	if (!isApplyChangesTrue(applyChanges)) {
		return ok("link", {
			dryRun: true,
			id,
			scope,
			force: !!force,
			wouldWrite: true,
		});
	}

	return withOperationLock(
		"link",
		async () => {
			const masterAbs = path.join(HOME, ".agents", "AGENTS.md");
			const masterTilde = "~/.agents/AGENTS.md";
			const r = await linkTarget(t, scope, {
				masterAbs,
				masterTilde,
				force: !!force,
			});
			if (r.blocked === "native-content") {
				return err(
					"link",
					`native content at ${r.path ?? "target"}; pass force: true to back up and overwrite`,
					{ code: "BLOCKED" },
				);
			}
			return ok("link", { id, scope, result: r });
		},
		{ timeoutMs: 5000 },
	);
}

// --- 6. unlink -------------------------------------------------------------
//
// Pointer-only deletion (A9): refuse native content even with `force`; never
// delete a symlink (the lib refuses too, but we surface a clean error).

export async function unlink({
	id,
	scope = "global",
	preserve = false,
	cwd = LAUNCH_CWD,
} = {}) {
	if (typeof id !== "string" || !id.trim()) {
		return err("unlink", "id is required", { code: "INVALID_ARGUMENT" });
	}
	if (scope !== "global" && scope !== "project") {
		return err(
			"unlink",
			`scope ${JSON.stringify(scope)} not allowed`,
			{ code: "SCOPE_INVALID" },
		);
	}
	const t = getTarget(id);
	if (!t) {
		return err("unlink", `unknown target: ${id}`, { code: "INVALID_KIND" });
	}
	if (!pathFor(t, scope)) {
		return err(
			"unlink",
			`target ${id} does not support ${scope} scope`,
			{ code: "SCOPE_INVALID" },
		);
	}
	return withOperationLock(
		"unlink",
		async () => {
			const r = await unlinkTarget(t, scope, { preserve: !!preserve });
			if (r.skipped === "native-content" || r.blocked === "native-content") {
				return err(
					"unlink",
					`refusing to remove native content at ${r.path ?? "target"}`,
					{ code: "BLOCKED" },
				);
			}
			return ok("unlink", { id, scope, result: r });
		},
		{ timeoutMs: 5000 },
	);
}

// --- 7. memoryUpgradePrepare -----------------------------------------------
//
// Atomic backup of the target file (kind-matched). The lib
// (`prepareMigration`) does the actual `.upgrade-backups/<ts>-<id>/<file>`
// write via `util.writeFile` (atomic-rename).

export async function memoryUpgradePrepare({
	id,
	scope = "global",
	cwd = LAUNCH_CWD,
} = {}) {
	if (typeof id !== "string" || !id.trim()) {
		return err(
			"memory_upgrade_prepare",
			"id is required",
			{ code: "INVALID_ARGUMENT" },
		);
	}
	if (scope !== "global" && scope !== "project") {
		return err(
			"memory_upgrade_prepare",
			`scope ${JSON.stringify(scope)} not allowed`,
			{ code: "SCOPE_INVALID" },
		);
	}
	const r = await prepareMigration(id, { scope, cwd });
	if (!r.ok) {
		return err("memory_upgrade_prepare", r.reason, {
			code: r.noop ? "NOOP" : "PREPARE_FAILED",
		});
	}
	return ok("memory_upgrade_prepare", {
		id,
		scope,
		backup: r.backup,
		currentVersion: r.currentVersion,
		migration: {
			id: r.migration.id,
			title: r.migration.title,
			summary: r.migration.summary,
			kind: r.migration.kind,
			fields: r.migration.fields,
			steps: r.migration.steps,
			verify: r.migration.verify,
			notes: r.migration.notes || null,
		},
	});
}

// --- 8. memoryUpgradeApply --------------------------------------------------
//
// Bump the schema version marker. Defaults `applyChanges: false` (preview)
// because bumping the version IS destructive — it changes the system's
// record of what's been applied. `applyChanges: true` activates the write
// path. Per master-plan §1 decision 4: truthy strings, omitted fields, or
// unrelated arguments must NOT authorize the change.

export async function memoryUpgradeApply({
	id,
	scope = "global",
	applyChanges = false,
	cwd = LAUNCH_CWD,
} = {}) {
	if (typeof id !== "string" || !id.trim()) {
		return err(
			"memory_upgrade_apply",
			"id is required",
			{ code: "INVALID_ARGUMENT" },
		);
	}
	if (scope !== "global" && scope !== "project") {
		return err(
			"memory_upgrade_apply",
			`scope ${JSON.stringify(scope)} not allowed`,
			{ code: "SCOPE_INVALID" },
		);
	}
	if (!isApplyChangesTrue(applyChanges)) {
		return ok("memory_upgrade_apply", {
			dryRun: true,
			id,
			scope,
			reason: "applyChanges must be exactly true (preview by default)",
		});
	}
	const r = await markApplied(id, { scope, cwd });
	if (!r.ok) {
		return err("memory_upgrade_apply", r.reason, {
			code: r.noop ? "NOOP" : "APPLY_FAILED",
		});
	}
	return ok("memory_upgrade_apply", {
		id,
		scope,
		version: r.version,
		previousVersion: r.previousVersion,
	});
}

// ---------------------------------------------------------------------------
// Conditional tools (T6.2.2 conditional rules):
//   - snapshot_now       → ships because src/snapshot.js was refactored under
//                          withOperationLock + symlink-safe traversal +
//                          secret exclusion (T6.2.4a, commit cff9869).
//   - lesson_consolidate → ships because src/consolidate.js was refactored
//                          under util.writeFileSync + sanitized errors +
//                          shared lock (T6.2.4b, commit f1bb25f).
//   - restore            → deferred to v0.8.2 (master-plan §10.3 C1).
//
// Both conditional tools are exported below; T6.2.5's WRITE_TOOLS set
// (src/serve/registry.js, updated in this commit) names all 10 tools.

export async function snapshotNowWrite({
	applyChanges = true,
} = {}) {
	if (!isApplyChangesTrue(applyChanges)) {
		return ok("snapshot_now", { dryRun: true });
	}
	const r = await snapshot();
	return ok("snapshot_now", r);
}

/**
 * `lesson_consolidate` — promote recurring lessons to the core, prune
 * single-occurrence-unrepeated (after a grace pass). Defaults
 * `applyChanges: false` (preview per master-plan §1 decision 4 — the
 * "doctor-style" MCP repair pattern). `surface: "mcp"` is passed to
 * `consolidate()` so the lib sanitizes errors per A15 (no stack, no
 * absolute paths).
 */
export async function lessonConsolidate({
	scope = "global",
	applyChanges = false,
	cwd = LAUNCH_CWD,
	promoteThreshold,
} = {}) {
	if (scope !== "global" && scope !== "project") {
		return err(
			"lesson_consolidate",
			`scope ${JSON.stringify(scope)} not allowed`,
			{ code: "SCOPE_INVALID" },
		);
	}
	const dryRun = !isApplyChangesTrue(applyChanges);
	const r = await consolidate({
		scope,
		cwd,
		dryRun,
		promoteThreshold,
		surface: "mcp",
	});
	if (!r.ok) {
		return err("lesson_consolidate", r.reason, { code: r.code || "CONSOLIDATE_FAILED" });
	}
	return ok("lesson_consolidate", r);
}

// Re-export for the registry so the conditional tools stay grouped.
export { LAUNCH_CWD };