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
	assert.equal(j.ok, true);
	assert.equal(j.apiVersion, "2.0.0");
	assert.ok(j.data.targets.length >= 8);
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
	assert.ok(j.data.steps && j.data.steps.master);
});

test("init rejects a corrupt master without replacing it", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-corrupt-init-"));
	mkdirSync(path.join(home, ".agents"), { recursive: true });
	const master = path.join(home, "AGENTS.md");
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
	assert.ok(j.data.steps.seeds);
	assert.ok(j.data.steps.seeds.installed.length >= 4);
});

test("brief --json after init is valid JSON with the expected shape", () => {
	const home = run(["init"]).home;
	const r = run(["brief", "--json"], { envHome: home });
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.data.tool, "agent-cli");
	assert.equal(j.data.schemaVersion, "1.1.0");
	assert.ok(j.data.master);
	assert.ok(j.data.onboarding);
	assert.ok(j.data.update);
});

test("doctor --json after init surfaces issues (unfilled identity/lessons)", () => {
	const home = run(["init"]).home;
	const r = run(["doctor", "--json"], { envHome: home });
	// doctor exits 2 when issues exist — parse the JSON either way
	const j = parseJson(r.stdout);
	assert.equal(j.command, "doctor");
	assert.equal(j.ok, true); // the diagnostic ran; findings are data + exit 2
	assert.ok(Array.isArray(j.data.issues));
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
	assert.deepEqual(j.data.onboarding.gaps.identity || [], []);
});

test("skill status reports the integrated backend", () => {
	const r = run(["skill", "status", "--json"]);
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.data.backend, "integrated");
	assert.equal(j.data.source, "integrated");
	assert.equal(j.data.globalBin, undefined);
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
	assert.ok(list.data.aliases["coding-model"]);
	assert.equal(list.data.aliases["coding-model"].model, "openai/gpt-5");
	assert.deepEqual(list.data.aliases["coding-model"].fallbacks, [
		"zai/glm-5.2",
		"openai/fallback",
	]);
	const res = parseJson(
		run(["models", "resolve", "coding-model", "--json"], { envHome: home })
			.stdout,
	);
	assert.equal(res.data.resolved.model, "openai/gpt-5");
});

test("models write creates the XML MODELS.md document", () => {
	const home = run(["--json", "models", "write"]).home;
	const j = parseJson(
		run(["--json", "models", "write"], { envHome: home }).stdout,
	);
	assert.equal(j.data.action, "write");
});

test("agents: new scaffolds, list shows it, validate flags placeholders", () => {
	const home = run(["init"]).home;
	const newr = parseJson(
		run(["agents", "new", "tester", "--json"], { envHome: home }).stdout,
	);
	assert.equal(newr.data.created, true);
	const list = parseJson(
		run(["agents", "list", "--json"], { envHome: home }).stdout,
	);
	assert.ok(list.data.agents.some((a) => a.name === "tester"));
	const v = parseJson(
		run(["agents", "validate", "tester", "--json"], { envHome: home }).stdout,
	);
	const t = v.data.results.find((x) => x.name === "tester");
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
	assert.ok(list.data.lessons.some((l) => l.path.endsWith("git/test-lesson")));
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
	assert.ok(stage.data.staged.length >= 1);
	const list = parseJson(
		run(["update", "list", "--json"], { envHome: home }).stdout,
	);
	assert.ok(list.data.staged.length >= 1);
	const ver = list.data.staged[0].version;
	ok(run(["update", "clear", ver, "--json"], { envHome: home }));
	const after = parseJson(
		run(["update", "list", "--json"], { envHome: home }).stdout,
	);
	assert.equal(after.data.staged.length, 0);
});

test("brief --json includes sessionStart.load + lessons (index + inbox)", () => {
	const home = run(["init"]).home;
	const j = parseJson(run(["brief", "--json"], { envHome: home }).stdout);
	assert.ok(Array.isArray(j.data.sessionStart.load));
	assert.ok(j.data.sessionStart.load.some((f) => f.kind === "identity"));
	assert.ok(j.data.lessons);
	assert.equal(typeof j.data.lessons.inbox, "number");
	assert.ok(Array.isArray(j.data.lessons.index));
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
	assert.ok(result.data.root.startsWith(project));
	assert.equal(existsSync(path.join(home, ".spect")), false);
	const brief = parseJson(
		run(["brief", "--json"], { envHome: home, cwd: project }).stdout,
	);
	assert.equal(brief.data.project.spect.initialized, true);
	assert.ok(brief.data.sessionStart.load.some((f) => f.kind === "spect"));
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
		j.data.sessionStart.load.some(
			(f) => f.kind === "models" && f.scope === "global",
		),
	);
	assert.ok(
		j.data.sessionStart.load.some(
			(f) => f.kind === "user" && f.scope === "global",
		),
	);
	assert.ok(
		j.data.sessionStart.load.some(
			(f) => f.kind === "user" && f.scope === "project",
		),
	);
});

test("brief surfaces lesson summaries in the index", () => {
	const home = run(["init"]).home;
	run(["lessons", "add", "git/global-lesson", "--body", "x"], {
		envHome: home,
	});
	const j = parseJson(run(["brief", "--json"], { envHome: home }).stdout);
	assert.ok(
		j.data.lessons.index.some((l) => l.path.endsWith("git/global-lesson")),
	);
});

test("brief loads the LESSONS.md core directly", () => {
	const home = run(["init"]).home;
	writeFileSync(
		path.join(home, ".agents", "LESSONS.md"),
		"# LESSONS.md\n\n## Core\n- critical lesson — `lessons/git/x.md`\n",
	);
	const j = parseJson(run(["brief", "--json"], { envHome: home }).stdout);
	assert.ok(j.data.lessons.core);
	assert.ok(j.data.lessons.core.includes("critical lesson"));
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
	).data.staged[0].version;
	// mutate the live file so the diff is non-empty
	writeFileSync(
		path.join(home, ".agents", "agents", "scout.md"),
		"# changed by user\n",
	);
	const r = run(["update", "diff", ver, "--json"], { envHome: home });
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.data.action, "diff");
	const scout = j.data.diffs.find((d) => d.rel.includes("scout.md"));
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

test("consolidate with no lessons dir is a healthy no-op (exit 0)", () => {
	const home = run(["init"]).home;
	const r = run(["consolidate", "--json"], { envHome: home });
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, true);
	assert.equal(j.data.nothingToDo, true);
	assert.match(j.data.reason, /no lessons dir/i);
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
	const ver = list.data.staged[0].version;
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
	assert.equal(j.data.diffs.length, 1);
	assert.ok(
		!j.data.diffs[0].diff
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
	assert.equal(summary.data.all, false);
	assert.equal(full.data.all, true);
	assert.equal(full.data.targets.length, full.data.targetCount);
	assert.ok(summary.data.targets.length <= full.data.targets.length);
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
	assert.equal(j.data.op, "clear");
	assert.ok(j.data.deleted >= 2);
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
	assert.ok(j.data.issues.some((i) => i.includes("SOUL")));
	assert.ok(j.data.issues.some((i) => i.includes("MODELS.md")));
	assert.ok(
		j.data.checks.some((c) => c.check === "file-exists:soul" && !c.ok),
	);
	assert.ok(
		j.data.checks.some((c) => c.check === "file-exists:models" && !c.ok),
	);
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
	assert.equal(j.data.kind, "identity");
	assert.equal(j.data.printPath, true);
	assert.equal(j.data.path, path.join(home, ".agents", "IDENTITY.md"));
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
	assert.equal(j.data.path, path.join(project, ".agents", "AGENTS.md"));
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

test("edit help advertises the models kind (supported)", () => {
	const edit = run(["edit", "--help"]);
	ok(edit);
	assert.match(edit.stdout, /models/);
	// and `edit models --print-path` resolves MODELS.md
	const home = run(["init"]).home;
	const j = parseJson(
		run(["edit", "models", "--print-path", "--json"], { envHome: home })
			.stdout,
	);
	assert.ok(j.data.path.endsWith("MODELS.md"));
});

test("identity/soul apply with unknown keys rejects in BOTH modes unless --fallback", () => {
	const home = run(["init"]).home;
	// unknown id: JSON mode refuses too (behavior parity with prose)
	const ji = run(["identity", "apply", "no-such-identity", "--json"], {
		envHome: home,
	});
	bad(ji);
	const jij = parseJson(ji.stdout);
	assert.equal(jij.ok, false);
	assert.match(jij.error, /Unknown identity/);
	// unknown soul: same parity
	const js = run(["soul", "apply", "no-such-soul", "--json"], {
		envHome: home,
	});
	bad(js);
	assert.equal(parseJson(js.stdout).ok, false);
	// --fallback applies the default archetype in both modes
	const fb = parseJson(
		run(
			["identity", "apply", "no-such-identity", "--fallback", "--json"],
			{ envHome: home },
		).stdout,
	);
	assert.equal(fb.ok, true);
	assert.equal(fb.data.fallback, true);
	assert.equal(fb.data.resolved, "general-purpose");
	ok(run(["identity", "apply", "no-such-identity", "--fallback"], { envHome: home }));
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
	assert.equal(j.data.valid, false);
	assert.ok(
		j.data.results.some((r) => r.name === "tester" && r.valid === false),
	);
	const m = run(["agents", "validate", "no-such-agent", "--json"], {
		envHome: home,
	});
	bad(m);
	const jm = parseJson(m.stdout);
	assert.equal(jm.data.missing, "no-such-agent");
	assert.equal(jm.data.valid, false);
});

test("update stage before init does not suppress default personality installation", () => {
	const first = run(["update", "stage"]);
	ok(first);
	const home = first.home; // fresh home: no init yet
	const j = parseJson(run(["init", "--json"], { envHome: home }).stdout);
	assert.ok(j.data.steps.seeds);
	assert.ok(j.data.steps.seeds.installed.length >= 4);
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
	assert.ok(j.data.modelAliases);
	const u = j.data.modelAliases.unresolved || [];
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
	assert.equal(j.data.lessons.coreScope, "project");
	assert.ok(j.data.lessons.core.includes("PROJECT-CORE-MARKER"));
	assert.ok(
		j.data.lessons.index.some(
			(l) => l.path.endsWith("git/proj") && l.scope === "project",
		),
	);
});

test("init --no-skill suppresses the skill-cli block in the master", () => {
	const withSkill = run(["init"]).home;
	const masterWith = readFileSync(
		path.join(withSkill, "AGENTS.md"),
		"utf8",
	);
	assert.match(masterWith, /BEGIN skill-cli/);
	const noSkill = run(["init", "--no-skill"]).home;
	const masterNo = readFileSync(
		path.join(noSkill, "AGENTS.md"),
		"utf8",
	);
	assert.ok(!/BEGIN skill-cli/.test(masterNo));
});

test("skill passthrough emits a JSON envelope in --json mode", () => {
	const r = run(["skill", "list", "--json"]);
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.command, "skill");
	assert.equal(j.data.passthrough, true);
	assert.equal(j.data.args[0], "list");
	assert.equal(typeof j.data.code, "number");
});

// ---------------------------------------------------------------------------
// Phase 0 — envelope contract, exit codes, help/exit, read-only commands
// ---------------------------------------------------------------------------

test("bare `agent` prints a quick start and exits 0 with no stderr leak", () => {
	const r = run([]);
	assert.equal(r.code, 0);
	assert.match(r.stdout, /agent init/);
	assert.equal(r.stderr, "");
});

test("`agent help` and `agent help <cmd>` exit 0", () => {
	ok(run(["help"]));
	ok(run(["help", "status"]));
	ok(run(["--help"]));
});

test("bare `agent --json` emits a machine-readable manifest", () => {
	const r = run(["--json"]);
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, true);
	assert.equal(j.command, "manifest");
	assert.ok(Array.isArray(j.data.commands));
	assert.equal(j.data.exitCodes.OK, 0);
});

test("every --json payload carries the versioned envelope", () => {
	const home = run(["init"]).home;
	for (const args of [["status"], ["targets"], ["brief"], ["files"]]) {
		const r = run([...args, "--json"], { envHome: home });
		ok(r);
		const j = parseJson(r.stdout);
		assert.equal(j.ok, true, args.join(" "));
		assert.equal(j.apiVersion, "2.0.0", args.join(" "));
		assert.ok(j.data && typeof j.data === "object", args.join(" "));
	}
});

test("no ANSI escape sequences leak into any --json stdout", () => {
	const r = run(["target", "enable", "bogus-target", "--json"]);
	bad(r);
	assert.ok(!r.stdout.includes("\u001b"), "error payload must be plain text");
	const home = run(["init"]).home;
	const s = run(["skill", "list", "--json"], { envHome: home });
	const text = s.stdout;
	assert.ok(
		!text.includes("\u001b") && !text.includes("\\u001b"),
		"skill passthrough payload must be plain text",
	);
});

test("models resolve for a missing alias exits 1 with ok:false", () => {
	const r = run(["models", "resolve", "no-such-alias", "--json"]);
	bad(r);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, false);
	assert.match(j.error, /no such model alias/i);
});

test("link --target <unknown> errors listing known ids", () => {
	const r = run(["link", "--target", "bogus-id", "--json"]);
	bad(r);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, false);
	assert.match(j.error, /unknown target id/i);
});

test("link reports changed/nothingToDo booleans (idempotent second run)", () => {
	const home = run(["init"]).home;
	run(["link"], { envHome: home }); // first run may link or no-op
	// link is idempotent: a second run has nothing left to do.
	const second = parseJson(run(["link", "--json"], { envHome: home }).stdout);
	assert.equal(typeof second.data.changed, "boolean");
	assert.equal(second.data.nothingToDo, true);
});

test("brief --check exits 2 when suggested work exists", () => {
	const home = run(["init"]).home;
	// Create actionable state: enable then unlink a target so there's drift.
	run(["target", "enable", "claude"], { envHome: home });
	run(["unlink", "claude"], { envHome: home });
	const r = run(["brief", "--check", "--offline", "--json"], {
		envHome: home,
	});
	assert.equal(r.code, 2);
	const j = parseJson(r.stdout);
	assert.ok(j.data.suggestedActions.length >= 1);
});

test("manifest and schema commands emit the contract", () => {
	const m = parseJson(run(["manifest", "--json"]).stdout);
	assert.equal(m.command, "manifest");
	assert.ok(m.data.commands.length >= 10);
	const s = parseJson(run(["schema", "--json"]).stdout);
	assert.equal(s.data.envelope.ok, "boolean");
	const sc = parseJson(run(["schema", "brief", "--json"]).stdout);
	assert.equal(sc.data.requested.name, "brief");
	bad(run(["schema", "no-such-cmd", "--json"]));
});

test("--json=compact emits a single-line JSON value", () => {
	const r = run(["status", "--json=compact"]);
	ok(r);
	// a single trailing newline from the writer is allowed; no internal ones
	assert.ok(!r.stdout.trim().includes("\n"), "compact JSON must be one line");
	parseJson(r.stdout); // still valid JSON
});

test("--quiet suppresses informational output (exit 0)", () => {
	const r = run(["status", "-q"]);
	assert.equal(r.code, 0);
	assert.equal(r.stdout.trim(), "");
});

test("where -p reports the project master, not the global one", () => {
	const home = run(["init"]).home;
	const project = mkdtempSync(path.join(tmpdir(), "agent-where-proj-"));
	mkdirSync(path.join(project, ".agents"), { recursive: true });
	const j = parseJson(
		run(["where", "-p", "--json"], { envHome: home, cwd: project }).stdout,
	);
	assert.equal(
		j.data.master,
		path.join(project, ".agents", "AGENTS.md"),
	);
});

test("brief is read-only: no config.json updateCheck write without --refresh", () => {
	const home = run(["init"]).home;
	const cfgPath = path.join(home, ".agents", "config.json");
	const before = readFileSync(cfgPath, "utf8");
	ok(run(["brief", "--offline"], { envHome: home }));
	const after = readFileSync(cfgPath, "utf8");
	assert.equal(after, before, "brief must not mutate config.json by default");
});

// ---------------------------------------------------------------------------
// Phase 1 — search / SPECT / secrets / env / sync (CLI integration)
// ---------------------------------------------------------------------------

const hasGitCli = spawnSync("git", ["--version"]).status === 0;

test("search finds a lesson via the CLI", () => {
	const home = run(["init"]).home;
	const lessonsDir = path.join(home, ".agents", "lessons", "git");
	mkdirSync(lessonsDir, { recursive: true });
	writeFileSync(
		path.join(lessonsDir, "merge.md"),
		"---\n---\nHow to merge git branches safely\n",
	);
	const j = parseJson(run(["search", "merge", "--json"], { envHome: home }).stdout);
	assert.equal(j.command, "search");
	assert.ok(j.data.results.some((h) => h.path.endsWith("merge.md")));
});

test("spect task list + done round-trip via the CLI", () => {
	const home = run(["init"]).home;
	const project = mkdtempSync(path.join(tmpdir(), "agent-cli-spect-"));
	mkdirSync(path.join(project, ".spect", "tasks"), { recursive: true });
	mkdirSync(path.join(project, ".spect", "specs"), { recursive: true });
	writeFileSync(path.join(project, ".spect", "specs", "SPEC-01.md"), "- REQ-001: works\n");
	writeFileSync(
		path.join(project, ".spect", "tasks", "TASKS-01.md"),
		"- [ ] TASK-001 [REQ-001] do it\n",
	);
	const list = parseJson(
		run(["spect", "task", "list", "--json"], { envHome: home, cwd: project }).stdout,
	);
	assert.equal(list.data.taskCount, 1);
	assert.equal(list.data.open, 1);
	const done = parseJson(
		run(["spect", "task", "done", "TASK-001", "--json"], { envHome: home, cwd: project }).stdout,
	);
	assert.equal(done.data.done, true);
});

test("secret set/get/list round-trip via the CLI", () => {
	const home = run(["init"]).home;
	ok(run(["secret", "set", "TOKEN", "abc123", "--json"], { envHome: home }));
	const got = run(["secret", "get", "TOKEN", "--json"], { envHome: home });
	ok(got);
	assert.equal(parseJson(got.stdout).data.value, "abc123");
	const list = parseJson(run(["secret", "list", "--json"], { envHome: home }).stdout);
	assert.ok(list.data.names.includes("TOKEN"));
});

test("env capture fills ENVIRONMENTS.md via the CLI", () => {
	const home = run(["init"]).home;
	// init auto-captures env; verify the fields are present.
	const r = run(["env", "capture", "--json"], { envHome: home });
	ok(r);
	const j = parseJson(r.stdout);
	// After auto-init, env fields are already filled; filled may be 0 on re-run.
	assert.ok(j.data.detected);
	assert.ok(j.data.detected.user);
	assert.ok(j.data.detected.os);
});
test("sync init + push + status round-trip via the CLI", { skip: !hasGitCli }, () => {
	const home = run(["init"]).home;
	ok(run(["sync", "init", "--json"], { envHome: home }));
	ok(run(["sync", "push", "--json"], { envHome: home }));
	const status = parseJson(
		run(["sync", "status", "--json"], { envHome: home }).stdout,
	);
	assert.equal(status.data.ok, true);
	assert.ok(status.data.head);
});

// ---------------------------------------------------------------------------
// Phase 3 — ergonomics + composite commands
// ---------------------------------------------------------------------------

test("config + version commands emit settings", () => {
	const home = run(["init"]).home;
	const cfg = parseJson(run(["config", "--json"], { envHome: home }).stdout);
	assert.ok(cfg.data.path.endsWith("config.json"));
	assert.ok(cfg.data.config);
	const ver = parseJson(run(["version", "--json"], { envHome: home }).stdout);
	assert.match(ver.data.version, /^\d+\.\d+\.\d+$/);
});

test("completion emits a script for each shell", () => {
	for (const shell of ["bash", "zsh", "fish", "powershell"]) {
		const r = run(["completion", shell]);
		ok(r);
		assert.ok(r.stdout.trim().length > 10, shell);
	}
	bad(run(["completion", "tcsh"]));
});

test("env set writes a field into ENVIRONMENTS.md", () => {
	const home = run(["init"]).home;
	const r = run(["env", "set", "KeyTools", "vscode", "pwsh", "--json"], {
		envHome: home,
	});
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.data.field, "KeyTools");
	assert.equal(j.data.value, "vscode pwsh");
	assert.match(
		readFileSync(path.join(home, ".agents", "ENVIRONMENTS.md"), "utf8"),
		/- KeyTools: vscode pwsh/,
	);
});

test("models suggest shows auto-resolved state after init", () => {
	const home = run(["init"]).home;
	// init auto-applies models; suggest should show 0 unresolved.
	const r = parseJson(run(["models", "suggest", "--json"], { envHome: home }).stdout);
	assert.equal(r.command, "models");
	assert.equal(r.data.count, 0);
});

test("models suggest --reassign lists every alias even when all resolve", () => {
	const home = run(["init"]).home;
	// init auto-applies aliases; reassign must consider them all (count > 0),
	// even though 'suggest' alone reports 0 unresolved.
	const r = parseJson(
		run(["models", "suggest", "--reassign", "--json"], { envHome: home }).stdout,
	);
	assert.equal(r.command, "models");
	assert.ok(r.data.count >= 4, "expected all seeded aliases in the reassign list");
	assert.ok(
		r.data.unresolved.every((row) => row.pick),
		"every existing alias should have a current best pick",
	);
});

test("brief --oneline emits a one-line summary", () => {
	const home = run(["init"]).home;
	const r = parseJson(run(["brief", "--oneline", "--json"], { envHome: home }).stdout);
	assert.equal(r.data.oneline, true);
	assert.match(r.data.onelineText, /^v\d/);
});

test("doctor --plan includes structured actions", () => {
	const home = run(["init"]).home;
	const r = parseJson(run(["doctor", "--plan", "--json"], { envHome: home }).stdout);
	assert.ok(Array.isArray(r.data.plan));
});

test("link -g -p is rejected (mutually exclusive)", () => {
	const home = run(["init"]).home;
	const r = run(["link", "-g", "-p", "--json"], { envHome: home });
	bad(r);
	assert.equal(parseJson(r.stdout).ok, false);
});

test("setup runs a one-pass readiness pass", () => {
	const home = run(["init"]).home;
	const r = run(["setup", "--json"], { envHome: home });
	ok(r);
	const j = parseJson(r.stdout);
	assert.ok(j.data.steps.readiness.health);
	assert.ok(j.data.steps.snapshot);
});

test("handoff create/list via the CLI", () => {
	const home = run(["init"]).home;
	ok(
		run(
			["handoff", "create", "--to", "worker", "--task", "build parser", "--json"],
			{ envHome: home },
		),
	);
	const list = parseJson(run(["handoff", "list", "--json"], { envHome: home }).stdout);
	assert.ok(list.data.handoffs.some((x) => x.task.includes("parser")));
});

test("whoami reports identity + gaps via the CLI", () => {
	const home = run(["init"]).home;
	run(["identity", "apply", "general-purpose"], { envHome: home });
	run(["identity", "set", "AGENT_NAME", "Marvin"], { envHome: home });
	const r = parseJson(run(["whoami", "--json"], { envHome: home }).stdout);
	assert.equal(r.data.identity, "Marvin");
});
