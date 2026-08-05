// Integration tests for src/commands/target.js — Finding 9: target scope and
// transactional state. Verifies cross-project isolation (per-root projectTargets),
// null→all is never converted into a one-item allowlist, deploy-before-persist,
// blocked/skipped failures, unsupported scopes, and unknown ids.
import { test } from "node:test";
import assert from "node:assert";
import { Command } from "commander";
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

const HOME = mkdtempSync(path.join(tmpdir(), "agent-tgtcfg-"));
process.env.AGENT_CLI_HOME = HOME;

const { registerTargetCommand } = await import("../src/commands/target.js");
const config = await import("../src/config.js");

const PROJ_A = mkdtempSync(path.join(tmpdir(), "agent-tgt-a-"));
const PROJ_B = mkdtempSync(path.join(tmpdir(), "agent-tgt-b-"));

const configFile = () => path.join(HOME, ".agents", "config.json");

function resetConfig() {
	rmSync(configFile(), { force: true });
}
function cleanProj(dir) {
	for (const rel of [
		".cursor",
		"CLAUDE.md",
		"AGENTS.md",
		".github",
		".codex",
		".pi",
	]) {
		rmSync(path.join(dir, rel), { recursive: true, force: true });
	}
}
function readConfigJson() {
	return JSON.parse(readFileSync(configFile(), "utf8"));
}

/** A self-contained harness that records emit/fail instead of exiting. */
function harness() {
	const emitted = [];
	let failed = null;
	let failedDetails = null;
	const program = new Command();
	registerTargetCommand(program, {
		emit: (obj) => {
			emitted.push(obj);
			return obj;
		},
		fail: (message, details = {}) => {
			failed = message;
			failedDetails = details;
			const err = new Error(message);
			err.failedDetails = details;
			throw err;
		},
		ctxPaths: () => ({
			masterAbs: path.join(HOME, "AGENTS.md"),
			masterTilde: "~/AGENTS.md",
		}),
		isJson: () => false,
	});
	return {
		program,
		emitted,
		get failed() {
			return failed;
		},
		get failedDetails() {
			return failedDetails;
		},
	};
}

async function runTarget(h, args, cwd) {
	const prev = process.cwd();
	process.chdir(cwd);
	try {
		await h.program.parseAsync(["node", "agent", "target", ...args]);
	} finally {
		process.chdir(prev);
	}
}

test("unknown target id is rejected without persisting", async () => {
	resetConfig();
	const h = harness();
	await assert.rejects(() => runTarget(h, ["enable", "bogus", "--project"], PROJ_A));
	assert.match(h.failed, /Unknown target/i);
	assert.ok(!existsSync(configFile()));
});

test("enabling a project target in project A does not affect project B", async () => {
	resetConfig();
	cleanProj(PROJ_A);
	cleanProj(PROJ_B);
	const h = harness();
	await runTarget(h, ["enable", "cursor", "--project"], PROJ_A);
	assert.equal(h.failed, null);

	const cfg = readConfigJson();
	// A was null (all) — enabling cursor must NOT collapse it to a one-item
	// allowlist (the old `project` field did, damaging every other project).
	assert.equal(cfg.projectTargets[PROJ_A], null);

	// Project B must still see ALL project targets: cursor did not leak a
	// one-item allowlist into unrelated projects.
	const bIds = config.effectiveProjectIds(cfg, PROJ_B);
	assert.ok(bIds.includes("claude"));
	assert.ok(bIds.includes("codex"));

	// and the cursor stub was actually deployed in A.
	assert.ok(existsSync(path.join(PROJ_A, ".cursor", "rules", "agent-cli.mdc")));
});

test("enabling a project target does not convert null (all) into a one-item allowlist", async () => {
	resetConfig();
	cleanProj(PROJ_A);
	const h = harness();
	await runTarget(h, ["enable", "cursor", "--project"], PROJ_A);
	assert.equal(h.failed, null);
	const cfg = readConfigJson();
	const aIds = config.effectiveProjectIds(cfg, PROJ_A);
	assert.ok(aIds.length > 1);
	assert.ok(aIds.includes("claude"));
	assert.ok(aIds.includes("cursor"));
});

test("disabling in project A does not restrict project B", async () => {
	resetConfig();
	cleanProj(PROJ_A);
	cleanProj(PROJ_B);
	const h = harness();
	await runTarget(h, ["disable", "claude", "--project"], PROJ_A);
	assert.equal(h.failed, null);
	const cfg = readConfigJson();
	const aIds = config.effectiveProjectIds(cfg, PROJ_A);
	assert.ok(!aIds.includes("claude"));
	const bIds = config.effectiveProjectIds(cfg, PROJ_B);
	assert.ok(bIds.includes("claude")); // B unaffected by A's disable
});

test("enabling a target back after disabling re-adds it in that project only", async () => {
	resetConfig();
	cleanProj(PROJ_A);
	await runTarget(harness(), ["disable", "claude", "--project"], PROJ_A);
	const h = harness();
	await runTarget(h, ["enable", "claude", "--project"], PROJ_A);
	assert.equal(h.failed, null);
	const cfg = readConfigJson();
	assert.ok(config.effectiveProjectIds(cfg, PROJ_A).includes("claude"));
	assert.ok(config.effectiveProjectIds(cfg, PROJ_B).includes("claude"));
});

test("blocked native-content linking is reported as a failure and not persisted", async () => {
	resetConfig();
	cleanProj(PROJ_A);
	const nativeFile = path.join(PROJ_A, ".cursor", "rules", "agent-cli.mdc");
	mkdirSync(path.dirname(nativeFile), { recursive: true });
	writeFileSync(nativeFile, "my own cursor rules\n");
	const h = harness();
	await assert.rejects(
		() => runTarget(h, ["enable", "cursor", "--project"], PROJ_A),
	);
	assert.match(h.failed, /native-content/i);
	assert.equal(h.failedDetails.reason, "native-content");
	// deploy failed → config must NOT be saved
	assert.ok(!existsSync(configFile()), "config must not be written when deploy is blocked");
	// native file preserved untouched
	assert.equal(readFileSync(nativeFile, "utf8"), "my own cursor rules\n");
});

test("unsupported target scope is rejected and never persisted", async () => {
	resetConfig();
	cleanProj(PROJ_A);
	const h = harness();
	// cursor has no global path — `target enable cursor --global` must be rejected.
	await assert.rejects(
		() => runTarget(h, ["enable", "cursor", "--global"], PROJ_A),
	);
	assert.equal(h.failedDetails.reason, "unsupported-scope");
	assert.ok(!existsSync(configFile()));
	assert.ok(!existsSync(path.join(HOME, ".cursor")));
});

test("global enable still deploys and persists for a global-capable target", async () => {
	resetConfig();
	cleanProj(HOME);
	const h = harness();
	await runTarget(h, ["enable", "claude", "--global"], PROJ_A);
	assert.equal(h.failed, null);
	const cfg = readConfigJson();
	assert.deepEqual(cfg.global, ["claude"]);
	assert.ok(existsSync(path.join(HOME, ".claude", "CLAUDE.md")));
});

test("target changes refuse to replace a corrupt config (bytes preserved)", async () => {
	resetConfig();
	mkdirSync(path.join(HOME, ".agents"), { recursive: true });
	const raw = "{ broken json";
	writeFileSync(configFile(), raw);
	const h = harness();
	await assert.rejects(
		() => runTarget(h, ["enable", "claude", "--global"], PROJ_A),
	);
	assert.match(h.failed, /config\.json is corrupt/i);
	assert.equal(readFileSync(configFile(), "utf8"), raw);
});
