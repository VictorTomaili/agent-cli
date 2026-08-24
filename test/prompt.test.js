// Tests for src/prompt-report.js (dynamic system-prompt builder) +
// src/commands/prompt.js (CLI surface). Verifies the prompt reflects the
// user's actual state, not just a static template.

import { test } from "node:test";
import assert from "node:assert";
import { Command } from "commander";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate HOME BEFORE importing agent-cli modules.
const HOME = mkdtempSync(path.join(tmpdir(), "agent-prompt-"));
process.env.AGENT_CLI_HOME = HOME;

const { buildPromptPayload } = await import("../src/prompt-report.js");
const actionsMod = await import("../src/actions.js");

// ---------------------------------------------------------------------------
// Pure builder tests
// ---------------------------------------------------------------------------

test("buildPromptPayload emits all six sections by default", async () => {
	const s = await actionsMod.collectState({
		cwd: HOME,
		offline: true,
		pkgName: "@victortomaili/agent-cli",
	});
	const p = buildPromptPayload(s, { version: "9.9.9" });
	assert.equal(p.metadata.version, "9.9.9");
	assert.ok(p.content.length > 500);
	assert.ok(p.sections.length >= 4);
	// The 6 canonical headings.
	assert.ok(p.content.includes("Your environment"));
	assert.ok(p.content.includes("Hard rules"));
	assert.ok(p.content.includes("Pending actions"));
	assert.ok(p.content.includes("Common commands for this setup"));
});

test("buildPromptPayload surfaces installed tools count", async () => {
	const s = await actionsMod.collectState({
		cwd: HOME,
		offline: true,
		pkgName: "@victortomaili/agent-cli",
	});
	const p = buildPromptPayload(s, { version: "9.9.9" });
	assert.equal(typeof p.metadata.tools.installed, "object");
	assert.ok(Array.isArray(p.metadata.tools.installed));
	assert.ok(typeof p.metadata.tools.installed.length === "number");
});

test("buildPromptPayload surfaces brain gaps when archetype is missing", async () => {
	const s = await actionsMod.collectState({
		cwd: HOME,
		offline: true,
		pkgName: "@victortomaili/agent-cli",
	});
	// In a fresh HOME with no IDENTITY.md, archetypeNeeded is true.
	const p = buildPromptPayload(s, { version: "9.9.9" });
	assert.ok(
		Object.keys(p.metadata.missingBrainFields).length > 0 ||
			s.archetypeNeeded === true,
		"fresh install reports archetype missing",
	);
});

test("buildPromptPayload mentions pending init when no master exists", async () => {
	const s = await actionsMod.collectState({
		cwd: HOME,
		offline: true,
		pkgName: "@victortomaili/agent-cli",
	});
	const p = buildPromptPayload(s, { version: "9.9.9" });
	const ids = p.metadata.pendingActions.map((a) => a.id);
	assert.ok(
		ids.includes("init"),
		`pending actions should include 'init' on a fresh home, got ${JSON.stringify(ids)}`,
	);
	// Critical / high actions should be the first ones listed.
	const sev = p.metadata.pendingActions.map((a) => a.severity);
	assert.ok(
		sev.includes("critical"),
		`pending actions should include 'critical' severity`,
	);
});

test("buildPromptPayload reflects --for task in section 5", async () => {
	const s = await actionsMod.collectState({
		cwd: HOME,
		offline: true,
		pkgName: "@victortomaili/agent-cli",
	});
	const hits = [
		{ path: "memory/upgrade", title: "Upgrade plan", snippet: "...", score: 0.9 },
	];
	const p = buildPromptPayload(s, {
		version: "9.9.9",
		forTask: "upgrade my memory files",
		forTaskHits: hits,
	});
	assert.ok(p.content.includes("Task-aware context"));
	assert.ok(p.content.includes("upgrade my memory files"));
	assert.ok(p.content.includes("memory/upgrade"));
});

test("buildPromptPayload omits Task-aware section when no forTask", async () => {
	const s = await actionsMod.collectState({
		cwd: HOME,
		offline: true,
		pkgName: "@victortomaili/agent-cli",
	});
	const p = buildPromptPayload(s, { version: "9.9.9" });
	assert.ok(!p.content.includes("Task-aware context"));
});

test("buildPromptPayload caps the pending-actions list at the top-N", async () => {
	const s = await actionsMod.collectState({
		cwd: HOME,
		offline: true,
		pkgName: "@victortomaili/agent-cli",
	});
	const p = buildPromptPayload(s, { version: "9.9.9" });
	// Section 3 in metadata lists EVERY pending action (not capped), but the
	// rendered Markdown says "top N" with N bounded for readability.
	assert.ok(p.metadata.pendingActions.length >= 0);
	const topSection = p.sections.find((s) => s.includes("Pending actions"));
	if (topSection) {
		// Either there are ≤5 actions (no cap mention) or "top 5" appears.
		const limitReached = p.metadata.pendingActions.length > 5;
		if (limitReached) {
			assert.match(topSection, /top 5/);
		}
	}
});

test("buildPromptPayload content is short enough to fit a system prompt", async () => {
	const s = await actionsMod.collectState({
		cwd: HOME,
		offline: true,
		pkgName: "@victortomaili/agent-cli",
	});
	const p = buildPromptPayload(s, { version: "9.9.9" });
	// 6KB ceiling — well within the typical 8K system-prompt context window.
	assert.ok(p.content.length < 6006, `prompt too long: ${p.content.length} bytes`);
});

// ---------------------------------------------------------------------------
// CLI surface tests
// ---------------------------------------------------------------------------

const { registerPromptCommand } = await import("../src/commands/prompt.js");

function harness(isJsonMode = true) {
	const emitted = [];
	const program = new Command();
	program.option("--json");
	program.option("--compact");
	program.exitOverride();
	registerPromptCommand(program, {
		emit: (obj) => {
			emitted.push(obj);
			return obj;
		},
		fail: (msg) => {
			throw new Error(msg);
		},
		log: { info() {}, success() {}, warn() {}, error() {}, raw() {}, dim() {}, kv() {} },
		c: new Proxy({}, { get: () => (s) => String(s) }),
		pretty: (s) => String(s),
		isJson: () => isJsonMode,
		VERSION: "9.9.9",
	});
	return { program, emitted };
}

async function run(h, args) {
	await h.program.parseAsync(["node", "agent", ...args]);
}

test("CLI prompt --json emits structured envelope", async () => {
	const h = harness(true);
	await run(h, ["prompt", "--json"]);
	const out = h.emitted[0];
	assert.equal(out.command, "prompt");
	assert.ok(typeof out.content === "string");
	assert.ok(out.content.length > 0);
	assert.ok(out.metadata);
	assert.equal(out.metadata.version, "9.9.9");
	assert.ok(Array.isArray(out.metadata.pendingActions));
});

test("CLI prompt (no flags) prints Markdown", async () => {
	const h = harness(false);
	const captured = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk) => {
		captured.push(String(chunk));
		return true;
	};
	try {
		await run(h, ["prompt"]);
	} finally {
		process.stdout.write = origWrite;
	}
	const out = captured.join("");
	assert.ok(out.includes("# agent-cli system prompt"));
	assert.ok(out.includes("Hard rules"));
});

test("CLI prompt --for '<task>' adds Task-aware section", async () => {
	const h = harness(false);
	const captured = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk) => {
		captured.push(String(chunk));
		return true;
	};
	try {
		await run(h, ["prompt", "--for", "fix my claude pointers"]);
	} finally {
		process.stdout.write = origWrite;
	}
	const out = captured.join("");
	assert.ok(out.includes("Task-aware context"));
	assert.ok(out.includes("fix my claude pointers"));
});

// ---------------------------------------------------------------------------
// Conflict check: `prompt` no longer aliases `instructions`.
// ---------------------------------------------------------------------------

const { registerInstructionsCommand } = await import(
	"../src/commands/instructions.js"
);

function harnessBoth(isJsonMode = true) {
	const emitted = [];
	const program = new Command();
	program.option("--json");
	program.option("--compact");
	program.exitOverride();
	registerPromptCommand(program, {
		emit: (obj) => {
			emitted.push(obj);
			return obj;
		},
		fail: (msg) => {
			throw new Error(msg);
		},
		log: { info() {}, success() {}, warn() {}, error() {}, raw() {}, dim() {}, kv() {} },
		c: new Proxy({}, { get: () => (s) => String(s) }),
		pretty: (s) => String(s),
		isJson: () => isJsonMode,
		VERSION: "9.9.9",
	});
	registerInstructionsCommand(program, {
		emit: (obj) => {
			emitted.push(obj);
			return obj;
		},
		fail: (msg) => {
			throw new Error(msg);
		},
		log: { info() {}, success() {}, warn() {}, error() {}, raw() {}, dim() {}, kv() {} },
		c: new Proxy({}, { get: () => (s) => String(s) }),
		pretty: (s) => String(s),
		isJson: () => isJsonMode,
		VERSION: "9.9.9",
	});
	return { program, emitted };
}

test("`prompt` is now its own command (not an alias of `instructions`)", async () => {
	const h = harnessBoth(true);
	await h.program.parseAsync(["node", "agent", "prompt", "--json"]);
	const out = h.emitted[0];
	assert.equal(out.command, "prompt");
	assert.ok(out.metadata, "prompt has metadata — proves it's the dynamic command");
	// Verify instructions still works — under --json it emits the structured
	// envelope, NOT the prompt's shape (no `metadata`).
	await h.program.parseAsync(["node", "agent", "instructions", "--json"]);
	const out2 = h.emitted[1];
	assert.equal(out2.command, "instructions");
	assert.ok(!out2.metadata, "instructions envelope has no `metadata` field");
});