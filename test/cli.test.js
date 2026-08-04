// Integration tests for the CLI entrypoint (src/cli.js) via spawn.
// Focus: error/evil paths (unknown commands, missing args, invalid ids), exit codes,
// and --json contract. Each test gets an isolated AGENT_CLI_HOME.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	writeFileSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.resolve("src/cli.js");

function run(args, { envHome, cwd } = {}) {
	const env = { ...process.env };
	const home = envHome || mkdtempSync(path.join(tmpdir(), "agent-cli-"));
	env.AGENT_CLI_HOME = home;
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		env,
		cwd: cwd || home,
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

test("JSON errors are parseable and non-zero", () => {
	const r = run(["target", "enable", "bogus-target", "--json"]);
	bad(r);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, false);
	assert.match(j.error, /unknown target/i);
});

test("target changes refuse to replace corrupt config", () => {
	const home = run(["init"]).home;
	const fp = path.join(home, ".agents", "config.json");
	writeFileSync(fp, "{ broken json");
	const r = run(["target", "enable", "claude"], { envHome: home });
	bad(r);
	assert.equal(readFileSync(fp, "utf8"), "{ broken json");
	assert.match(r.stderr + r.stdout, /config\.json is corrupt/i);
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

test("init rejects a corrupt master without replacing it", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-corrupt-init-"));
	mkdirSync(path.join(home, ".agents"), { recursive: true });
	const master = path.join(home, ".agents", "AGENTS.md");
	writeFileSync(master, "x");
	const r = run(["init", "--json"], { envHome: home });
	bad(r);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, false);
	assert.equal(readFileSync(master, "utf8"), "x");
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

test("skill status reports the integrated backend", () => {
	const r = run(["skill", "status", "--json"]);
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.backend, "integrated");
	assert.equal(j.source, "integrated");
	assert.equal(j.globalBin, undefined);
});

test("models: set then list + resolve round-trip", () => {
	const r0 = run([
		"models",
		"set",
		"coding-model",
		"openai/gpt-5",
		"--thinking",
		"high",
		"--fallback",
		"zai/glm-5.2",
		"openai/fallback",
	]);
	ok(r0);
	const home = r0.home;
	const list = parseJson(
		run(["models", "list", "--json"], { envHome: home }).stdout,
	);
	assert.ok(list.aliases["coding-model"]);
	assert.equal(list.aliases["coding-model"].model, "openai/gpt-5");
	assert.deepEqual(list.aliases["coding-model"].fallbacks, [
		"zai/glm-5.2",
		"openai/fallback",
	]);
	const res = parseJson(
		run(["models", "resolve", "coding-model", "--json"], { envHome: home })
			.stdout,
	);
	assert.equal(res.resolved.model, "openai/gpt-5");
});

test("models write creates the XML MODELS.md document", () => {
	const home = run(["--json", "models", "write"]).home;
	const j = parseJson(
		run(["--json", "models", "write"], { envHome: home }).stdout,
	);
	assert.equal(j.action, "write");
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

test("lessons show rejects traversal names without disclosing files", () => {
	const home = run(["init"]).home;
	const secret = path.join(home, "secret.md");
	writeFileSync(secret, "TOP-SECRET-CONTENT\n");
	// "../../secret" from <home>/.agents/lessons would land on <home>/secret.md.
	const r = run(["lessons", "show", "../../secret", "-p"], { envHome: home });
	bad(r);
	assert.ok(!r.stdout.includes("TOP-SECRET-CONTENT"));
	assert.ok(!r.stderr.includes("TOP-SECRET-CONTENT"));
	// JSON contract stays parseable and reports the failure.
	const rj = run(["lessons", "show", "../../secret", "-p", "--json"], {
		envHome: home,
	});
	assert.notEqual(rj.code, 0);
	const j = parseJson(rj.stdout);
	assert.equal(j.ok, false);
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

test("spect init is project-only and brief loads the project manifest", () => {
	const home = run(["init"]).home;
	const project = mkdtempSync(path.join(tmpdir(), "agent-spect-project-"));
	const init = run(["--json", "spect", "init"], {
		envHome: home,
		cwd: project,
	});
	ok(init);
	const result = parseJson(init.stdout);
	assert.equal(result.command, "spect");
	assert.ok(result.root.startsWith(project));
	assert.equal(existsSync(path.join(home, ".spect")), false);
	const brief = parseJson(
		run(["brief", "--json"], { envHome: home, cwd: project }).stdout,
	);
	assert.equal(brief.project.spect.initialized, true);
	assert.ok(brief.sessionStart.load.some((f) => f.kind === "spect"));
});

test("brief manifest includes global models and project overrides", () => {
	const home = run(["init"]).home;
	const project = mkdtempSync(path.join(tmpdir(), "agent-cli-project-"));
	mkdirSync(path.join(project, ".agents"), { recursive: true });
	writeFileSync(path.join(project, ".agents", "USER.md"), "# project user\n");
	const j = parseJson(
		run(["brief", "--json"], { envHome: home, cwd: project }).stdout,
	);
	assert.ok(
		j.sessionStart.load.some(
			(f) => f.kind === "models" && f.scope === "global",
		),
	);
	assert.ok(
		j.sessionStart.load.some((f) => f.kind === "user" && f.scope === "global"),
	);
	assert.ok(
		j.sessionStart.load.some((f) => f.kind === "user" && f.scope === "project"),
	);
});

test("brief surfaces lesson summaries in the index", () => {
	const home = run(["init"]).home;
	run(["lessons", "add", "git/global-lesson", "--body", "x"], {
		envHome: home,
	});
	const j = parseJson(run(["brief", "--json"], { envHome: home }).stdout);
	assert.ok(j.lessons.index.some((l) => l.path.endsWith("git/global-lesson")));
});

test("brief loads the LESSONS.md core directly", () => {
	const home = run(["init"]).home;
	writeFileSync(
		path.join(home, ".agents", "LESSONS.md"),
		"# LESSONS.md\n\n## Core\n- critical lesson — `lessons/git/x.md`\n",
	);
	const j = parseJson(run(["brief", "--json"], { envHome: home }).stdout);
	assert.ok(j.lessons.core);
	assert.ok(j.lessons.core.includes("critical lesson"));
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

test("update diff rejects files outside the staged payload", () => {
	const home = run(["init"]).home;
	run(["update", "stage"], { envHome: home });
	const r = run(
		["update", "diff", "0.2.1", "--file", "../../secret.txt", "--json"],
		{
			envHome: home,
		},
	);
	bad(r);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, false);
	assert.match(j.error, /not part of staged update/i);
});

test("consolidate semantic failures exit non-zero in JSON mode", () => {
	const home = run(["init"]).home;
	const r = run(["consolidate", "--json"], { envHome: home });
	bad(r);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, false);
	assert.match(j.reason, /no lessons dir/i);
});

test("update diff on an unknown version errors as JSON", () => {
	const home = run(["init"]).home;
	const r = run(["update", "diff", "9.9.9", "--json"], { envHome: home });
	bad(r);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, false);
	assert.match(j.error, /No staged update/);
});

test("command help advertises the actual AX command surface", () => {
	const update = run(["update", "--help"]);
	const models = run(["models", "--help"]);
	const edit = run(["edit", "--help"]);
	ok(update);
	ok(models);
	ok(edit);
	assert.match(update.stdout, /diff <version>/);
	assert.match(models.stdout, /global .*MODELS\.md/i);
	assert.match(edit.stdout, /environments/);
});

test("update diff reports no differences without dumping files", () => {
	const home = run(["init"]).home;
	run(["update", "stage"], { envHome: home });
	const list = parseJson(
		run(["update", "list", "--json"], { envHome: home }).stdout,
	);
	const ver = list.staged[0].version;
	const staged = readFileSync(
		path.join(home, ".agents", `update-${ver}`, "agents", "scout.md"),
		"utf8",
	);
	writeFileSync(path.join(home, ".agents", "agents", "scout.md"), staged);
	const j = parseJson(
		run(["update", "diff", ver, "--file", "agents/scout.md", "--json"], {
			envHome: home,
		}).stdout,
	);
	assert.equal(j.diffs.length, 1);
	assert.ok(
		!j.diffs[0].diff
			.split("\n")
			.some((line) => line.startsWith("+") || line.startsWith("-")),
	);
});

test("status summarizes targets by default and --all expands the catalog", () => {
	const home = run(["init"]).home;
	const summary = parseJson(
		run(["status", "--json"], { envHome: home }).stdout,
	);
	const full = parseJson(
		run(["status", "--all", "--json"], { envHome: home }).stdout,
	);
	assert.equal(summary.all, false);
	assert.equal(full.all, true);
	assert.equal(full.targets.length, full.targetCount);
	assert.ok(summary.targets.length <= full.targets.length);
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

test("F1 init seeds the full identity/memory file set", () => {
	const home = run(["init"]).home;
	for (const f of [
		"IDENTITY.md",
		"SOUL.md",
		"USER.md",
		"LESSONS.md",
		"ENVIRONMENTS.md",
		"MODELS.md",
	]) {
		assert.ok(
			existsSync(path.join(home, ".agents", f)),
			f + " should exist after init",
		);
	}
});

test("F1 init is non-destructive (skips existing files)", () => {
	const home = run(["init"]).home;
	writeFileSync(path.join(home, ".agents", "IDENTITY.md"), "USER OWNED\n");
	run(["init", "--json"], { envHome: home });
	assert.equal(
		readFileSync(path.join(home, ".agents", "IDENTITY.md"), "utf8"),
		"USER OWNED\n",
	);
});

test("F1 doctor flags missing required files", () => {
	const home = run(["init"]).home;
	unlinkSync(path.join(home, ".agents", "SOUL.md"));
	unlinkSync(path.join(home, ".agents", "MODELS.md"));
	const r = run(["doctor", "--json"], { envHome: home });
	// doctor exits 2 when issues exist; parse either way
	const j = parseJson(r.stdout);
	assert.ok(j.issues.some((i) => i.includes("SOUL")));
	assert.ok(j.issues.some((i) => i.includes("MODELS.md")));
	assert.ok(j.checks.some((c) => c.check === "file-exists:soul" && !c.ok));
	assert.ok(j.checks.some((c) => c.check === "file-exists:models" && !c.ok));
});

// ---------------------------------------------------------------------------
// Findings 11-CLI / 12 / 13 — CLI JSON/UX + agent-experience regressions
// ---------------------------------------------------------------------------

test("commander parse errors honor --json", () => {
	const r = run(["frobnicate", "--json"]);
	bad(r);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, false);
	assert.ok(j.error);
});

test("edit --print-path --json emits exactly one JSON value and creates no file", () => {
	const r = run(["edit", "identity", "--print-path", "--json"]); // fresh home
	ok(r);
	const home = r.home;
	// parseJson fails the test if stdout is not exactly one JSON value.
	const j = parseJson(r.stdout);
	assert.equal(j.command, "edit");
	assert.equal(j.kind, "identity");
	assert.equal(j.printPath, true);
	assert.equal(j.path, path.join(home, ".agents", "IDENTITY.md"));
	// --print-path must NOT create the file.
	assert.equal(existsSync(path.join(home, ".agents", "IDENTITY.md")), false);
});

test("edit agents --project resolves the project master, not the global master", () => {
	const home = run(["init"]).home;
	const project = mkdtempSync(path.join(tmpdir(), "agent-proj-master-"));
	mkdirSync(path.join(project, ".agents"), { recursive: true });
	const r = run(["edit", "agents", "--project", "--print-path", "--json"], {
		envHome: home,
		cwd: project,
	});
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.path, path.join(project, ".agents", "AGENTS.md"));
});

test("editor process failure returns a non-zero exit", () => {
	const prev = process.env.VISUAL;
	process.env.VISUAL = "definitely-not-a-real-editor-xyz-12345";
	try {
		bad(run(["edit"]));
	} finally {
		if (prev === undefined) delete process.env.VISUAL;
		else process.env.VISUAL = prev;
	}
});

test("edit help does not advertise unsupported edit models", () => {
	const edit = run(["edit", "--help"]);
	ok(edit);
	assert.ok(!/models/i.test(edit.stdout));
});

test("identity/soul apply with unknown keys reports fallback in JSON, rejects in prose", () => {
	const home = run(["init"]).home;
	const ji = parseJson(
		run(["identity", "apply", "no-such-identity", "--json"], {
			envHome: home,
		}).stdout,
	);
	assert.equal(ji.fallback, true);
	assert.equal(ji.resolved, "general-purpose");
	const js = parseJson(
		run(["soul", "apply", "no-such-soul", "--json"], { envHome: home })
			.stdout,
	);
	assert.equal(js.fallback, true);
	assert.ok(js.resolved);
	bad(run(["identity", "apply", "no-such-identity"], { envHome: home }));
	bad(run(["soul", "apply", "no-such-soul"], { envHome: home }));
});

test("user apply refuses to replace a non-empty USER.md without --force", () => {
	const home = run(["init"]).home;
	writeFileSync(path.join(home, ".agents", "USER.md"), "# USER.md\n\nkeep me\n");
	bad(run(["user", "apply"], { envHome: home }));
	assert.equal(
		readFileSync(path.join(home, ".agents", "USER.md"), "utf8"),
		"# USER.md\n\nkeep me\n",
	);
	ok(run(["user", "apply", "--force"], { envHome: home }));
});

test("agents validate returns machine-actionable failure for invalid or missing personalities", () => {
	const home = run(["init"]).home;
	parseJson(
		run(["agents", "new", "tester", "--json"], { envHome: home }).stdout,
	);
	const v = run(["agents", "validate", "tester", "--json"], { envHome: home });
	bad(v); // fresh scaffold has placeholders → invalid → non-zero
	const j = parseJson(v.stdout);
	assert.equal(j.command, "agents");
	assert.equal(j.valid, false);
	assert.ok(
		j.results.some((r) => r.name === "tester" && r.valid === false),
	);
	const m = run(["agents", "validate", "no-such-agent", "--json"], {
		envHome: home,
	});
	bad(m);
	const jm = parseJson(m.stdout);
	assert.equal(jm.missing, "no-such-agent");
	assert.equal(jm.valid, false);
});

test("update stage before init does not suppress default personality installation", () => {
	const first = run(["update", "stage"]);
	ok(first);
	const home = first.home; // fresh home: no init yet
	const j = parseJson(run(["init", "--json"], { envHome: home }).stdout);
	assert.ok(j.steps.seeds);
	assert.ok(j.steps.seeds.installed.length >= 4);
});

test("brief surfaces unresolved model aliases with actionable guidance", () => {
	const home = run(["init"]).home;
	const agentsDir = path.join(home, ".agents", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		path.join(agentsDir, "badmodel.md"),
		[
			"---",
			"name: badmodel",
			"description: test agent",
			"model: no-such-alias",
			"---",
			"## Delegation identity",
			"d",
			"## Goal",
			"g",
			"## Orchestrator contract",
			"o",
			"## Role",
			"r",
			"## When to use",
			"w",
			"## Requires",
			"req",
			"## Output style & format",
			"o",
			"## Constraints",
			"c",
			"## Handoff",
			"h",
		].join("\n"),
	);
	const j = parseJson(run(["brief", "--json"], { envHome: home }).stdout);
	assert.ok(j.modelAliases);
	const u = j.modelAliases.unresolved || [];
	const hit = u.find((x) => x.name === "badmodel");
	assert.ok(hit);
	assert.match(hit.guidance, /models set/);
});

test("brief prefers project core over global core and includes project lessons", () => {
	const home = run(["init"]).home;
	const project = mkdtempSync(path.join(tmpdir(), "agent-brief-proj-"));
	mkdirSync(path.join(project, ".agents"), { recursive: true });
	writeFileSync(
		path.join(home, ".agents", "LESSONS.md"),
		"# LESSONS.md\n\n## Core\nGLOBAL-CORE-MARKER\n",
	);
	writeFileSync(
		path.join(project, ".agents", "LESSONS.md"),
		"# LESSONS.md\n\n## Core\nPROJECT-CORE-MARKER\n",
	);
	const lessonsDir = path.join(project, ".agents", "lessons", "git");
	mkdirSync(lessonsDir, { recursive: true });
	writeFileSync(
		path.join(lessonsDir, "proj.md"),
		"---\noccurrences: 1\n---\nbody\n",
	);
	const j = parseJson(
		run(["brief", "--json"], { envHome: home, cwd: project }).stdout,
	);
	assert.equal(j.lessons.coreScope, "project");
	assert.ok(j.lessons.core.includes("PROJECT-CORE-MARKER"));
	assert.ok(
		j.lessons.index.some(
			(l) => l.path.endsWith("git/proj") && l.scope === "project",
		),
	);
});

test("init --no-skill suppresses the skill-cli block in the master", () => {
	const withSkill = run(["init"]).home;
	const masterWith = readFileSync(
		path.join(withSkill, ".agents", "AGENTS.md"),
		"utf8",
	);
	assert.match(masterWith, /BEGIN skill-cli/);
	const noSkill = run(["init", "--no-skill"]).home;
	const masterNo = readFileSync(
		path.join(noSkill, ".agents", "AGENTS.md"),
		"utf8",
	);
	assert.ok(!/BEGIN skill-cli/.test(masterNo));
});

test("skill passthrough emits a JSON envelope in --json mode", () => {
	const r = run(["skill", "list", "--json"]);
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.command, "skill");
	assert.equal(j.passthrough, true);
	assert.equal(j.args[0], "list");
	assert.equal(typeof j.code, "number");
});
