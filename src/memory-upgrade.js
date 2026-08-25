// src/memory-upgrade.js — guided, LLM-friendly brain-schema migrations.
//
// Purpose: when agent-cli ships a new field/schema/structure for the identity &
// memory files (IDENTITY.md, SOUL.md, USER.md, ENVIRONMENTS.md, MODELS.md,
// LESSONS.md), existing users may have older-shaped files. Rather than silently
// rewrite the user's prose (which is hostile to their edits), this module gives
// the agent driving the session a STRUCTURED PLAN it can walk through:
//
//   1. `planUpgrade({ scope, cwd })`   → emits the JSON plan listing each
//      applicable migration (id, target file, fields to add/rename, instructions
//      for the agent, backup path).
//   2. `prepareMigration(id, ...)`     → backs up the target file once, returns
//      the migration spec the LLM will execute. The LLM does the actual
//      `identity/soul/user/env set` calls because the agent has the context to
//      decide whether to migrate, preserve prose, or ask the user.
//   3. `brainSchemaVersion(scope, cwd)` → reads/writes a tiny version marker
//      (`<brainDir>/.schema-version`) so subsequent `planUpgrade` calls are
//      idempotent and don't re-list migrations that have already been applied.
//
// Design rationale: the agent (Claude, Codex, DSH, …) is the one running this
// CLI. It already has the user's context (the prose it's being asked to migrate)
// and the conversational channel to ask clarifying questions. Putting the agent
// in the loop is therefore better than silent bulk regex rewriting — and it
// matches the established pattern in src/actions.js where each suggested action
// has a runnable `command` + `args` the agent can execute and verify.
//
// Filesystem invariants preserved:
//   - Atomic writes via util.writeFile (excl-create + fsync + rename).
//   - Backups land under ~/.agents/.upgrade-backups/<ts>-<kind>/ (path-contained).
//   - Never touches secrets, never touches staged updates, never syncs.

import fs from "node:fs/promises";
import path from "node:path";
import { identityFilePath, identityBase } from "./agents-lib.js";
import { exists, readFile, writeFile, ensureDir } from "./util.js";

/** Bump this when a new migration is added. Existing migrations are never
 *  removed or rewritten — the catalog is append-only so once a user has
 *  applied a migration it stays applied across versions. */
export const LATEST_BRAIN_SCHEMA = 2;

/** Read the persisted schema version for a scope. Returns 0 if the marker is
 *  missing (treated as "pre-versioning" — all migrations applicable). */
export async function brainSchemaVersion(scope = "global", cwd = process.cwd()) {
	const marker = path.join(identityBase(scope, cwd), ".schema-version");
	if (!(await exists(marker))) return 0;
	try {
		const raw = (await readFile(marker)).trim();
		const n = parseInt(raw, 10);
		return Number.isFinite(n) && n >= 0 ? n : 0;
	}
	catch {
		return 0;
	}
}

/** Persist the schema version for a scope. Idempotent. */
export async function setBrainSchemaVersion(version, scope = "global", cwd = process.cwd()) {
	if (!Number.isFinite(version) || version < 0) return;
	const marker = path.join(identityBase(scope, cwd), ".schema-version");
	await ensureDir(path.dirname(marker));
	await writeFile(marker, String(version) + "\n");
}

/**
 * Catalog of migrations. Append-only. Each migration declares:
 *   id          stable id (cli-facing, never renamed)
 *   since       the schema version a brain must be AT or BELOW to need it
 *   until      the schema version this migration brings the brain TO
 *   scope      "global" | "project" | "any"
 *   kind       the IDENTITY_FILES kind the migration touches (or "*" for none)
 *   title       short human label
 *   summary     one-paragraph "what this does" for the LLM
 *   fields      [] of FIELD_TAGS tag names this migration introduces (if any)
 *   steps[]    ordered, copy-pasteable steps for the LLM to run
 *   verify      string the LLM can `echo` to confirm completion
 *   notes       optional caveats (e.g. "preserves existing prose when <TAG> is absent")
 */
export const MIGRATIONS = [
	{
		id: "introduce-identity-tags",
		since: 0,
		until: 1,
		scope: "any",
		kind: "identity",
		title: "Introduce <AGENT_NAME/ROLE/MISSION/PERSONA> tags in IDENTITY.md",
		summary:
			"Earlier IDENTITY.md was prose-only. v1 introduces explicit <AGENT_NAME>, " +
			"<AGENT_ROLE>, <AGENT_MISSION>, and <AGENT_PERSONA> tags so the CLI can detect " +
			"gaps precisely (an empty tag = a gap, no prose-length guessing).",
		fields: ["AGENT_NAME", "AGENT_ROLE", "AGENT_MISSION", "AGENT_PERSONA"],
		steps: [
			"Read the current IDENTITY.md content.",
			"For each of AGENT_NAME, AGENT_ROLE, AGENT_MISSION, AGENT_PERSONA: extract " +
				"the value from the existing prose section (or ask the user), then run " +
				"`agent-cli identity set <field> \"<value>\"` — this appends a single " +
				"<TAG>value</TAG> tag without disturbing the surrounding prose.",
			"If any value cannot be inferred from existing prose, ASK the user before " +
				"guessing. Never invent a name/role/mission/persona the user did not provide.",
		],
		verify:
			"`agent-cli files --json | jq '.files[] | select(.kind==\"identity\") | .gaps'` should be `[]` (no empty tags).",
		notes:
			"This migration is safe to skip if the user prefers prose; the agent will " +
			"keep working with the prose heuristic. Apply only when the user wants " +
			"structured detection of identity gaps.",
	},
	{
		id: "introduce-soul-tags",
		since: 1,
		until: 2,
		scope: "any",
		kind: "soul",
		title: "Introduce <SOUL_*> tags in SOUL.md",
		summary:
			"v2 extends the structured-tag pattern from IDENTITY.md to SOUL.md. " +
			"<SOUL_PERSONALITY>, <SOUL_VALUES>, <SOUL_BELIEFS>, <SOUL_MOTIVATIONS> " +
			"replace prose-length gap detection with explicit tag presence.",
		fields: [
			"SOUL_PERSONALITY",
			"SOUL_VALUES",
			"SOUL_BELIEFS",
			"SOUL_MOTIVATIONS",
		],
		steps: [
			"Read SOUL.md.",
			"For each SOUL_* tag: extract from the existing prose section or ask " +
				"the user; run `agent-cli soul set <field> \"<value>\"`.",
			"Confirm with `agent-cli files --json` — .gaps for kind=soul must be `[]`.",
		],
		verify:
			"`agent-cli files --json | jq '.files[] | select(.kind==\"soul\") | .gaps'` should be `[]`.",
		notes:
			"Like identity, this is opt-in: keep the user's prose if they prefer it; " +
			"the structured tags only matter if they want gap detection in brief/doctor.",
	},
	{
		id: "introduce-user-tags",
		since: 1,
		until: 2,
		scope: "any",
		kind: "user",
		title: "Introduce <USER_*> tags in USER.md",
		summary:
			"v2 introduces <USER_PREFS>, <USER_GOALS>, <USER_CONTEXT> in USER.md so " +
			"preference gaps are detectable the same way as identity/soul.",
		fields: ["USER_PREFS", "USER_GOALS", "USER_CONTEXT"],
		steps: [
			"Read USER.md.",
			"For each USER_* tag: extract from existing prose or ask the user; " +
				"run `agent-cli user set <field> \"<value>\"`.",
			"Confirm with `agent-cli files --json` — .gaps for kind=user must be `[]`.",
		],
		verify:
			"`agent-cli files --json | jq '.files[] | select(.kind==\"user\") | .gaps'` should be `[]`.",
	},
];

/** Resolve the migrations applicable to a brain at `currentVersion`.
 *  Pure helper (no I/O), trivially unit-testable. */
export function applicableMigrations(currentVersion, { scope = "any" } = {}) {
	return MIGRATIONS.filter(
		(m) =>
			currentVersion >= m.since &&
			currentVersion < m.until &&
			(scope === "any" || m.scope === "any" || m.scope === scope),
	);
}

/** Compute the planning shape an LLM can act on:
 *  { brainSchemaVersion, latestSchemaVersion, applicable: [...], instructionsForAgent }
 *  Pure helper given (currentVersion, scope) — file I/O happens in planUpgrade().
 */
export function buildPlan(currentVersion, { scope = "any", cwd = process.cwd(), backups = {} } = {}) {
	// The plan's `file` field is the path the LLM should target. When the
	// caller asks for a project-scoped plan, project paths must be reported,
	// not the global ones. `scope` here is "global" | "project" | "any":
	//   - "global" / "project" → use that scope's path verbatim.
	//   - "any"                → prefer project when one exists, else global;
	//                            matches the resolution order the LLM should
	//                            actually follow when it's unsure.
	const fileScope = scope === "any" ? "global" : scope;
	const applicable = applicableMigrations(currentVersion, { scope }).map((m) => ({
		id: m.id,
		title: m.title,
		summary: m.summary,
		scope: m.scope,
		kind: m.kind,
		file: m.kind === "*" ? null : identityFilePath(m.kind, fileScope, cwd),
		fields: m.fields,
		steps: m.steps,
		verify: m.verify,
		notes: m.notes || null,
		backup: backups[m.id] || null,
	}));
	const upToDate = currentVersion >= LATEST_BRAIN_SCHEMA;
	return {
		brainSchemaVersion: currentVersion,
		latestSchemaVersion: LATEST_BRAIN_SCHEMA,
		upToDate,
		scope,
		applicable,
		// Plain-English walkthrough the LLM can paste into its system prompt for the
		// upgrade session — explicit so the LLM does not have to infer the procedure.
		instructionsForAgent: upToDate
			? null
			: [
					"You are upgrading the user's brain files to the latest schema.",
					"For each migration in `applicable` (in declared order):",
					"  1. Read the migration's `steps` and `notes`. The notes tell you when to ask the user vs. preserve their prose.",
					"  2. Confirm the migration with the user before any write (memory files are personal — never clobber without consent).",
					"  3. For each `fields[]` tag, run `agent-cli <kind> set <TAG> \"<value>\"` (kind is identity/soul/user/environments).",
					"  4. Run the migration's `verify` command and confirm the expected output.",
					"  5. After all migrations succeed, run `agent-cli memory upgrade status --json` to confirm the new brainSchemaVersion.",
					"If any migration cannot complete safely, STOP and ask the user how to proceed; never partially apply.",
				].join("\n"),
	};
}

/** High-level plan: read current version, build the JSON plan. Does NOT
 *  back up files — backup happens in prepareMigration() so the user can
 *  selectively skip migrations. */
export async function planUpgrade({ scope = "any", cwd = process.cwd() } = {}) {
	const current = await brainSchemaVersion("global", cwd);
	return buildPlan(current, { scope, cwd });
}

/** Resolve one migration by id. Returns the migration spec the LLM will execute.
 *  Backs up the target file (if any) to `<brainDir>/.upgrade-backups/<ts>-<id>/<file>`
 *  using `util.writeFile` (atomic). Returns null if the migration is not in the
 *  catalog or is not currently applicable (already applied or future-only). */
export async function prepareMigration(id, { scope = "global", cwd = process.cwd(), now = Date.now() } = {}) {
	const m = MIGRATIONS.find((x) => x.id === id);
	if (!m) return { ok: false, reason: `unknown migration: ${id}` };
	const current = await brainSchemaVersion(scope, cwd);
	if (current < m.since || current >= m.until) {
		return {
			ok: false,
			reason:
				current >= m.until
					? `migration already applied (brain is at schema ${current})`
					: `migration not yet applicable (brain is at schema ${current}, needs ≤${m.since})`,
			migration: m,
			currentVersion: current,
		};
	}
	let backup = null;
	if (m.kind !== "*") {
		const fp = identityFilePath(m.kind, scope, cwd);
		if (fp && (await exists(fp))) {
			const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
			const backupsRoot = path.join(identityBase(scope, cwd), ".upgrade-backups");
			const backupDir = path.join(backupsRoot, `${stamp}-${m.id}`);
			await ensureDir(backupDir);
			const backupFile = path.join(backupDir, path.basename(fp));
			const content = await readFile(fp);
			await writeFile(backupFile, content);
			backup = backupFile;
		}
	}
	return { ok: true, migration: m, currentVersion: current, backup };
}

/** Mark a migration as applied by bumping the brain schema version to its
 *  `until`. Refuses to write when the migration's `since` precondition is
 *  unsatisfied (i.e. the user is on an older schema than the migration
 *  expects — they must apply earlier migrations first) OR when the
 *  migration is already past its `until` (no-op). Sharing the precondition
 *  with prepareMigration prevents a misplaced `apply` from silently
 *  skipping every pending migration whose `until` is ≤ this one. */
export async function markApplied(id, { scope = "global", cwd = process.cwd() } = {}) {
	const m = MIGRATIONS.find((x) => x.id === id);
	if (!m) return { ok: false, reason: `unknown migration: ${id}` };
	const current = await brainSchemaVersion(scope, cwd);
	if (current >= m.until) {
		return {
			ok: false,
			noop: true,
			reason: `migration already applied (brain is at schema ${current})`,
			currentVersion: current,
			migration: m,
		};
	}
	if (current < m.since) {
		return {
			ok: false,
			reason:
				`migration not yet applicable (brain is at schema ${current}, ` +
				`needs ≤${m.since}) — apply the earlier migrations first`,
			currentVersion: current,
			migration: m,
		};
	}
	await setBrainSchemaVersion(m.until, scope, cwd);
	return { ok: true, version: m.until, previousVersion: current, migration: m };
}

/** Convenience: status report (current version + pending count + each pending
 *  migration's id). Used by `agent-cli memory upgrade status`. */
export async function upgradeStatus({ scope = "any", cwd = process.cwd() } = {}) {
	const current = await brainSchemaVersion(scope, cwd);
	const plan = buildPlan(current, { scope, cwd });
	return {
		brainSchemaVersion: current,
		latestSchemaVersion: LATEST_BRAIN_SCHEMA,
		upToDate: plan.upToDate,
		pendingCount: plan.applicable.length,
		pending: plan.applicable.map((m) => m.id),
	};
}

/** Hint map for the CLI: which migrations introduce which tags — used by tests
 *  and by `agent-cli files` to report tag coverage. */
export function migrationsForKind(kind) {
	return MIGRATIONS.filter((m) => m.kind === kind);
}

/** Test helper — exposed for the test suite so it can register a synthetic
 *  migration without monkey-patching the module. Only the test suite calls this. */
export function _allMigrationsForTest() {
	return MIGRATIONS.slice();
}

// Avoid an unused-import warning when this module is bundled without the
// unused fs/promises import (some bundlers are strict).
void fs;