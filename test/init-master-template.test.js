// Regression: `agent init` must produce a canonical AGENTS.md that includes the
// mandatory session-start read order. The rule lives in src/blocks.js →
// AGENT_CLI_BODY (the managed block injected by ensureMaster/refreshBlocks).
// If a future edit to that template drops the rule, this test fails — forcing
// the agent-cli block to stay in sync with brief output, IDENTITY_FILES, and
// the canonical ~/AGENTS.md text.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolated HOME so ensureMaster() writes to a temp master (not the user's
// real ~/AGENTS.md).
const TMP = mkdtempSync(path.join(tmpdir(), "agent-init-tpl-home-"));
process.env.AGENT_CLI_HOME = TMP;

const store = await import("../src/store.js");
const masterPath = path.join(TMP, "AGENTS.md");

const AGENT_CLI_BLOCK_BEGIN = "<!-- BEGIN agent-cli -->";
const AGENT_CLI_BLOCK_END = "<!-- END agent-cli -->";

// Canonical session-start order. MUST match:
//   - canonical ~/AGENTS.md
//   - AGENT_CLI_BODY in src/blocks.js
//   - IDENTITY_FILES in src/agents-lib.js
//   - `agent brief` output numbering
//   - test/identity-files-order.test.js
const CANONICAL_ORDER = [
	"1. AGENTS.md",
	"2. SOUL.md",
	"3. IDENTITY.md",
	"4. USER.md",
	"5. LESSONS.md",
	"6. ENVIRONMENTS.md",
	"7. MODELS.md",
];

function readAgentCliBlock(content) {
	const beginIdx = content.indexOf(AGENT_CLI_BLOCK_BEGIN);
	const endIdx = content.indexOf(AGENT_CLI_BLOCK_END);
	if (beginIdx < 0 || endIdx <= beginIdx) return null;
	return content.slice(beginIdx, endIdx + AGENT_CLI_BLOCK_END.length);
}

// Run ensureMaster once — on a clean install (no master, no seed source)
// this writes STARTER + managed blocks, which is exactly what `agent init`
// produces on a fresh machine.
const result = await store.ensureMaster();
const master = readFileSync(masterPath, "utf8");

test("ensureMaster on a clean install writes the master (starter action)", () => {
	assert.equal(result.action, "starter");
	assert.equal(result.changed, true);
	assert.ok(master.length > 200, "master suspiciously small");
});

test("ensureMaster injects the agent-cli managed block", () => {
	assert.ok(
		master.includes(AGENT_CLI_BLOCK_BEGIN),
		"missing agent-cli begin marker",
	);
	assert.ok(
		master.includes(AGENT_CLI_BLOCK_END),
		"missing agent-cli end marker",
	);
});

test("agent-cli block contains the 'Session start read order' section", () => {
	const block = readAgentCliBlock(master);
	assert.ok(block !== null, "agent-cli block missing");
	assert.ok(
		block.includes("## Session start read order"),
		"agent-cli block missing the 'Session start read order' heading",
	);
});

test("agent-cli block tags the rule as MANDATORY", () => {
	const block = readAgentCliBlock(master);
	assert.ok(block !== null);
	assert.ok(
		/Session start read order \(MANDATORY\)/.test(block),
		"rule heading must be tagged '(MANDATORY)'",
	);
});

test("agent-cli block lists all 7 canonical files in strict order", () => {
	const block = readAgentCliBlock(master);
	assert.ok(block !== null);
	const positions = CANONICAL_ORDER.map((s) => block.indexOf(s));
	for (let i = 0; i < CANONICAL_ORDER.length; i++) {
		assert.notEqual(
			positions[i],
			-1,
			`agent-cli block missing entry: '${CANONICAL_ORDER[i]}'`,
		);
	}
	for (let i = 1; i < positions.length; i++) {
		assert.ok(
			positions[i] > positions[i - 1],
			`order broken at entry ${i + 1}: '${CANONICAL_ORDER[i]}' (pos ${positions[i]}) should come after '${CANONICAL_ORDER[i - 1]}' (pos ${positions[i - 1]})`,
		);
	}
});

test("agent-cli block annotates identity / user / models as 'global only'", () => {
	const block = readAgentCliBlock(master);
	assert.ok(block !== null);
	// The rule's order table must mark the three globalOnly kinds with the
	// '— global only' annotation (matching the brief output's '(global only)'
	// label). The other four kinds must NOT carry that annotation.
	const GLOBAL_ONLY_KINDS = ["IDENTITY.md", "USER.md", "MODELS.md"];
	const OVERRIDABLE_KINDS = [
		"AGENTS.md",
		"SOUL.md",
		"LESSONS.md",
		"ENVIRONMENTS.md",
	];

	for (const kind of GLOBAL_ONLY_KINDS) {
		// Find the rule's order-table line for this kind. It looks like
		// '  3. IDENTITY.md      — name / role / archetype (which specific instance) — global only'
		const lineRe = new RegExp(
			`^\\s*\\d+\\.\\s+${kind}\\b[^\n]*—\\s*global only\\s*$`,
			"m",
		);
		assert.ok(
			lineRe.test(block),
			`agent-cli block rule line for '${kind}' must be annotated '— global only'`,
		);
	}
	for (const kind of OVERRIDABLE_KINDS) {
		// Same shape, but must NOT have '— global only' on the same line.
		const lineRe = new RegExp(`^\\s*\\d+\\.\\s+${kind}\\b[^\n]*$`, "m");
		const match = block.match(lineRe);
		assert.ok(
			match !== null,
			`agent-cli block rule line for '${kind}' (overridable) is missing or malformed`,
		);
		assert.ok(
			!/—\s*global only/.test(match[0]),
			`agent-cli block rule line for '${kind}' must NOT be annotated '— global only' (it has a project override)`,
		);
	}
});

test("agent-cli block explains WHY identity / user / models are global only", () => {
	const block = readAgentCliBlock(master);
	assert.ok(block !== null);
	// The rationale paragraph is part of the contract — without it, the
	// annotation is just a label and the design intent isn't conveyed to the
	// model reading the master.
	assert.ok(
		/Global-only kinds \(identity \/ user \/ models\)/.test(block),
		"agent-cli block must name the three globalOnly kinds in the rationale paragraph",
	);
	assert.ok(
		/NO project-scope override/i.test(block),
		"agent-cli block must explain that globalOnly kinds have no project override",
	);
});

test("ensureMaster is idempotent — the rule survives a re-run exactly once", async () => {
	const r = await store.ensureMaster();
	assert.equal(r.action, "exists");
	const after = readFileSync(masterPath, "utf8");
	const matches = after.match(/## Session start read order/g) || [];
	assert.equal(
		matches.length,
		1,
		`rule heading appears ${matches.length} times, expected 1 (ensureBlocks must be idempotent — duplication would mean the block is re-appended instead of replaced)`,
	);
});

test("refreshBlocks preserves the rule (idempotent no-op on a clean master)", async () => {
	const r = await store.refreshBlocks();
	assert.equal(
		r.changed,
		false,
		"refreshBlocks should be a no-op when the template already matches",
	);
	const after = readFileSync(masterPath, "utf8");
	const block = readAgentCliBlock(after);
	assert.ok(block !== null, "agent-cli block missing after refreshBlocks");
	assert.ok(
		block.includes("## Session start read order"),
		"rule lost after refreshBlocks",
	);
});

test("user-content outside the managed blocks survives refreshBlocks", async () => {
	// Add a user note AFTER the agent-cli block (in user-content territory).
	// refreshBlocks must not touch it.
	const before = readFileSync(masterPath, "utf8");
	const customNote = `\n## My project notes\n\nThis section belongs to me.\n`;
	const withNote = before + customNote;
	writeFileSync(masterPath, withNote);
	await store.refreshBlocks();
	const after = readFileSync(masterPath, "utf8");
	assert.ok(
		after.includes("## My project notes"),
		"user-content section was wiped by refreshBlocks (regression)",
	);
	// Also assert the rule is still there.
	const block = readAgentCliBlock(after);
	assert.ok(
		block !== null && block.includes("## Session start read order"),
		"rule lost when user-content was added",
	);
});
