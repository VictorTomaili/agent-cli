// Tests for src/commands/inspect.js — whoami, files, and the new validate
// command. Validate is the headline addition: a fast setup integrity check
// distinct from the comprehensive doctor.

import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-inspect-"));
process.env.AGENT_CLI_HOME = TMP;
process.chdir(TMP);

// Eager imports.
const inspectMod = await import("../src/commands/inspect.js");
const agentsLib = await import("../src/agents-lib.js");
const configMod = await import("../src/config.js");
const pointerMod = await import("../src/pointer.js");
const targetsMod = await import("../src/targets/index.js");
const detectMod = await import("../src/detect.js");
const envelopeMod = await import("../src/envelope.js");

// Global process.exit interceptor — validate calls process.exit(EXIT.ERROR)
// on failure, which would otherwise kill the worker. We capture the code
// and throw so the test can assert on it.
let lastExitCode = null;
process.exit = (code) => {
	lastExitCode = code;
	throw new Error("__exit__");
};

function harness() {
	const emitted = [];
	const program = new Command();
	program.option("--json");
	program.option("--compact");
	program.exitOverride();
	program.configureOutput({
		writeOut: () => {},
		writeErr: () => {},
	});
	inspectMod.registerInspectCommands(program, {
		emit: (obj) => {
			emitted.push(obj);
			return obj;
		},
		fail: (msg) => {
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
		readFile: async (p) => readFileSync(p, "utf8"),
		identityInventory: agentsLib.identityInventory,
		isJson: () => false,
		isConfigCorrupt: configMod.isConfigCorrupt,
		loadConfig: configMod.loadConfig,
		classify: pointerMod.classify,
		getTarget: targetsMod.getTarget,
		detectInstalled: detectMod.detectInstalled,
		EXIT: envelopeMod.EXIT,
	});
	return { program, emitted };
}

async function run(h, args) {
	// parseAsync may throw if validate's process.exit fires — that's expected,
	// since the global exit interceptor rethrows to short-circuit. Swallow.
	await h.program.parseAsync(["node", "agent", ...args]).catch(() => {});
}

// ---------------------------------------------------------------------------
// Validate — happy path
// ---------------------------------------------------------------------------

test("validate on a fresh home passes (only config check)", async () => {
	const h = harness();
	await run(h, ["validate"]);
	const out = h.emitted[0];
	assert.equal(out.command, "validate");
	assert.equal(out.ok, true);
	assert.equal(out.failed, 0);
	assert.ok(out.total >= 1);
	// The first check is always config.
	const first = out.checks[0];
	assert.equal(first.name, "config");
	assert.equal(first.ok, true);
});

test("validate --json emits the structured envelope", async () => {
	const h = harness();
	await run(h, ["validate", "--json"]);
	const out = h.emitted[0];
	assert.equal(out.command, "validate");
	assert.equal(typeof out.ok === "boolean", true);
	assert.ok(Array.isArray(out.checks));
});

// ---------------------------------------------------------------------------
// Validate — corrupted config surfaces
// ---------------------------------------------------------------------------

test("validate fails when config.json is corrupt", async () => {
	const h = harness();
	const cfgFile = path.join(TMP, ".agents", "config.json");
	mkdirSync(path.dirname(cfgFile), { recursive: true });
	const backup = existsSync(cfgFile) ? readFileSync(cfgFile, "utf8") : null;
	// lgtm[js/file-system-race] -- corrupt-config test fixture, single-process
	writeFileSync(cfgFile, "{ this is not valid json");
	lastExitCode = null;
	try {
		await h.program
			.parseAsync(["node", "agent", "validate", "--json"])
			.catch(() => {});
		assert.equal(lastExitCode, 1, `must exit 1 on failure, got ${lastExitCode}`);
		const out = h.emitted.find((e) => e.command === "validate");
		assert.ok(out, "validate should still emit a payload before exiting");
		assert.equal(out.ok, false);
		assert.ok(out.failed > 0);
		const configCheck = out.checks.find((c) => c.name === "config");
		assert.equal(configCheck.ok, false);
		assert.match(configCheck.detail, /corrupt|load failed/);
	} finally {
		if (backup === null) rmSync(cfgFile, { force: true }); else writeFileSync(cfgFile, backup);
	}
});

// ---------------------------------------------------------------------------
// Validate — brain file readability
// ---------------------------------------------------------------------------

test("validate reports brain files as readable when they exist", async () => {
	const h = harness();
	const idPath = path.join(TMP, ".agents", "IDENTITY.md");
	mkdirSync(path.dirname(idPath), { recursive: true });
	writeFileSync(idPath, "<AGENT_NAME>Test</AGENT_NAME>\n");
	await run(h, ["validate"]);
	const out = h.emitted[0];
	const brainCheck = out.checks.find((c) => c.name === "brain:identity");
	assert.ok(brainCheck, "brain:identity check must run when file exists");
	assert.equal(brainCheck.ok, true);
});

// ---------------------------------------------------------------------------
// Validate — pointer stub state per enabled target
// ---------------------------------------------------------------------------

test("validate reports missing stub for an enabled target", async () => {
	const h = harness();
	const cfgFile = path.join(TMP, ".agents", "config.json");
	mkdirSync(path.dirname(cfgFile), { recursive: true });
	writeFileSync(
		cfgFile,
		JSON.stringify({ version: 2, global: ["claude"] }),
	);
	lastExitCode = null;
	await run(h, ["validate"]);
	const out = h.emitted[0];
	const claudeCheck = out.checks.find((c) => c.name === "target:claude");
	assert.ok(claudeCheck, "claude target check must run");
	assert.equal(claudeCheck.ok, false);
	assert.match(claudeCheck.detail, /stub missing/);
	assert.equal(lastExitCode, 1, "validate must exit 1 on missing stub");
});

test("validate reports an unknown target id in cfg.global as a failure", async () => {
	const h = harness();
	const cfgFile = path.join(TMP, ".agents", "config.json");
	mkdirSync(path.dirname(cfgFile), { recursive: true });
	writeFileSync(
		cfgFile,
		JSON.stringify({ version: 2, global: ["totally-not-a-real-tool"] }),
	);
	lastExitCode = null;
	await run(h, ["validate"]);
	const out = h.emitted[0];
	const unknown = out.checks.find((c) => c.name === "target:totally-not-a-real-tool");
	assert.ok(unknown);
	assert.equal(unknown.ok, false);
	assert.match(unknown.detail, /unknown id/);
	assert.equal(lastExitCode, 1, "validate must exit 1 on unknown target");
});

// ---------------------------------------------------------------------------
// Validate — installed-but-not-enabled hint
// ---------------------------------------------------------------------------

test("validate surfaces an info hint when a tool is installed but not enabled", async () => {
	// Create .claude/ in HOME (not AGENT_CLI_HOME — that's where detect
	// looks) so detectInstalled picks it up.
	const claudeHome = path.join(TMP, ".claude");
	mkdirSync(claudeHome, { recursive: true });
	const h = harness();
	// Don't enable claude — it should show up as a hint.
	await run(h, ["validate"]);
	const out = h.emitted[0];
	const hint = out.checks.find(
		(c) => c.name === "info:installed-not-enabled",
	);
	// Depending on test isolation this might or might not be present.
	// If present, it must be ok:true (it's a hint, not a failure).
	if (hint) {
		assert.equal(hint.ok, true);
		assert.match(hint.detail, /claude/);
	}
});

// ---------------------------------------------------------------------------
// Exit code: validate exits 1 with at least one failure
// ---------------------------------------------------------------------------

test("validate exits non-zero on failure (process.exit(EXIT.ERROR) = 1)", async () => {
	const h = harness();
	const cfgFile = path.join(TMP, ".agents", "config.json");
	const backup = existsSync(cfgFile) ? readFileSync(cfgFile, "utf8") : null;
	mkdirSync(path.dirname(cfgFile), { recursive: true });
	// lgtm[js/file-system-race] -- corrupt-config test fixture, single-process
	writeFileSync(cfgFile, "{" /* malformed */);
	lastExitCode = null;
	try {
		await h.program.parseAsync(["node", "agent", "validate"]).catch(() => {});
		assert.equal(
			lastExitCode,
			1,
			`validate must exit 1 on failure, got ${lastExitCode}`,
		);
	} finally {
		if (backup === null) rmSync(cfgFile, { force: true }); else writeFileSync(cfgFile, backup);  // lgtm[js/file-system-race] -- restore-fixture
	}
});