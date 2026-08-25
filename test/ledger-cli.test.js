// Integration tests for the `agent-cli ledger` CLI surface (P7).
// Writes a ledger via the lib API (in-process), then spawns the CLI against the
// same AGENT_CLI_HOME to prove the read/clear surface works across processes.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordDispatch } from "../src/dispatch-ledger.js";

const CLI = path.resolve("src/cli.js");

function run(args, { envHome } = {}) {
	const env = { ...process.env, AGENT_OFFLINE: "1" };
	const home = envHome || mkdtempSync(path.join(tmpdir(), "agent-cli-ledger-cli-"));
	env.AGENT_CLI_HOME = home;
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		env,
		cwd: home,
	});
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status, home };
}

/** Parse JSON, failing the test with a clear message on invalid input. */
function parseJson(s) {
	try {
		return JSON.parse(s);
	} catch (e) {
		assert.fail(`expected valid JSON, got: ${e.message}\n---\n${s}`);
	}
}

test("agent-cli ledger --show prints the ledger lines (human mode)", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-cli-ledger-show-"));
	process.env.AGENT_CLI_HOME = home;
	recordDispatch({
		role: "dev",
		task: "write a thing",
		model: "openai/gpt-5",
		status: "succeeded",
		note: "first pass",
	});
	const r = run(["ledger", "--show"], { envHome: home });
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /write a thing/);
	assert.match(r.stdout, /succeeded/);
	assert.match(r.stdout, /openai\/gpt-5/);
});

test("agent-cli ledger --show --json emits parseable entries", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-cli-ledger-json-"));
	process.env.AGENT_CLI_HOME = home;
	recordDispatch({
		role: "qa",
		task: "run the gate",
		model: "zai/glm-5.2",
		status: "failed",
		note: "flaky",
	});
	const r = run(["ledger", "--show", "--json"], { envHome: home });
	assert.equal(r.code, 0, r.stderr);
	const j = parseJson(r.stdout);
	assert.equal(j.command, "ledger");
	assert.equal(j.data.op, "show");
	assert.equal(j.data.count, 1);
	assert.equal(j.data.entries[0].task, "run the gate");
	assert.equal(j.data.entries[0].role, "qa");
	assert.equal(j.data.entries[0].status, "failed");
	assert.equal(j.data.entries[0].note, "flaky");
	assert.equal(j.data.entries[0].model, "zai/glm-5.2");
});

test("agent-cli ledger --clear truncates the ledger", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-cli-ledger-clear-"));
	process.env.AGENT_CLI_HOME = home;
	recordDispatch({ role: "dev", task: "first", model: "m", status: "started" });
	const before = run(["ledger", "--show", "--json"], { envHome: home });
	assert.equal(parseJson(before.stdout).data.count, 1);

	const c = run(["ledger", "--clear", "--json"], { envHome: home });
	assert.equal(c.code, 0, c.stderr);
	assert.equal(parseJson(c.stdout).data.cleared, true);

	const after = run(["ledger", "--show", "--json"], { envHome: home });
	assert.equal(parseJson(after.stdout).data.count, 0);
});

test("agent-cli ledger --help prints usage and exits 0", () => {
	const r = run(["ledger", "--help"]);
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /ledger/);
	assert.match(r.stdout, /--show/);
	assert.match(r.stdout, /--clear/);
});

test("agent-cli ledger with an unknown action errors", () => {
	const r = run(["ledger", "frobnicate", "--json"]);
	assert.notEqual(r.code, 0, r.stderr);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, false);
	assert.match(j.error, /Unknown ledger action/i);
});
