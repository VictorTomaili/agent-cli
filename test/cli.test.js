// Integration tests for the CLI entrypoint (src/cli.js) via spawn.
// Focus: error/evil paths (unknown commands, missing args, invalid ids), exit codes,
// and --json contract. Each test gets an isolated AGENT_CLI_HOME.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.resolve("src/cli.js");

function run(args, { envHome } = {}) {
	const env = { ...process.env };
	const home = envHome || mkdtempSync(path.join(tmpdir(), "agent-cli-"));
	env.AGENT_CLI_HOME = home;
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		env,
		cwd: home,
	});
	return {
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		code: r.status,
		home,
	};
}

/** Parse JSON, failing the test with a clear message on invalid input. */
function parseJson(s) {
	try {
		return JSON.parse(s);
	} catch (e) {
		assert.fail(`expected valid JSON, got: ${e.message}\n---\n${s}`);
	}
}

const ok = (r) =>
	assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
const bad = (r) =>
	assert.notEqual(r.code, 0, `expected non-zero exit, got ${r.code}`);

test("--version prints a semver string", () => {
	const r = run(["--version"]);
	ok(r);
	assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("unknown command is rejected with a non-zero exit", () => {
	const r = run(["frobnicate"]);
	bad(r);
});

test("--json on status emits valid JSON", () => {
	const r = run(["status", "--json"]);
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.command, "status");
});

test("--json on targets emits valid JSON with the catalog", () => {
	const r = run(["targets", "--json"]);
	ok(r);
	const j = parseJson(r.stdout);
	assert.ok(j.targets.length >= 8);
});

test("target enable with an unknown id errors (exit 1)", () => {
	const r = run(["target", "enable", "bogus-target"]);
	bad(r);
	assert.match(r.stderr + r.stdout, /unknown target/i);
});

test("target enable with no action/id errors", () => {
	const r = run(["target"]);
	bad(r);
});

test("models set with missing args errors (exit 1)", () => {
	const r = run(["models", "set"]);
	bad(r);
});

test("identity apply with no key errors (exit 1)", () => {
	const r = run(["identity", "apply"]);
	bad(r);
});

test("agents show with no name errors (exit 1)", () => {
	const r = run(["agents", "show"]);
	bad(r);
});

test("agents new with no name errors (exit 1)", () => {
	const r = run(["agents", "new"]);
	bad(r);
});

test("pull with an unknown target errors (exit 1)", () => {
	const r = run(["pull", "bogus"]);
	bad(r);
});

test("update clear without a version errors (exit 1)", () => {
	const r = run(["update", "clear"]);
	bad(r);
});

test("update with an unknown action errors (exit 1)", () => {
	const r = run(["update", "frobnicate"]);
	bad(r);
});

test("init in a fresh home succeeds and reports the step", () => {
	const r = run(["init", "--json"]);
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.command, "init");
	assert.ok(j.steps && j.steps.master);
});

test("init seeds the default personalities into the fresh home", () => {
	const r = run(["init", "--json"]);
	ok(r);
	const j = parseJson(r.stdout);
	assert.ok(j.steps.seeds);
	assert.ok(j.steps.seeds.installed.length >= 4);
});

test("brief --json after init is valid JSON with the expected shape", () => {
	const home = run(["init"]).home;
	const r = run(["brief", "--json"], { envHome: home });
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.tool, "agent-cli");
	assert.ok(j.master);
	assert.ok(j.onboarding);
	assert.ok(j.update);
});

test("doctor --json after init surfaces issues (unfilled identity/lessons)", () => {
	const home = run(["init"]).home;
	const r = run(["doctor", "--json"], { envHome: home });
	// doctor exits 2 when issues exist — parse the JSON either way
	const j = parseJson(r.stdout);
	assert.equal(j.command, "doctor");
	assert.ok(Array.isArray(j.issues));
});

test("identity apply + set round-trip clears the identity gap", () => {
	const home = run(["init"]).home;
	run(["identity", "apply", "general-purpose", "--soul", "pragmatist"], {
		envHome: home,
	});
	run(["identity", "set", "AGENT_NAME", "Marvin"], { envHome: home });
	const r = run(["brief", "--json"], { envHome: home });
	ok(r);
	const j = parseJson(r.stdout);
	assert.deepEqual(j.onboarding.gaps.identity || [], []);
});
