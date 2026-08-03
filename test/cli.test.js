// Integration tests for the CLI entrypoint (src/cli.js) via spawn.
// Focus: error/evil paths (unknown commands, missing args, invalid ids), exit codes,
// and --json contract. Each test gets an isolated AGENT_CLI_HOME.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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

test("models: set then list + resolve round-trip", () => {
	const r0 = run([
		"models",
		"set",
		"coding-model",
		"openai/gpt-5",
		"--thinking",
		"high",
	]);
	ok(r0);
	const home = r0.home;
	const list = parseJson(
		run(["models", "list", "--json"], { envHome: home }).stdout,
	);
	assert.ok(list.aliases["coding-model"]);
	assert.equal(list.aliases["coding-model"].model, "openai/gpt-5");
	const res = parseJson(
		run(["models", "resolve", "coding-model", "--json"], { envHome: home })
			.stdout,
	);
	assert.equal(res.resolved.model, "openai/gpt-5");
});

test("models seed writes the default aliases", () => {
	const j = parseJson(run(["models", "seed", "--json"]).stdout);
	assert.ok(Object.keys(j.aliases).length >= 6);
});

test("agents: new scaffolds, list shows it, validate flags placeholders", () => {
	const home = run(["init"]).home;
	const newr = parseJson(
		run(["agents", "new", "tester", "--json"], { envHome: home }).stdout,
	);
	assert.equal(newr.created, true);
	const list = parseJson(
		run(["agents", "list", "--json"], { envHome: home }).stdout,
	);
	assert.ok(list.agents.some((a) => a.name === "tester"));
	const v = parseJson(
		run(["agents", "validate", "tester", "--json"], { envHome: home }).stdout,
	);
	const t = v.results.find((x) => x.name === "tester");
	assert.ok(t);
	assert.equal(t.valid, false); // fresh scaffold has placeholders
});

test("agents show for an unknown name errors (exit 1)", () => {
	bad(run(["agents", "show", "nope"]));
});

test("lessons: add then list + show round-trip", () => {
	const home = run(["init"]).home;
	run(["lessons", "add", "git/test-lesson", "--body", "lesson body", "-p"], {
		envHome: home,
	});
	const list = parseJson(
		run(["lessons", "list", "--json"], { envHome: home }).stdout,
	);
	assert.ok(list.lessons.some((l) => l.path.endsWith("git/test-lesson")));
	const show = run(["lessons", "show", "git/test-lesson", "-p"], {
		envHome: home,
	});
	ok(show);
	assert.ok(show.stdout.includes("lesson body"));
});

test("lessons show for a missing lesson errors (exit 1)", () => {
	const home = run(["init"]).home;
	bad(run(["lessons", "show", "nope/missing", "-p"], { envHome: home }));
});

test("update: stage then list + clear round-trip", () => {
	const home = run(["init"]).home;
	const stage = parseJson(
		run(["update", "stage", "--json"], { envHome: home }).stdout,
	);
	assert.ok(stage.staged.length >= 1);
	const list = parseJson(
		run(["update", "list", "--json"], { envHome: home }).stdout,
	);
	assert.ok(list.staged.length >= 1);
	const ver = list.staged[0].version;
	ok(run(["update", "clear", ver, "--json"], { envHome: home }));
	const after = parseJson(
		run(["update", "list", "--json"], { envHome: home }).stdout,
	);
	assert.equal(after.staged.length, 0);
});

test("brief --json includes sessionStart.load + lessons (index + inbox)", () => {
	const home = run(["init"]).home;
	const j = parseJson(run(["brief", "--json"], { envHome: home }).stdout);
	assert.ok(Array.isArray(j.sessionStart.load));
	assert.ok(j.sessionStart.load.some((f) => f.kind === "identity"));
	assert.ok(j.lessons);
	assert.equal(typeof j.lessons.inbox, "number");
	assert.ok(Array.isArray(j.lessons.index));
});

test("brief surfaces lesson summaries in the index", () => {
	const home = run(["init"]).home;
	run(["lessons", "add", "git/global-lesson", "--body", "x"], { envHome: home });
	const j = parseJson(run(["brief", "--json"], { envHome: home }).stdout);
	assert.ok(
		j.lessons.index.some((l) => l.path.endsWith("git/global-lesson")),
	);
});

test("user: apply writes USER.md; set goals succeeds; bad inputs error", () => {
	const r0 = run(["user", "apply"]);
	ok(r0);
	const home = r0.home;
	ok(run(["user", "set", "goals", "ship it"], { envHome: home }));
	bad(run(["user", "set"], { envHome: home }));
	bad(run(["user", "bogus-action"], { envHome: home }));
});

test("update diff shows staged-vs-live changes", () => {
	const home = run(["init"]).home;
	run(["update", "stage"], { envHome: home });
	const ver = parseJson(
		run(["update", "list", "--json"], { envHome: home }).stdout,
	).staged[0].version;
	// mutate the live file so the diff is non-empty
	writeFileSync(
		path.join(home, ".agents", "agents", "scout.md"),
		"# changed by user\n",
	);
	const r = run(["update", "diff", ver, "--json"], { envHome: home });
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.action, "diff");
	const scout = j.diffs.find((d) => d.rel.includes("scout.md"));
	assert.ok(scout);
	assert.ok(scout.diff.includes("-# changed by user"));
	assert.ok(scout.diff.includes("+")); // staged content appears as additions
});

test("update diff on an unknown version errors (exit 1)", () => {
	const home = run(["init"]).home;
	bad(run(["update", "diff", "9.9.9"], { envHome: home }));
});

test("lessons inbox --clear removes all captures", () => {
	const home = run(["init"]).home;
	const inboxDir = path.join(home, ".agents", "lessons", ".inbox");
	mkdirSync(inboxDir, { recursive: true });
	writeFileSync(path.join(inboxDir, "a.md"), "raw");
	writeFileSync(path.join(inboxDir, "b.md"), "raw");
	const r = run(["lessons", "inbox", "--clear", "--json"], { envHome: home });
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.op, "clear");
	assert.ok(j.deleted >= 2);
});
