// Regression test: locks the canonical session-start read order.
//
// `IDENTITY_FILES` in src/agents-lib.js is the single source of truth for the
// order in which `agent-cli brief` emits files. That order is also the contract
// documented in canonical `~/AGENTS.md` ("Session start read order"). If the
// order is changed in one place, this test fails — forcing the three layers
// (AGENTS.md, brief output, IDENTITY_FILES) to stay in sync.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate HOME so any side-effects of importing agents-lib.js stay in a temp dir.
// (IDENTITY_FILES is a static array, but the module also computes
// GLOBAL_AGENTS_DIR = path.join(HOME, ...), which we don't want to write into
// the user's real ~/.agents/agents.)
const HOME_TMP = mkdtempSync(path.join(tmpdir(), "agent-order-home-"));
process.env.AGENT_CLI_HOME = HOME_TMP;

const { IDENTITY_FILES } = await import("../src/agents-lib.js");

// Canonical session-start read order. MUST match:
//   - AGENTS.md "Session start read order" (canonical master)
//   - `agent-cli brief` output numbering
//   - this test
// Changing the order is a spec-level change, not a personal preference.
const EXPECTED_ORDER = [
	"agents", // 1. AGENTS.md       — master contract (HOW to read the rest)
	"soul", // 2. SOUL.md         — personality / values / beliefs
	"identity", // 3. IDENTITY.md     — name / role / archetype
	"user", // 4. USER.md         — the human you serve
	"lessons", // 5. LESSONS.md      — accumulated rules to honor
	"environments", // 6. ENVIRONMENTS.md — operating context
	"models", // 7. MODELS.md       — model aliases + catalog (tools — read last)
	"workflow", // 8. WORKFLOW.md     — reusable task recipes (may cite model aliases)
];

const EXPECTED_FILES = {
	agents: "AGENTS.md",
	soul: "SOUL.md",
	identity: "IDENTITY.md",
	user: "USER.md",
	lessons: "LESSONS.md",
	environments: "ENVIRONMENTS.md",
	models: "MODELS.md",
	workflow: "WORKFLOW.md",
};

// Kinds that have NO project-scope override. They live in a single canonical
// home (the global file under ~/.agents/) and don't vary per project, because
// they describe characteristics of the agent/machine/operator, not the project.
// MUST match the contract in src/agents-lib.js → IDENTITY_FILES.
const EXPECTED_GLOBAL_ONLY = new Set(["identity", "user", "models"]);

test("IDENTITY_FILES: order matches the canonical session-start read order", () => {
	const actual = IDENTITY_FILES.map((f) => f.kind);
	assert.deepEqual(
		actual,
		EXPECTED_ORDER,
		`IDENTITY_FILES order is ${actual.join(" → ")}; expected ${EXPECTED_ORDER.join(" → ")}. ` +
			`If this changed, also update canonical ~/AGENTS.md "Session start read order" + the brief output header.`,
	);
});

test("IDENTITY_FILES: each kind appears exactly once", () => {
	const kinds = IDENTITY_FILES.map((f) => f.kind);
	const uniq = new Set(kinds);
	assert.equal(
		uniq.size,
		kinds.length,
		`duplicate kinds in IDENTITY_FILES: ${kinds.join(", ")}`,
	);
});

test("IDENTITY_FILES: every entry has kind, .md file, and non-empty desc", () => {
	for (const f of IDENTITY_FILES) {
		assert.equal(
			typeof f.kind,
			"string",
			`kind not string: ${JSON.stringify(f)}`,
		);
		assert.ok(f.kind.length > 0, `kind empty: ${JSON.stringify(f)}`);
		assert.equal(
			typeof f.file,
			"string",
			`file not string: ${JSON.stringify(f)}`,
		);
		assert.ok(f.file.endsWith(".md"), `file not .md: ${JSON.stringify(f)}`);
		assert.equal(
			typeof f.desc,
			"string",
			`desc not string: ${JSON.stringify(f)}`,
		);
		assert.ok(f.desc.length > 0, `desc empty: ${JSON.stringify(f)}`);
	}
});

test("IDENTITY_FILES: kind→file mapping matches the canonical contract", () => {
	for (const f of IDENTITY_FILES) {
		assert.equal(
			f.file,
			EXPECTED_FILES[f.kind],
			`kind=${f.kind}: file is ${f.file}, expected ${EXPECTED_FILES[f.kind]}`,
		);
	}
});

test("EXPECTED_ORDER covers every kind the contract defines", () => {
	// Guard against EXPECTED_ORDER drifting from the actual contract.
	assert.deepEqual(
		[...EXPECTED_ORDER].sort(),
		[...Object.keys(EXPECTED_FILES)].sort(),
		"EXPECTED_ORDER and EXPECTED_FILES must describe the same set of kinds",
	);
});

test("IDENTITY_FILES: globalOnly flag matches the contract (identity/user/models only)", () => {
	for (const f of IDENTITY_FILES) {
		const expected = EXPECTED_GLOBAL_ONLY.has(f.kind);
		assert.equal(
			!!f.globalOnly,
			expected,
			`kind=${f.kind}: globalOnly=${f.globalOnly}, expected ${expected}. ` +
				`globalOnly kinds (identity / user / models) have NO project-scope override. ` +
				`Other kinds (agents / soul / lessons / environments / workflow) DO have a project override.`,
		);
	}
});

test("IDENTITY_FILES: workflow is LAST and project-overridable", () => {
	// WORKFLOW.md must be read AFTER MODELS.md: a recorded workflow step may
	// reference a model alias (`coding-model`, …), and those aliases only
	// resolve once MODELS.md has been read. Moving `workflow` earlier — or
	// inserting a new kind after it — breaks that resolution order.
	const last = IDENTITY_FILES[IDENTITY_FILES.length - 1];
	assert.equal(
		last.kind,
		"workflow",
		`workflow must be the LAST entry in IDENTITY_FILES (MODELS.md must be read first so ` +
			`model aliases cited by a workflow step resolve); last is '${last.kind}'`,
	);
	assert.equal(last.file, "WORKFLOW.md");
	// Not globalOnly: a project may override the global recipes with its own.
	assert.equal(
		!!last.globalOnly,
		false,
		"workflow must NOT be globalOnly — it supports a project-scope override like lessons/environments",
	);
	const modelsIdx = IDENTITY_FILES.findIndex((f) => f.kind === "models");
	assert.ok(
		modelsIdx > -1 && modelsIdx < IDENTITY_FILES.length - 1,
		"models must come before workflow in IDENTITY_FILES",
	);
});

test("IDENTITY_FILES: globalOnly kinds count + identity is exhaustive", () => {
	// Guard against EXPECTED_GLOBAL_ONLY drifting from the contract.
	assert.equal(
		EXPECTED_GLOBAL_ONLY.size,
		3,
		"EXPECTED_GLOBAL_ONLY must list exactly 3 kinds (identity, user, models)",
	);
	for (const k of EXPECTED_GLOBAL_ONLY) {
		assert.ok(
			EXPECTED_FILES[k],
			`EXPECTED_GLOBAL_ONLY references unknown kind '${k}'`,
		);
	}
});
