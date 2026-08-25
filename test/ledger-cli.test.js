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

test("agent-cli ledger --handoff <taskId> assembles a per-task handoff doc (P8)", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-cli-ledger-handoff-"));
	process.env.AGENT_CLI_HOME = home;
	// Dependencies are discovered from the task's ledger `note` (JSON dependsOn).
	recordDispatch({
		role: "dev",
		task: "P1",
		model: "openai/gpt-5",
		status: "succeeded",
		note: "built the parser",
	});
	recordDispatch({
		role: "qa",
		task: "P2",
		model: "zai/glm-5.2",
		status: "succeeded",
		note: "gate green",
	});
	recordDispatch({
		role: "orchestrator",
		task: "T",
		model: "unknown",
		status: "started",
		note: JSON.stringify({ dependsOn: ["P1", "P2"] }),
	});

	const r = run(["ledger", "--handoff", "T", "--json"], { envHome: home });
	assert.equal(r.code, 0, r.stderr);
	const j = parseJson(r.stdout);
	assert.equal(j.command, "ledger");
	assert.equal(j.data.op, "handoff");
	assert.equal(j.data.taskId, "T");
	assert.equal(j.data.ok, true);
	assert.match(j.data.artifactPath, /T-from-P1\.md$/);

	const content = j.data.content;
	assert.match(content, /# Handoff for T/);
	assert.match(content, /^session: /m);
	assert.match(content, /predecessors: \[P1, P2\],/);
	assert.match(content, /## P1/);
	assert.match(content, /- role: dev/);
	assert.match(content, /- status: succeeded/);
	assert.match(content, /- summary: built the parser/);
	assert.match(content, /- ledger line: \{/);
	assert.match(content, /built the parser/);
	assert.match(content, /## P2/);
	assert.match(content, /- summary: gate green/);
});

test("agent-cli ledger --handoff <taskId> errors when a required predecessor is missing", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-cli-ledger-handoff-missing-"));
	process.env.AGENT_CLI_HOME = home;
	recordDispatch({
		role: "orchestrator",
		task: "T",
		model: "unknown",
		status: "started",
		note: JSON.stringify({ dependsOn: ["P1", "P2"] }),
	});

	const r = run(["ledger", "--handoff", "T", "--json"], { envHome: home });
	assert.notEqual(r.code, 0, r.stderr);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, false);
	assert.match(j.error, /no ledger record for predecessor P1/);
});

// --- Write surface: start / record / end ------------------------------------
// This is the half P7 was missing. `recordDispatch` was library-only, so an LLM
// orchestrator — whose only route in is Bash — could never write a ledger line,
// and P6's harness aggregated an empty file.

test("ledger record across SEPARATE processes lands in ONE ledger after ledger start", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-cli-ledger-session-"));
	const started = parseJson(run(["--json", "ledger", "start"], { envHome: home }).stdout);
	assert.equal(started.ok, true);
	const session = started.data.session;
	assert.ok(session, "ledger start must report the session id");

	// Three independent CLI invocations — each its own node process.
	for (const [role, task, status] of [
		["backend-dev", "T1", "succeeded"],
		["qa-engineer", "T2", "succeeded"],
		["security", "T3", "failed"],
	]) {
		const r = run(
			["--json", "ledger", "record", "--role", role, "--task", task, "--status", status],
			{ envHome: home },
		);
		const parsed = parseJson(r.stdout);
		assert.equal(parsed.ok, true, `record failed for ${task}: ${r.stderr}`);
		assert.equal(
			parsed.data.session,
			session,
			`${task} landed in a different session — the pin is not shared across processes`,
		);
	}

	const shown = parseJson(run(["--json", "ledger", "show"], { envHome: home }).stdout);
	assert.equal(shown.data.count, 3, "all three dispatches must be in one ledger");
	assert.deepEqual(
		shown.data.entries.map((e) => e.task),
		["T1", "T2", "T3"],
	);
});

test("ledger record defaults to a terminal status (one line per finished dispatch)", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-cli-ledger-terminal-"));
	run(["ledger", "start"], { envHome: home });
	const parsed = parseJson(
		run(["--json", "ledger", "record", "--role", "dev", "--task", "T1"], {
			envHome: home,
		}).stdout,
	);
	// `started` would inflate summarizeSession's per-line `runs` without ever
	// counting toward the success rate, so the default must be terminal.
	assert.equal(parsed.data.entry.status, "succeeded");
});

test("ledger record rejects a bad --status instead of coercing it to failed", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-cli-ledger-badstatus-"));
	const r = run(
		["ledger", "record", "--role", "dev", "--task", "T1", "--status", "done"],
		{ envHome: home },
	);
	assert.notEqual(r.code, 0, "a typo'd status must fail loudly");
	assert.match(r.stdout + r.stderr, /Unknown status/);
});

test("ledger record requires --role and --task", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-cli-ledger-required-"));
	const r = run(["ledger", "record", "--role", "dev"], { envHome: home });
	assert.notEqual(r.code, 0);
	assert.match(r.stdout + r.stderr, /requires --role and --task/);
});

test("--session overrides the pin, and ledger end unpins", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-cli-ledger-override-"));
	const pinned = parseJson(run(["--json", "ledger", "start"], { envHome: home }).stdout)
		.data.session;

	// An explicit --session must not land in the pinned ledger.
	run(
		["ledger", "record", "--role", "dev", "--task", "OTHER", "--session", "other-run"],
		{ envHome: home },
	);
	const pinnedLedger = parseJson(
		run(["--json", "ledger", "show"], { envHome: home }).stdout,
	);
	assert.equal(pinnedLedger.data.count, 0, "the override leaked into the pinned session");

	const other = parseJson(
		run(["--json", "ledger", "show", "--session", "other-run"], { envHome: home }).stdout,
	);
	assert.equal(other.data.count, 1);
	assert.equal(other.data.entries[0].task, "OTHER");

	const ended = parseJson(run(["--json", "ledger", "end"], { envHome: home }).stdout);
	assert.equal(ended.data.session, pinned);
	assert.equal(ended.data.cleared, true);
});

test("a traversal --session cannot write outside the .logs dir", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-cli-ledger-trav-"));
	const parsed = parseJson(
		run(
			[
				"--json", "ledger", "record",
				"--role", "dev", "--task", "T1",
				"--session", "../../escape",
			],
			{ envHome: home },
		).stdout,
	);
	assert.ok(
		!String(parsed.data.session).includes("..") &&
			!String(parsed.data.session).includes("/"),
		`session id must be folded to one safe segment, got ${parsed.data.session}`,
	);
});
