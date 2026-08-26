// test/workflow-seed.test.js — WORKFLOW.md is a first-class brain file
// (IDENTITY_FILES entry 8), so `agent-cli init` and `agent-cli project init`
// must SEED it the same way they seed SOUL.md / LESSONS.md / ENVIRONMENTS.md:
// created when absent, never overwritten when present.
//
// The whole suite is driven through the real CLI as a subprocess so the wiring
// in src/commands/bootstrap.js and src/commands/session-cmds.js is exercised
// end-to-end. Every filesystem effect is confined to fresh mkdtemp dirs: the
// child's HOME / USERPROFILE / AGENT_CLI_HOME all point at a throwaway sandbox
// home, so the developer's real ~/.agents is never touched.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli.js");

/** mkdtemp + realpath — the child's process.cwd() is the real path, so paths we
 *  compute here must be too (macOS /var→/private/var, Windows 8.3 short names). */
function tmpDir(prefix) {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// util.js resolves HOME from AGENT_CLI_HOME at module load, so this must be set
// BEFORE importing anything from src/.
const SANDBOX_HOME = tmpDir("agent-workflow-seed-home-");
process.env.AGENT_CLI_HOME = SANDBOX_HOME;

const arc = await import("../src/archetypes.js");
const { IDENTITY_FILES } = await import("../src/agents-lib.js");

/** Run the real CLI with a fully sandboxed environment. */
function runCli(args, { home = tmpDir("agent-workflow-seed-"), cwd } = {}) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		cwd: cwd || home,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			AGENT_CLI_HOME: home,
			AGENT_OFFLINE: "1",
			AGENT_CLI_NO_UPDATE_CHECK: "1",
		},
	});
	return {
		status: r.status,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		home,
	};
}

function parseJson(s) {
	try {
		return JSON.parse(s);
	} catch (e) {
		assert.fail(`expected valid JSON, got: ${e.message}\n---\n${s}`);
	}
}

const globalWorkflow = (home) => path.join(home, ".agents", "WORKFLOW.md");
const projectWorkflow = (cwd) => path.join(cwd, ".agents", "WORKFLOW.md");

// -----------------------------------------------------------------------------
// global scope — `agent-cli init`
// -----------------------------------------------------------------------------

test("init seeds ~/.agents/WORKFLOW.md with the archetype starter", () => {
	const r = runCli(["init", "--json"]);
	assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
	const fp = globalWorkflow(r.home);
	assert.ok(fs.existsSync(fp), "init did not create ~/.agents/WORKFLOW.md");
	assert.equal(fs.readFileSync(fp, "utf8"), arc.workflowContent());
});

test("init reports WORKFLOW.md in steps.identityFiles.created", () => {
	const r = runCli(["init", "--json"]);
	assert.equal(r.status, 0, r.stderr);
	const created = parseJson(r.stdout).data.steps.identityFiles.created;
	assert.ok(
		created.includes("WORKFLOW.md"),
		`WORKFLOW.md missing from created: ${JSON.stringify(created)}`,
	);
});

test("init seeds WORKFLOW.md alongside every other project-overridable brain file", () => {
	// The seeded set must not drift from IDENTITY_FILES: a kind registered
	// there but never seeded shows up as a missing file in brief/doctor.
	// MODELS.md is written by models.writeModelsMd(), AGENTS.md by ensureMaster.
	const r = runCli(["init", "--json"]);
	assert.equal(r.status, 0, r.stderr);
	for (const { file } of IDENTITY_FILES)
		assert.ok(
			fs.existsSync(path.join(r.home, ".agents", file)),
			`init left ${file} unseeded`,
		);
});

test("init NEVER overwrites an existing WORKFLOW.md", () => {
	const home = tmpDir("agent-workflow-seed-keep-");
	fs.mkdirSync(path.join(home, ".agents"), { recursive: true });
	const fp = globalWorkflow(home);
	const mine = "# WORKFLOW.md\n\n### my-recipe\n- **Trigger:** do not clobber me\n";
	fs.writeFileSync(fp, mine);

	const r = runCli(["init", "--json"], { home });
	assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
	assert.equal(
		fs.readFileSync(fp, "utf8"),
		mine,
		"init clobbered a user-authored WORKFLOW.md (seeding must be non-destructive)",
	);
	const steps = parseJson(r.stdout).data.steps.identityFiles;
	assert.ok(
		steps.skipped.includes("WORKFLOW.md"),
		`WORKFLOW.md should be reported skipped, got: ${JSON.stringify(steps)}`,
	);
	assert.ok(!steps.created.includes("WORKFLOW.md"));
});

test("re-running init is idempotent for WORKFLOW.md", () => {
	const first = runCli(["init", "--json"]);
	assert.equal(first.status, 0, first.stderr);
	const seeded = fs.readFileSync(globalWorkflow(first.home), "utf8");

	const second = runCli(["init", "--json"], { home: first.home });
	assert.equal(second.status, 0, second.stderr);
	assert.equal(fs.readFileSync(globalWorkflow(first.home), "utf8"), seeded);
	assert.ok(
		parseJson(second.stdout).data.steps.identityFiles.skipped.includes(
			"WORKFLOW.md",
		),
	);
});

// -----------------------------------------------------------------------------
// project scope — `agent-cli project init`
// -----------------------------------------------------------------------------

test("project init seeds [project]/.agents/WORKFLOW.md", () => {
	const home = runCli(["init"]).home;
	const project = tmpDir("agent-workflow-seed-proj-");
	const r = runCli(["project", "init", "--json"], { home, cwd: project });
	assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
	const fp = projectWorkflow(project);
	assert.ok(fs.existsSync(fp), "project init did not create .agents/WORKFLOW.md");
	assert.equal(fs.readFileSync(fp, "utf8"), arc.workflowContent());
	assert.ok(parseJson(r.stdout).data.created.includes("WORKFLOW.md"));
});

test("project init NEVER overwrites an existing WORKFLOW.md", () => {
	const home = runCli(["init"]).home;
	const project = tmpDir("agent-workflow-seed-projkeep-");
	fs.mkdirSync(path.join(project, ".agents"), { recursive: true });
	const fp = projectWorkflow(project);
	const mine = "# WORKFLOW.md\n\n### project-recipe\n- **Trigger:** keep me\n";
	fs.writeFileSync(fp, mine);

	const r = runCli(["project", "init", "--json"], { home, cwd: project });
	assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
	assert.equal(
		fs.readFileSync(fp, "utf8"),
		mine,
		"project init clobbered a user-authored WORKFLOW.md",
	);
	assert.ok(!parseJson(r.stdout).data.created.includes("WORKFLOW.md"));
});
