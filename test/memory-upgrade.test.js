// Tests for src/memory-upgrade.js — the LLM-friendly brain-schema upgrade flow.
// Verifies the migration catalog, version marker persistence, plan generation,
// prepare (backup) and apply (mark-applied) operations, and the CLI surface
// (`memory upgrade plan|status|prepare|apply`).

import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	writeFileSync,
	mkdirSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";

// Isolate HOME BEFORE importing agent-cli modules so nothing real is touched.
const TMP = mkdtempSync(path.join(tmpdir(), "agent-upgrade-"));
process.env.AGENT_CLI_HOME = TMP;

const lib = await import("../src/memory-upgrade.js");
const { LATEST_BRAIN_SCHEMA, MIGRATIONS } = lib;

// ---------------------------------------------------------------------------
// pure-helper tests (no I/O)
// ---------------------------------------------------------------------------

test("MIGRATIONS catalog is non-empty and stable", () => {
	assert.ok(MIGRATIONS.length >= 2);
	for (const m of MIGRATIONS) {
		assert.ok(m.id && /^[a-z0-9-]+$/.test(m.id), `bad id: ${m.id}`);
		assert.ok(m.title);
		assert.ok(m.summary);
		assert.ok(typeof m.since === "number" && m.since >= 0);
		assert.ok(typeof m.until === "number" && m.until > m.since);
		assert.ok(m.steps && m.steps.length >= 1);
		assert.ok(m.verify);
	}
});

test("migration ids are unique", () => {
	const ids = MIGRATIONS.map((m) => m.id);
	assert.equal(ids.length, new Set(ids).size);
});

test("applicableMigrations respects `since` and `until`", () => {
	// First migration: since=0, until=1 → applicable at version 0 only.
	const first = MIGRATIONS[0];
	const beforeFirst = lib.applicableMigrations(first.since - 1);
	assert.ok(
		!beforeFirst.some((m) => m.id === first.id),
		"migration not yet applicable below its since",
	);
	const atSince = lib.applicableMigrations(first.since);
	assert.ok(
		atSince.some((m) => m.id === first.id),
		"migration applicable at since",
	);
	const atUntil = lib.applicableMigrations(first.until);
	assert.ok(
		!atUntil.some((m) => m.id === first.id),
		"migration not applicable once until is reached",
	);
});

test("buildPlan is pure and returns the right shape", () => {
	const plan = lib.buildPlan(0, { scope: "any", cwd: TMP });
	assert.equal(plan.brainSchemaVersion, 0);
	assert.equal(plan.latestSchemaVersion, LATEST_BRAIN_SCHEMA);
	assert.equal(plan.upToDate, false);
	assert.ok(Array.isArray(plan.applicable) && plan.applicable.length > 0);
	assert.ok(typeof plan.instructionsForAgent === "string");
	assert.ok(plan.instructionsForAgent.includes("For each migration"));
});

test("buildPlan reports upToDate=true when version >= LATEST", () => {
	const plan = lib.buildPlan(LATEST_BRAIN_SCHEMA, {
		scope: "any",
		cwd: TMP,
	});
	assert.equal(plan.upToDate, true);
	assert.equal(plan.applicable.length, 0);
	assert.equal(plan.instructionsForAgent, null);
});

test("buildPlan scopes filter correctly", () => {
	const all = lib.applicableMigrations(0, { scope: "any" });
	const global = lib.applicableMigrations(0, { scope: "global" });
	assert.ok(all.length >= global.length);
});

// ---------------------------------------------------------------------------
// I/O tests — version marker round-trip + prepare/apply + CLI surface
// ---------------------------------------------------------------------------

test("brainSchemaVersion returns 0 when marker is absent", async () => {
	const v = await lib.brainSchemaVersion("global", TMP);
	assert.equal(v, 0);
});

test("setBrainSchemaVersion persists and reads back", async () => {
	await lib.setBrainSchemaVersion(1, "global", TMP);
	const v = await lib.brainSchemaVersion("global", TMP);
	assert.equal(v, 1);
});

test("setBrainSchemaVersion is idempotent (same value twice)", async () => {
	await lib.setBrainSchemaVersion(2, "global", TMP);
	await lib.setBrainSchemaVersion(2, "global", TMP);
	assert.equal(await lib.brainSchemaVersion("global", TMP), 2);
});

test("setBrainSchemaVersion rejects non-numeric input (writes nothing)", async () => {
	await lib.setBrainSchemaVersion(-1, "global", TMP); // negative → ignored
	assert.equal(await lib.brainSchemaVersion("global", TMP), 2); // unchanged
	await lib.setBrainSchemaVersion("not-a-number", "global", TMP);
	assert.equal(await lib.brainSchemaVersion("global", TMP), 2); // unchanged
});

test("prepareMigration backs up the target file", async () => {
	// Reset the schema so the first migration is applicable.
	await lib.setBrainSchemaVersion(0, "global", TMP);
	// Create a fake IDENTITY.md that exists in the brain dir.
	const brain = path.join(TMP, ".agents");
	mkdirSync(brain, { recursive: true });
	const idPath = path.join(brain, "IDENTITY.md");
	writeFileSync(idPath, "## Identity\nSome prose the user wrote.\n");

	const first = MIGRATIONS[0];
	const r = await lib.prepareMigration(first.id, {
		scope: "global",
		cwd: TMP,
	});
	assert.equal(r.ok, true);
	assert.equal(r.migration.id, first.id);
	assert.ok(r.backup, "backup path must be set when target file exists");
	assert.ok(existsSync(r.backup), "backup file exists on disk");
	const backed = readFileSync(r.backup, "utf8");
	assert.ok(backed.includes("## Identity"));
});

test("prepareMigration returns ok with no backup when target is absent", async () => {
	// Soul migration applies at schema 1 (since=1, until=2) — set the marker
	// there so it's applicable, but don't apply it.
	await lib.setBrainSchemaVersion(1, "global", TMP);
	const soul = path.join(TMP, ".agents", "SOUL.md");
	try {
		require("node:fs").unlinkSync(soul);
	} catch {
		/* may not exist */
	}
	const soulMigration = MIGRATIONS.find((m) => m.kind === "soul");
	const r = await lib.prepareMigration(soulMigration.id, {
		scope: "global",
		cwd: TMP,
	});
	assert.equal(r.ok, true);
	assert.equal(r.backup, null);
});

test("prepareMigration refuses when migration is already applied", async () => {
	await lib.setBrainSchemaVersion(LATEST_BRAIN_SCHEMA, "global", TMP);
	const r = await lib.prepareMigration(MIGRATIONS[0].id, {
		scope: "global",
		cwd: TMP,
	});
	assert.equal(r.ok, false);
	assert.match(r.reason, /already applied/);
});

test("markApplied bumps the schema version", async () => {
	await lib.setBrainSchemaVersion(0, "global", TMP);
	const first = MIGRATIONS[0];
	const before = await lib.brainSchemaVersion("global", TMP);
	const r = await lib.markApplied(first.id, { scope: "global", cwd: TMP });
	assert.equal(r.ok, true);
	assert.equal(r.version, first.until);
	const after = await lib.brainSchemaVersion("global", TMP);
	assert.equal(after, first.until);
	assert.notEqual(after, before);
});

test("markApplied rejects unknown ids", async () => {
	const r = await lib.markApplied("does-not-exist", {
		scope: "global",
		cwd: TMP,
	});
	assert.equal(r.ok, false);
	assert.match(r.reason, /unknown migration/);
});

test("upgradeStatus reports pending count and ids", async () => {
	await lib.setBrainSchemaVersion(0, "global", TMP);
	const s = await lib.upgradeStatus({ scope: "any", cwd: TMP });
	assert.equal(s.brainSchemaVersion, 0);
	assert.equal(s.upToDate, false);
	assert.ok(s.pendingCount > 0);
	assert.ok(s.pending.includes(MIGRATIONS[0].id));
});

test("upgradeStatus reports upToDate once LATEST is reached", async () => {
	await lib.setBrainSchemaVersion(LATEST_BRAIN_SCHEMA, "global", TMP);
	const s = await lib.upgradeStatus({ scope: "any", cwd: TMP });
	assert.equal(s.upToDate, true);
	assert.equal(s.pendingCount, 0);
	assert.deepEqual(s.pending, []);
});

test("planUpgrade reflects the persisted version", async () => {
	await lib.setBrainSchemaVersion(0, "global", TMP);
	const plan = await lib.planUpgrade({ scope: "any", cwd: TMP });
	assert.equal(plan.brainSchemaVersion, 0);
	assert.equal(plan.upToDate, false);
	assert.ok(plan.applicable.length > 0);
});

// ---------------------------------------------------------------------------
// Adversarial-review regression tests (4 defects the review tool flagged)
// ---------------------------------------------------------------------------

test("DEFECT-1: markApplied refuses when current < since (precondition)", async () => {
	// Soul migration: since=1, until=2. With brain at schema 0, applying it
	// would silently skip every migration whose until is ≤ 2. Must refuse.
	await lib.setBrainSchemaVersion(0, "global", TMP);
	const soul = MIGRATIONS.find((m) => m.kind === "soul");
	const r = await lib.markApplied(soul.id, { scope: "global", cwd: TMP });
	assert.equal(r.ok, false);
	assert.match(r.reason, /not yet applicable/);
	assert.equal(r.reason.includes("needs") || r.reason.includes("earlier"), true);
	// Schema marker must NOT have moved.
	assert.equal(await lib.brainSchemaVersion("global", TMP), 0);
});

test("DEFECT-2: markApplied refuses when already past until (noop, not success)", async () => {
	await lib.setBrainSchemaVersion(LATEST_BRAIN_SCHEMA, "global", TMP);
	const r = await lib.markApplied(MIGRATIONS[0].id, {
		scope: "global",
		cwd: TMP,
	});
	assert.equal(r.ok, false);
	assert.equal(r.noop, true);
	assert.match(r.reason, /already applied/);
	// Schema marker must NOT have moved backwards.
	assert.equal(await lib.brainSchemaVersion("global", TMP), LATEST_BRAIN_SCHEMA);
});

test("DEFECT-3: upgradeStatus reads the requested scope, not hardcoded global", async () => {
	// Project scope is hardcoded to read ~/.agents/.schema-version. To test
	// isolation, run with a project cwd different from TMP (so its .agents
	// dir is in a separate location) and write a project schema marker there.
	const projTmp = await import("node:fs/promises").then((m) =>
		m.mkdtemp(path.join(tmpdir(), "agent-upg-proj-")),
	);
	try {
		await lib.setBrainSchemaVersion(2, "project", projTmp); // LATEST in project
		await lib.setBrainSchemaVersion(0, "global", TMP); // not LATEST in global
		const s = await lib.upgradeStatus({ scope: "project", cwd: projTmp });
		assert.equal(s.brainSchemaVersion, 2);
		assert.equal(s.upToDate, true);
	} finally {
		await import("node:fs/promises").then((m) =>
			m.rm(projTmp, { recursive: true, force: true }),
		);
	}
});

test("DEFECT-4: buildPlan uses the requested scope for the reported file path", async () => {
	const projTmp = await import("node:fs/promises").then((m) =>
		m.mkdtemp(path.join(tmpdir(), "agent-upg-file-")),
	);
	try {
		const planGlobal = lib.buildPlan(0, { scope: "global", cwd: TMP });
		const planProject = lib.buildPlan(0, { scope: "project", cwd: projTmp });
		assert.ok(
			planGlobal.applicable[0].file &&
				planGlobal.applicable[0].file.includes(".agents/IDENTITY.md") &&
				!planGlobal.applicable[0].file.includes(projTmp),
			"global plan points at global IDENTITY.md",
		);
		assert.ok(
			planProject.applicable[0].file &&
				planProject.applicable[0].file.startsWith(projTmp) &&
				planProject.applicable[0].file.endsWith(".agents/IDENTITY.md"),
			"project plan points at project IDENTITY.md",
		);
	} finally {
		await import("node:fs/promises").then((m) =>
			m.rm(projTmp, { recursive: true, force: true }),
		);
	}
});

// ---------------------------------------------------------------------------
// CLI surface tests — run the registered commands through a Commander harness.
// ---------------------------------------------------------------------------

const { registerMemoryStackCommands } = await import(
	"../src/commands/memory-stack.js"
);
const { registerMemoryUpgradeCommands } = await import(
	"../src/commands/memory-upgrade.js"
);

function cliHarness() {
	const emitted = [];
	let failed = null;
	const program = new Command();
	// Register the parent `memory` command first (the upgrade subcommand
	// attaches to it). Also register the bare `memory <action>` handler so
	// its presence doesn't throw during test setup.
	registerMemoryStackCommands(program, {
		emit: () => {},
		fail: (msg) => {
			throw new Error(msg);
		},
		log: { info() {}, success() {}, warn() {}, error() {}, raw() {}, dim() {}, kv() {} },
		c: new Proxy(
			{},
			{
				get: (_, k) =>
					typeof k === "string" && /^[a-z]/.test(k)
						? (s) => String(s)
						: undefined,
			},
		),
		pretty: (s) => String(s),
		isJson: () => false,
		EXIT: { OK: 0, ERROR: 1, WORK: 2 },
	});
	registerMemoryUpgradeCommands(program, {
		emit: (obj) => {
			emitted.push(obj);
			return obj;
		},
		fail: (msg) => {
			failed = msg;
			throw new Error(msg);
		},
		log: {
			info() {},
			success() {},
			warn() {},
			error() {},
			raw() {},
			dim() {},
			kv() {},
		},
		c: new Proxy(
			{},
			{
				get: (_, k) =>
					typeof k === "string" && /^[a-z]/.test(k)
						? (s) => String(s)
						: undefined,
			},
		),
		pretty: (s) => String(s),
		isJson: () => false,
	});
	return { program, emitted, get failed() { return failed; } };
}

async function run(h, args) {
	await h.program.parseAsync(["node", "agent", ...args]);
}

test("CLI memory upgrade status emits JSON shape", async () => {
	const h = cliHarness();
	await run(h, ["memory", "upgrade", "status"]);
	const out = h.emitted[0];
	assert.equal(out.command, "memory upgrade status");
	assert.equal(typeof out.brainSchemaVersion, "number");
	assert.equal(typeof out.latestSchemaVersion, "number");
	assert.equal(typeof out.upToDate, "boolean");
	assert.ok(Array.isArray(out.pending));
});

test("CLI memory upgrade plan emits plan + instructionsForAgent", async () => {
	const h = cliHarness();
	await run(h, ["memory", "upgrade", "plan"]);
	const out = h.emitted[0];
	assert.equal(out.command, "memory upgrade plan");
	assert.ok(typeof out.instructionsForAgent === "string");
	assert.ok(Array.isArray(out.applicable));
});

test("CLI memory upgrade prepare emits migration spec + backup", async () => {
	await lib.setBrainSchemaVersion(0, "global", TMP);
	const brain = path.join(TMP, ".agents");
	mkdirSync(brain, { recursive: true });
	writeFileSync(path.join(brain, "IDENTITY.md"), "## Identity\nprose\n");

	const h = cliHarness();
	await run(h, [
		"memory",
		"upgrade",
		"prepare",
		MIGRATIONS[0].id,
	]);
	const out = h.emitted[0];
	assert.equal(out.command, "memory upgrade prepare");
	assert.equal(out.id, MIGRATIONS[0].id);
	assert.ok(out.backup, "backup path set when target file exists");
	assert.ok(out.migration);
	assert.ok(Array.isArray(out.migration.fields));
});

test("CLI memory upgrade apply bumps schema version", async () => {
	await lib.setBrainSchemaVersion(0, "global", TMP);
	const h = cliHarness();
	await run(h, ["memory", "upgrade", "apply", MIGRATIONS[0].id]);
	const out = h.emitted[0];
	assert.equal(out.command, "memory upgrade apply");
	assert.equal(out.id, MIGRATIONS[0].id);
	assert.equal(out.version, MIGRATIONS[0].until);
	assert.equal(out.previousVersion, 0);
});

test("CLI memory upgrade prepare fails on unknown id", async () => {
	const h = cliHarness();
	await assert.rejects(
		() => run(h, ["memory", "upgrade", "prepare", "no-such-migration"]),
		/unknown migration/i,
	);
});

test("CLI memory upgrade end-to-end: plan → prepare → apply → status up-to-date", async () => {
	await lib.setBrainSchemaVersion(0, "global", TMP);
	const brain = path.join(TMP, ".agents");
	mkdirSync(brain, { recursive: true });
	writeFileSync(path.join(brain, "IDENTITY.md"), "## Identity\nprose\n");
	writeFileSync(path.join(brain, "SOUL.md"), "## Personality\nprose\n");
	writeFileSync(path.join(brain, "USER.md"), "## Preferences\nprose\n");

	// The LLM loop: status → for each pending migration, prepare + apply.
	// Re-poll status before each prepare so we never act on a stale plan
	// (newer migrations unlock at higher schema versions — see
	// MIGRATIONS[*].since).
	for (let iter = 0; iter < 20; iter++) {
		let h = cliHarness();
		await run(h, ["memory", "upgrade", "status"]);
		const pending = h.emitted[0].pending;
		if (pending.length === 0) break;
		for (const id of pending) {
			// Skip already-applied migrations (defensive — should not happen
			// when status and prepare share state, but cheap insurance).
			const prep = cliHarness();
			try {
				await run(prep, ["memory", "upgrade", "prepare", id]);
			} catch (e) {
				if (/already applied|not yet applicable/.test(String(e.message)))
					continue;
				throw e;
			}
			await run(cliHarness(), "memory upgrade apply".split(" ").concat(id));
		}
	}

	// Final status must be up-to-date.
	const final = cliHarness();
	await run(final, ["memory", "upgrade", "status"]);
	const status = final.emitted[0];
	assert.equal(status.upToDate, true);
	assert.equal(status.pendingCount, 0);
	assert.equal(status.brainSchemaVersion, LATEST_BRAIN_SCHEMA);
});