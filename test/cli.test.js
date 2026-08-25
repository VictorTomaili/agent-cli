// Integration tests for the CLI entrypoint (src/cli.js) via spawn.
// Focus: error/evil paths (unknown commands, missing args, invalid ids), exit codes,
// and --json contract. Each test gets an isolated AGENT_CLI_HOME.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync, spawn } from "node:child_process";
import {
	mkdtempSync,
	writeFileSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	unlinkSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.resolve("src/cli.js");

function run(args, { envHome, cwd } = {}) {
	const env = { ...process.env, AGENT_OFFLINE: "1" };
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

test("brief --json omits the open-session warning when no session is active", () => {
	const home = run(["init"]).home;
	const r = run(["brief", "--json"], { envHome: home });
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.data.session, null);
	assert.ok(!j.data.warnings.some((w) => w.includes("session open since")));
});

test("brief --json surfaces the open-session warning while a session is active, and drops it after session end", () => {
	const home = run(["init"]).home;
	const started = run(["session", "start", "fix", "the", "thing"], {
		envHome: home,
	});
	ok(started);
	const active = parseJson(run(["brief", "--json"], { envHome: home }).stdout);
	assert.ok(active.data.session);
	assert.equal(active.data.session.task, "fix the thing");
	assert.ok(
		active.data.warnings.some(
			(w) =>
				w.includes("session open since") && w.includes("agent-cli session end"),
		),
		`expected open-session warning, got: ${JSON.stringify(active.data.warnings)}`,
	);

	ok(run(["session", "end"], { envHome: home }));
	const ended = parseJson(run(["brief", "--json"], { envHome: home }).stdout);
	assert.equal(ended.data.session, null);
	assert.ok(!ended.data.warnings.some((w) => w.includes("session open since")));
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

test("skill status reports the integrated backend (no skills version)", () => {
	const r = run(["skill", "status", "--json"]);
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.data.backend, "integrated");
	assert.equal(j.data.available, true);
	assert.equal(j.data.version, undefined, "skills version is not reported");
	assert.equal(j.data.source, undefined, "skills source is not reported");
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

test("archetype import of a missing file reports Not found (ENOENT not swallowed)", () => {
	// HIGH-4: the import catch used to report EVERY read failure as "Not found".
	// The ENOENT branch must exit non-zero with the message; permission errors
	// are surfaced separately (hard to trigger portably, covered by the code
	// path that now distinguishes error.code).
	const r = run(["archetype", "import", "definitely-missing-archetype.md"]);
	bad(r);
	assert.match(
		r.stderr,
		/Not found: definitely-missing-archetype\.md/,
		`stderr: ${r.stderr}`,
	);
});

test("project doctor runs in human mode without crashing (loop var does not shadow colors)", () => {
	// Regression: the original inline block iterated `for (const c of checks)`,
	// shadowing the colors import `c` — `c.green` threw "c.green is not a
	// function" on every human-mode run. The --json path masked it.
	const project = mkdtempSync(path.join(tmpdir(), "agent-cli-projdoc-"));
	const r = run(["project", "doctor"], { envHome: project, cwd: project });
	// Fresh dir: issues exist → EXIT.WORK (2). The regression is that human
	// mode renders rows instead of crashing on the shadowed colors import.
	assert.ok(
		[0, 2].includes(r.code),
		`expected exit 0 or 2, got ${r.code}: ${r.stderr}`,
	);
	assert.doesNotMatch(r.stderr, /c\.green is not a function/);
	assert.match(r.stdout, /project-master-exists/);
	// JSON mode still works and carries the checks.
	const j = run(["project", "doctor", "--json"], {
		envHome: project,
		cwd: project,
	});
	assert.ok([0, 2].includes(j.code), `json exit ${j.code}: ${j.stderr}`);
	const data = parseJson(j.stdout).data;
	assert.ok(Array.isArray(data.checks));
	assert.ok(data.checks.some((c) => c.check === "project-master-exists"));
});

test("project doctor treats unconfigured targets as optional, not errors", () => {
	// A project with a master but no explicit target allowlist must exit 0:
	// missing/native pointers are optional (the project never opted into
	// those tools). Only pointer-stale drift and a missing master are issues.
	const home = run(["init"]).home;
	const project = mkdtempSync(path.join(tmpdir(), "agent-cli-projdoc-opt-"));
	run(["project", "init"], { envHome: home, cwd: project });
	const j = run(["project", "doctor", "--json"], {
		envHome: home,
		cwd: project,
	});
	assert.equal(j.code, 0, `expected exit 0, got ${j.code}: ${j.stderr}`);
	const data = parseJson(j.stdout).data;
	assert.deepEqual(data.issues, []);
	const pointers = data.checks.filter((c) => c.check.startsWith("pointer:"));
	assert.ok(pointers.length > 0, "expected pointer checks");
	assert.ok(
		pointers.every((c) => c.ok === true && c.status === "optional"),
		`expected every unconfigured pointer to be optional, got ${JSON.stringify(
			pointers.slice(0, 3),
		)}`,
	);
	assert.ok(data.optionalCount >= pointers.length);
});

test("project doctor flags a drifted pointer; a healthy one stays ok", () => {
	// pointer-stale is actionable even without an explicit allowlist: a stub
	// exists but drifted. A correctly deployed pointer must classify as
	// pointer (not stale) — doctor used to diff project stubs against the
	// GLOBAL master, flagging every healthy project pointer as stale.
	const home = run(["init"]).home;
	const project = mkdtempSync(path.join(tmpdir(), "agent-cli-projdoc-stale-"));
	run(["project", "init"], { envHome: home, cwd: project });
	const en = run(["target", "enable", "claude", "-p"], {
		envHome: home,
		cwd: project,
	});
	ok(en);
	const healthy = run(["project", "doctor", "--json"], {
		envHome: home,
		cwd: project,
	});
	assert.equal(healthy.code, 0, `healthy: ${healthy.stderr}`);
	const claude = parseJson(healthy.stdout).data.checks.find(
		(c) => c.check === "pointer:claude",
	);
	assert.equal(claude.ok, true);
	assert.equal(claude.status, "ok");
	assert.match(claude.detail, /^pointer /);
	// Drift the stub: keep it a parseable pointer, change its master target.
	const stub = path.join(project, "CLAUDE.md");
	writeFileSync(
		stub,
		readFileSync(stub, "utf8").replace(
			/<!-- master-abs: .*?-->/,
			"<!-- master-abs: /gone/old-master.md -->",
		),
	);
	const drifted = run(["project", "doctor", "--json"], {
		envHome: home,
		cwd: project,
	});
	assert.equal(drifted.code, 2, `drifted: ${drifted.stderr}`);
	const data = parseJson(drifted.stdout).data;
	assert.ok(
		data.issues.some((i) => i.startsWith("claude project pointer stale")),
		`issues: ${JSON.stringify(data.issues)}`,
	);
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

test("brief manifest: globalOnly kinds get only the global entry; project-overridable kinds get both", () => {
	const home = run(["init"]).home;
	const project = mkdtempSync(path.join(tmpdir(), "agent-cli-project-"));
	mkdirSync(path.join(project, ".agents"), { recursive: true });
	// Create project files for BOTH a globalOnly kind (user) and an
	// overridable kind (soul). The user.md MUST be ignored; the soul.md
	// MUST be loaded — that's the new contract.
	writeFileSync(path.join(project, ".agents", "USER.md"), "# project user\n");
	writeFileSync(path.join(project, ".agents", "SOUL.md"), "# project soul\n");
	const j = parseJson(
		run(["brief", "--json"], { envHome: home, cwd: project }).stdout,
	);
	const load = j.data.sessionStart.load;

	// globalOnly kinds: exactly 1 entry, scope=global, flagged globalOnly.
	for (const kind of ["identity", "user", "models"]) {
		const entries = load.filter((f) => f.kind === kind);
		assert.equal(
			entries.length,
			1,
			`globalOnly kind '${kind}' should have exactly 1 entry, got ${entries.length}: ${JSON.stringify(entries)}`,
		);
		assert.equal(
			entries[0].scope,
			"global",
			`globalOnly kind '${kind}' should only have a global entry`,
		);
		assert.equal(
			entries[0].globalOnly,
			true,
			`globalOnly kind '${kind}' entry should be flagged globalOnly`,
		);
	}

	// Project-overridable kinds: exactly 2 entries (global + project).
	for (const kind of ["agents", "soul", "lessons", "environments"]) {
		const entries = load.filter((f) => f.kind === kind);
		assert.equal(
			entries.length,
			2,
			`overridable kind '${kind}' should have 2 entries (global + project), got ${entries.length}: ${JSON.stringify(entries)}`,
		);
		const scopes = entries.map((f) => f.scope).sort();
		assert.deepEqual(
			scopes,
			["global", "project"],
			`overridable kind '${kind}' must have one global + one project entry`,
		);
	}
});

test("brief output: project LESSONS.md (missing) shows '(no project lessons yet)' not a gap", () => {
	// Project LESSONS.md is OPTIONAL — a missing file is a legitimate state
	// meaning "no project-specific lessons yet", not a gap. The global
	// LESSONS.md already carries the system-wide lessons.
	const home = run(["init"]).home;
	const project = mkdtempSync(
		path.join(tmpdir(), "agent-cli-no-project-lessons-"),
	);
	mkdirSync(path.join(project, ".agents"), { recursive: true });
	// Deliberately DO NOT create a project LESSONS.md.
	const r = run(["brief"], { envHome: home, cwd: project });
	assert.equal(r.code, 0, `brief exit code: ${r.stderr}`);
	// Find the project lessons line in the rendered Session-start list.
	const lessonsLine = r.stdout
		.split(/\r?\n/)
		.find((l) => /lessons\s*\(proj\)/.test(l));
	assert.ok(
		lessonsLine !== undefined,
		`project lessons line missing from brief output:\n${r.stdout}`,
	);
	assert.ok(
		/no project lessons yet/.test(lessonsLine),
		`project lessons line should show '(no project lessons yet)', got: ${lessonsLine}`,
	);
	assert.ok(
		!/\(missing\)/.test(lessonsLine),
		`project lessons line must NOT show '(missing)': ${lessonsLine}`,
	);
	assert.ok(
		!/\(gap:/.test(lessonsLine),
		`project lessons line must NOT show a gap: ${lessonsLine}`,
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
		path.join(home, ".agents", "agents", "fullstack-dev.md"),
		"# changed by user\n",
	);
	const r = run(["update", "diff", ver, "--json"], { envHome: home });
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.data.action, "diff");
	const devAgent = j.data.diffs.find((d) => d.rel.includes("fullstack-dev.md"));
	assert.ok(devAgent);
	assert.ok(devAgent.diff.includes("-# changed by user"));
	assert.ok(devAgent.diff.includes("+")); // staged content appears as additions
});

test("update diff rejects files outside the staged payload", () => {
	const home = run(["init"]).home;
	run(["update", "stage"], { envHome: home });
	// Use the actual staged version (the previous hardcoded "0.2.1" worked
	// only because the installed version matched; after the bump to 0.3.0
	// the version check would fire first and the path-traversal check
	// would never run).
	const ver = parseJson(
		run(["update", "list", "--json"], { envHome: home }).stdout,
	).data.staged[0].version;
	const r = run(
		["update", "diff", ver, "--file", "../../secret.txt", "--json"],
		{ envHome: home },
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
		path.join(home, ".agents", `update-${ver}`, "agents", "fullstack-dev.md"),
		"utf8",
	);
	writeFileSync(
		path.join(home, ".agents", "agents", "fullstack-dev.md"),
		staged,
	);
	const j = parseJson(
		run(["update", "diff", ver, "--file", "agents/fullstack-dev.md", "--json"], {
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
	const summary = parseJson(run(["status", "--json"], { envHome: home }).stdout);
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
	assert.ok(j.data.checks.some((c) => c.check === "file-exists:soul" && !c.ok));
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
	// M10: missing required argument and unknown option must also emit a
	// JSON envelope on stdout (never leak plain commander text to stderr).
	for (const args of [
		["handoff", "--json"], // missing <action>
		["brief", "--bogus", "--json"], // unknown option
	]) {
		const rr = run(args);
		bad(rr);
		assert.equal(rr.stderr.trim(), "", `stderr should be clean for ${args}`);
		const jj = parseJson(rr.stdout);
		assert.equal(jj.ok, false);
		assert.ok(jj.error);
	}
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

test("P0-2: pull -p writes to the project master, not the global master", () => {
	const home = run(["init"]).home;
	const project = mkdtempSync(path.join(tmpdir(), "agent-pull-proj-"));
	mkdirSync(path.join(project, ".agents"), { recursive: true });
	writeFileSync(path.join(project, "CLAUDE.md"), "# Project native content\n");
	const r = run(["pull", "claude", "-p", "--json"], {
		envHome: home,
		cwd: project,
	});
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.data.scope, "project");
	assert.equal(j.data.master, path.join(project, ".agents", "AGENTS.md"));
	// project master has the adopted content
	assert.match(
		readFileSync(path.join(project, ".agents", "AGENTS.md"), "utf8"),
		/# Project native content/,
	);
	// global master must NOT have it
	assert.doesNotMatch(
		readFileSync(path.join(home, ".agents", "AGENTS.md"), "utf8"),
		/# Project native content/,
	);
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
		run(["edit", "models", "--print-path", "--json"], { envHome: home }).stdout,
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
		run(["identity", "apply", "no-such-identity", "--fallback", "--json"], {
			envHome: home,
		}).stdout,
	);
	assert.equal(fb.ok, true);
	assert.equal(fb.data.fallback, true);
	assert.equal(fb.data.resolved, "general-purpose");
	ok(
		run(["identity", "apply", "no-such-identity", "--fallback"], {
			envHome: home,
		}),
	);
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
	assert.match(r.stdout, /agent-cli init/);
	assert.equal(r.stderr, "");
});

test("`agent-cli help` and `agent-cli help <cmd>` exit 0", () => {
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

test("link/unlink reject positional ids (M7 — must use --target)", () => {
	// Regression: `agent-cli link claude` used to silently link EVERY enabled
	// target; `agent-cli unlink claude` would unlink them all. Both now error.
	const home = run(["init"]).home;
	run(["target", "enable", "claude"], { envHome: home });
	run(["target", "enable", "codex"], { envHome: home });
	const l = run(["link", "claude"], { envHome: home });
	bad(l);
	assert.match(l.stderr, /too many arguments for 'link'|Unknown link kind/i);
	const u = run(["unlink", "claude"], { envHome: home });
	bad(u);
	assert.match(u.stderr, /too many arguments for 'unlink'|Unknown link kind/i);
	// The explicit form still works.
	const ok = run(["link", "--target", "claude"], { envHome: home });
	assert.equal(ok.code, 0, ok.stderr);
});

test("link:claude action args use --target (M7)", () => {
	const home = run(["init"]).home;
	run(["target", "enable", "claude"], { envHome: home });
	run(["target", "enable", "codex"], { envHome: home });
	run(["unlink", "--target", "claude"], { envHome: home });
	run(["unlink", "--target", "codex"], { envHome: home });
	const b = parseJson(run(["brief", "--json"], { envHome: home }).stdout);
	const linkAction = b.data.actions.find((a) => a.id === "link:claude");
	assert.ok(linkAction, "expected link:claude action");
	assert.deepEqual(linkAction.args, ["link", "--target", "claude"]);
	assert.match(linkAction.rollback, /^agent-cli unlink --target claude$/);
});

test("brief --since returns no actions when the state etag is unchanged", () => {
	const home = run(["init"]).home;
	// create actionable state: drift
	run(["target", "enable", "claude"], { envHome: home });
	run(["unlink", "--target", "claude"], { envHome: home });
	const first = parseJson(run(["brief", "--json"], { envHome: home }).stdout);
	assert.ok(first.data.actions.length >= 1);
	const etag = first.data.etag;
	// same etag → cache hit: no actions, unchanged flag set
	const cached = parseJson(
		run(["brief", "--since", etag, "--json"], { envHome: home }).stdout,
	);
	assert.equal(cached.data.actions.length, 0);
	assert.equal(cached.data.unchanged, true);
	// a stale etag returns the current state with actions
	const stale = parseJson(
		run(["brief", "--since", "aaaaaaaaaaaaaaaa", "--json"], { envHome: home })
			.stdout,
	);
	assert.ok(stale.data.actions.length >= 1);
	assert.equal(stale.data.unchanged, undefined);
});

test("brief --check exits 2 when suggested work exists", () => {
	const home = run(["init"]).home;
	// Create actionable state: enable then unlink a target so there's drift.
	run(["target", "enable", "claude"], { envHome: home });
	run(["unlink", "--target", "claude"], { envHome: home });
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
	assert.equal(j.data.master, path.join(project, ".agents", "AGENTS.md"));
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
	const j = parseJson(
		run(["search", "merge", "--json"], { envHome: home }).stdout,
	);
	assert.equal(j.command, "search");
	assert.ok(j.data.results.some((h) => h.path.endsWith("merge.md")));
});

test("spect task list + done round-trip via the CLI", () => {
	const home = run(["init"]).home;
	const project = mkdtempSync(path.join(tmpdir(), "agent-cli-spect-"));
	mkdirSync(path.join(project, ".spect", "tasks"), { recursive: true });
	mkdirSync(path.join(project, ".spect", "specs"), { recursive: true });
	writeFileSync(
		path.join(project, ".spect", "specs", "SPEC-01.md"),
		"- REQ-001: works\n",
	);
	writeFileSync(
		path.join(project, ".spect", "tasks", "TASKS-01.md"),
		"- [ ] TASK-001 [REQ-001] do it\n",
	);
	const list = parseJson(
		run(["spect", "task", "list", "--json"], { envHome: home, cwd: project })
			.stdout,
	);
	assert.equal(list.data.taskCount, 1);
	assert.equal(list.data.open, 1);
	const done = parseJson(
		run(["spect", "task", "done", "TASK-001", "--json"], {
			envHome: home,
			cwd: project,
		}).stdout,
	);
	assert.equal(done.data.done, true);
});

test("secret set/get/list round-trip via the CLI", () => {
	const home = run(["init"]).home;
	ok(run(["secret", "set", "TOKEN", "abc123", "--json"], { envHome: home }));
	const got = run(["secret", "get", "TOKEN", "--json"], { envHome: home });
	ok(got);
	assert.equal(parseJson(got.stdout).data.value, "abc123");
	const list = parseJson(
		run(["secret", "list", "--json"], { envHome: home }).stdout,
	);
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
test("sync init + push + status round-trip via the CLI", {
	skip: !hasGitCli,
}, () => {
	const home = run(["init"]).home;
	ok(run(["sync", "init", "--json"], { envHome: home }));
	ok(run(["sync", "push", "--json"], { envHome: home }));
	const status = parseJson(
		run(["sync", "status", "--json"], { envHome: home }).stdout,
	);
	assert.equal(status.data.ok, true);
	assert.ok(status.data.head);
});

test("sync diff + rollback round-trip via the CLI", {
	skip: !hasGitCli,
}, () => {
	const home = run(["init"]).home;
	ok(run(["sync", "init", "--json"], { envHome: home }));
	ok(run(["sync", "push", "--message", "initial", "--json"], { envHome: home }));
	// add a lesson, push it as the second commit
	ok(
		run(
			["lessons", "add", "rollback-me", "--body", "will be removed", "--json"],
			{ envHome: home },
		),
	);
	ok(run(["sync", "push", "--message", "second", "--json"], { envHome: home }));
	// positional diff resolves and emits a summary for the given commit
	const diff = parseJson(
		run(["sync", "diff", "HEAD~1", "--json"], { envHome: home }).stdout,
	);
	assert.equal(diff.data.ok, true);
	assert.ok(diff.data.summary);
	// diffing the commit that added the lesson shows it in the body
	const second = parseJson(
		run(["sync", "diff", "--commit", "HEAD", "--json"], { envHome: home }).stdout,
	);
	assert.equal(second.data.ok, true);
	assert.match(second.data.summary, /rollback-me/);
	// rollback to HEAD~1 removes the lesson added in the second commit
	const rollback = parseJson(
		run(["sync", "rollback", "HEAD~1", "--json"], { envHome: home }).stdout,
	);
	assert.equal(rollback.data.ok, true);
	assert.equal(
		existsSync(path.join(home, ".agents", "lessons", "rollback-me.md")),
		false,
		"rollback must remove files added after the target commit",
	);
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
	const r = parseJson(
		run(["models", "suggest", "--json"], { envHome: home }).stdout,
	);
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
	assert.ok(
		r.data.count >= 4,
		"expected all seeded aliases in the reassign list",
	);
	assert.ok(
		r.data.unresolved.every((row) => row.pick),
		"every existing alias should have a current best pick",
	);
});

test("brief --for attaches task-aware search hits", () => {
	const home = run(["init"]).home;
	const r = parseJson(
		run(["brief", "--for", "canonical AGENTS.md", "--json"], { envHome: home })
			.stdout,
	);
	assert.ok(r.data.forTask, "expected forTask payload");
	assert.equal(r.data.forTask.query, "canonical AGENTS.md");
	assert.ok(Array.isArray(r.data.forTask.hits));
});

test("brief --oneline emits a one-line summary", () => {
	const home = run(["init"]).home;
	const r = parseJson(
		run(["brief", "--oneline", "--json"], { envHome: home }).stdout,
	);
	assert.equal(r.data.oneline, true);
	assert.match(r.data.onelineText, /^v\d/);
});

test("status and doctor expose a corrupt config instead of hiding it", () => {
	const home = run(["init"]).home;
	writeFileSync(path.join(home, ".agents", "config.json"), "{ not valid json");
	// status --json carries config.corrupt: true
	const status = parseJson(run(["status", "--json"], { envHome: home }).stdout);
	assert.equal(status.data.config.corrupt, true);
	// doctor flags it as a failed check + issue
	const doctor = parseJson(
		run(["doctor", "--offline", "--json"], { envHome: home }).stdout,
	);
	const check = doctor.data.checks.find((c) => c.check === "config-not-corrupt");
	assert.ok(check);
	assert.equal(check.ok, false);
	assert.ok(doctor.data.issues.some((i) => /config\.json is corrupt/.test(i)));
});

test("doctor --plan includes structured actions", () => {
	const home = run(["init"]).home;
	const r = parseJson(
		run(["doctor", "--plan", "--json"], { envHome: home }).stdout,
	);
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
	const list = parseJson(
		run(["handoff", "list", "--json"], { envHome: home }).stdout,
	);
	assert.ok(list.data.handoffs.some((x) => x.task.includes("parser")));
});

test("whoami reports identity + gaps via the CLI", () => {
	const home = run(["init"]).home;
	run(["identity", "apply", "general-purpose"], { envHome: home });
	run(["identity", "set", "AGENT_NAME", "Marvin"], { envHome: home });
	const r = parseJson(run(["whoami", "--json"], { envHome: home }).stdout);
	assert.equal(r.data.identity, "Marvin");
});

test("fresh init creates the master at ~/.agents/AGENTS.md and the home pointer at ~/AGENTS.md", () => {
	const home = run(["init"]).home;
	// the master is REAL content at the new canonical location
	const master = readFileSync(path.join(home, ".agents", "AGENTS.md"), "utf8");
	assert.match(master, /## Session start read order/);
	assert.doesNotMatch(master, /agent-cli-master-pointer/);
	// ~/AGENTS.md is the managed home pointer stub pointing at the master
	const stub = readFileSync(path.join(home, "AGENTS.md"), "utf8");
	assert.match(stub, /agent-cli-master-pointer/);
	assert.match(
		stub,
		new RegExp(
			"master-abs: " +
				path.join(home, ".agents", "AGENTS.md").replace(/[\\/]/g, "."),
		),
	);
	assert.match(stub, /master-tilde: ~\/\.agents\/AGENTS\.md/);
	assert.match(stub, /Read that file now/);
});

test("init migrates an old-layout ~/AGENTS.md master to ~/.agents/AGENTS.md (backup kept)", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-migrate-"));
	mkdirSync(path.join(home, ".agents"), { recursive: true });
	// OLD layout: real master at ~/AGENTS.md, self-pointer stub at ~/.agents/AGENTS.md
	const oldMaster =
		"# OLD MASTER content\n\n## Real user content\n\n" +
		"padding padding padding padding padding padding padding padding padding padding\n";
	writeFileSync(path.join(home, "AGENTS.md"), oldMaster);
	writeFileSync(
		path.join(home, ".agents", "AGENTS.md"),
		[
			"<!-- agent-cli-pointer -->",
			"<!-- target: agent-cli-master-pointer -->",
			"<!-- scope: agent-cli -->",
			"<!-- native: AGENTS.md -->",
			`<!-- master-abs: ${path.join(home, "AGENTS.md")} -->`,
			"<!-- master-tilde: ~/AGENTS.md -->",
			"",
			"# AGENTS.md (agent-cli's local copy) → redirected by agent-cli",
			"",
			"This file is a **pointer stub**. Read the master instead.",
		].join("\n"),
	);
	ok(run(["init", "--json"], { envHome: home }));
	// master moved to ~/.agents/AGENTS.md with the old content preserved
	assert.match(
		readFileSync(path.join(home, ".agents", "AGENTS.md"), "utf8"),
		/OLD MASTER content/,
	);
	// old master location is now the agent-cli home pointer stub
	const stub = readFileSync(path.join(home, "AGENTS.md"), "utf8");
	assert.match(stub, /agent-cli-master-pointer/);
	assert.match(stub, /master-tilde: ~\/\.agents\/AGENTS\.md/);
	// a backup of the pre-migration master exists
	const backupDir = path.join(home, ".agents", "backups");
	const backups = readdirSync(backupDir).filter((f) => f.endsWith(".md"));
	assert.ok(backups.length >= 1, "expected a backup under ~/.agents/backups");
	assert.match(
		readFileSync(path.join(backupDir, backups[0]), "utf8"),
		/OLD MASTER content/,
	);
});

test("init divergence: both files real → keeps ~/.agents/AGENTS.md, backs up ~/AGENTS.md, warns", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-diverge-"));
	mkdirSync(path.join(home, ".agents"), { recursive: true });
	writeFileSync(
		path.join(home, "AGENTS.md"),
		"# HOME COPY\n\n## home content\n\npadding padding padding padding padding\n",
	);
	writeFileSync(
		path.join(home, ".agents", "AGENTS.md"),
		"# AGENTS-DIR MASTER\n\n## canonical content\n\nother padding padding padding padding\n",
	);
	const r = run(["init"], { envHome: home });
	assert.equal(r.code, 0, `init exit ${r.code}: ${r.stderr}`);
	// the warning names the backup so the user can reconcile
	assert.match(r.stdout, /held real content/);
	assert.match(r.stdout, /backed up/);
	// the canonical master keeps ITS content
	assert.match(
		readFileSync(path.join(home, ".agents", "AGENTS.md"), "utf8"),
		/AGENTS-DIR MASTER/,
	);
	assert.doesNotMatch(
		readFileSync(path.join(home, ".agents", "AGENTS.md"), "utf8"),
		/HOME COPY/,
	);
	// home became the pointer; the home copy survives only in the backup
	assert.match(
		readFileSync(path.join(home, "AGENTS.md"), "utf8"),
		/agent-cli-master-pointer/,
	);
	const backupDir = path.join(home, ".agents", "backups");
	const backups = readdirSync(backupDir).filter((f) => f.endsWith(".md"));
	assert.ok(backups.length >= 1);
	assert.match(
		readFileSync(path.join(backupDir, backups[0]), "utf8"),
		/HOME COPY/,
	);
});

test("link never overwrites the ~/.agents/AGENTS.md master with a stub", () => {
	const home = run(["init"]).home;
	const custom =
		"# MY MASTER\n\n## custom content\n\n" +
		"enough substance to pass the size gate " +
		"x".repeat(200) +
		"\n";
	writeFileSync(path.join(home, ".agents", "AGENTS.md"), custom);
	ok(run(["link"], { envHome: home }));
	const after = readFileSync(path.join(home, ".agents", "AGENTS.md"), "utf8");
	assert.match(after, /MY MASTER/);
	assert.doesNotMatch(after, /agent-cli-master-pointer/);
	// the home pointer is (re)deployed, pointing at the master
	assert.match(
		readFileSync(path.join(home, "AGENTS.md"), "utf8"),
		/agent-cli-master-pointer/,
	);
});

test("target stubs point at the new master location (master-abs/master-tilde)", () => {
	const home = run(["init"]).home;
	ok(run(["target", "enable", "claude", "-g"], { envHome: home }));
	ok(run(["link", "--target", "claude"], { envHome: home }));
	const stub = readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
	assert.match(stub, /master-tilde: ~\/\.agents\/AGENTS\.md/);
	assert.match(
		stub,
		new RegExp(
			"master-abs: " +
				path.join(home, ".agents", "AGENTS.md").replace(/[\\/]/g, "."),
		),
	);
	// the stub redirects to the master, never the other way around
	assert.doesNotMatch(stub, /agent-cli-master-pointer/);
});

test("init migration strips a stray pointer header prepended onto the old master", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-migrate-stray-"));
	mkdirSync(path.join(home, ".agents"), { recursive: true });
	// old master has a pointer-stub header (buggy old link) ABOVE real content
	const oldMaster =
		"<!-- agent-cli-pointer -->\n" +
		"# AGENTS.md → redirected by agent-cli\n\n" +
		"This file is a **pointer stub**.\n\n" +
		"<!-- BEGIN agent-cli -->\n" +
		"## agent-cli (AGENTS.md manager)\n\n" +
		"Real content padding padding padding padding padding padding padding padding\n";
	writeFileSync(path.join(home, "AGENTS.md"), oldMaster);
	writeFileSync(
		path.join(home, ".agents", "AGENTS.md"),
		"<!-- agent-cli-pointer -->\n# stub\n",
	);
	ok(run(["init", "--json"], { envHome: home }));
	const adopted = readFileSync(path.join(home, ".agents", "AGENTS.md"), "utf8");
	// the stray stub header is gone; the real content remains
	assert.doesNotMatch(adopted, /pointer stub/);
	assert.match(adopted, /Real content/);
	// and the old master location is the managed home pointer
	assert.match(
		readFileSync(path.join(home, "AGENTS.md"), "utf8"),
		/agent-cli-master-pointer/,
	);
});

test("P0-3: 6 concurrent 'target enable' processes all succeed without data loss", async () => {
	const home = run(["init"]).home;
	const ids = ["claude", "codex", "pi", "gemini", "qwen", "cline"];
	const env = { ...process.env, AGENT_CLI_HOME: home, AGENT_OFFLINE: "1" };
	const runOne = (id) =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [CLI, "target", "enable", id, "-g"], {
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			let stdout = "";
			// Drain BOTH pipes — an undrained stdout can fill its OS buffer and
			// deadlock the child (flaky hang seen on Windows).
			child.stdout.on("data", (d) => (stdout += d));
			child.stderr.on("data", (d) => (stderr += d));
			child.on("close", (code) => resolve({ id, code, stderr, stdout }));
		});
	const results = await Promise.all(ids.map(runOne));
	for (const r of results) {
		assert.equal(r.code, 0, `${r.id} enable failed: ${r.stderr}`);
	}
	const cfg = parseJson(run(["config", "--json"], { envHome: home }).stdout).data
		.config;
	const got = [...cfg.global].sort();
	assert.deepEqual(
		got,
		[...ids].sort(),
		"all 6 concurrent enables must be persisted",
	);
});

test("evaluate session with no archived sessions fails clearly", () => {
	const home = run(["init"]).home;
	const r = run(["evaluate", "session", "--json"], { envHome: home });
	bad(r);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, false);
	assert.match(j.error, /no archived sessions/i);
});

test("evaluate session --active scores the current unended session", () => {
	const home = run(["init"]).home;
	ok(run(["session", "start", "wip", "task"], { envHome: home }));
	const r = run(["evaluate", "session", "--active", "--json"], {
		envHome: home,
	});
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.data.source, "active");
	assert.equal(j.data.max, 100);
	// still open: closed/reported/lessons all unmet
	assert.equal(j.data.score, 0);
	assert.equal(j.data.feedback.length, 3);
	ok(run(["session", "end"], { envHome: home }));
});

test("evaluate session defaults to the most recently archived session and reflects reported+lessons", () => {
	const home = run(["init"]).home;
	ok(run(["session", "start", "close", "the", "loop"], { envHome: home }));
	ok(
		run(["lessons", "add", "session/close-the-loop-topic"], {
			envHome: home,
		}),
	);
	ok(run(["session", "report"], { envHome: home }));
	ok(run(["session", "end"], { envHome: home }));

	const r = run(["evaluate", "session", "--json"], { envHome: home });
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.data.score, j.data.max);
	assert.equal(j.data.feedback.length, 0);
	const bySignal = Object.fromEntries(
		j.data.breakdown.map((b) => [b.signal, b]),
	);
	assert.equal(bySignal.closed.points, bySignal.closed.max);
	assert.equal(bySignal.reported.points, bySignal.reported.max);
	assert.equal(bySignal.lessons.points, bySignal.lessons.max);
});

test("evaluate session <name> scores a specific archived session file", () => {
	const home = run(["init"]).home;
	ok(run(["session", "start", "named lookup"], { envHome: home }));
	ok(run(["session", "end"], { envHome: home }));
	const sessionsDir = path.join(home, ".agents", "sessions");
	const [file] = readdirSync(sessionsDir);
	const stem = file.replace(/\.json$/, "");

	const r = run(["evaluate", "session", stem, "--json"], { envHome: home });
	ok(r);
	const j = parseJson(r.stdout);
	assert.match(
		j.data.source,
		new RegExp(stem.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")),
	);

	const rMissing = run(["evaluate", "session", "does-not-exist", "--json"], {
		envHome: home,
	});
	bad(rMissing);
	const jMissing = parseJson(rMissing.stdout);
	assert.equal(jMissing.ok, false);
	assert.match(jMissing.error, /no archived session/i);
});

test("evaluate session <name> rejects a path-traversal name instead of reading outside sessions/", () => {
	const home = run(["init"]).home;
	ok(run(["session", "start", "traversal probe"], { envHome: home }));
	ok(run(["session", "end"], { envHome: home }));
	// A file that exists OUTSIDE ~/.agents/sessions — must never be reachable.
	const secretFile = path.join(home, ".agents", "config.json");
	assert.ok(existsSync(secretFile), "sanity: the file we must not leak exists");

	const rTraversal = run(["evaluate", "session", "../config", "--json"], {
		envHome: home,
	});
	bad(rTraversal);
	const jTraversal = parseJson(rTraversal.stdout);
	assert.equal(jTraversal.ok, false);
	assert.match(jTraversal.error, /invalid session name/i);
});

test("team eval run runs the 5-fixture benchmark and exits 0", () => {
	const home = run(["init"]).home;
	const r = run(["team", "eval", "run"], { envHome: home });
	ok(r);
	// Human table names the fixtures; runBenchmark always returns all 5.
	for (const name of [
		"trivial-1",
		"trivial-2",
		"medium-1",
		"medium-2",
		"complex-1",
	]) {
		assert.match(
			r.stdout,
			new RegExp(name.replace(/[-]/g, "\\-")), // lgtm[js/incomplete-sanitization] — `/g` flag is present
			`fixture ${name} should appear in the table`,
		);
	}
	// JSON contract also works and reports the count.
	const rj = run(["team", "eval", "run", "--json"], { envHome: home });
	ok(rj);
	const j = parseJson(rj.stdout);
	assert.equal(j.command, "team");
	assert.equal(j.data.op, "run");
	assert.equal(j.data.count, 5);
	assert.equal(j.data.results.length, 5);
});

test("team eval report on a session with no ledger exits 0 and reports nothing", () => {
	const home = run(["init"]).home;
	const r = run(["team", "eval", "report"], { envHome: home });
	ok(r);
	const j = parseJson(
		run(["team", "eval", "report", "--json"], { envHome: home }).stdout,
	);
	assert.equal(j.command, "team");
	assert.equal(j.data.op, "report");
	assert.equal(j.data.noLedger, true);
});

test("brief warns when store skills carry legacy top-level extension fields", () => {
	const home = run(["init"]).home;
	// seed a legacy-layout skill directly into the skill store
	const storeSkill = path.join(home, ".skill-cli", "store", "legacy-demo");
	mkdirSync(storeSkill, { recursive: true });
	writeFileSync(
		path.join(storeSkill, "SKILL.md"),
		"---\nname: legacy-demo\ndescription: Legacy skill.\ntriggers: [deploy]\nversion: 1.0.0\n---\n\nBody.\n",
	);
	const j = run(["brief", "--json"], { envHome: home });
	ok(j);
	const data = parseJson(j.stdout).data;
	assert.ok(
		data.warnings.some((w) => w.includes("agent-cli skill migrate")),
		`warnings: ${JSON.stringify(data.warnings)}`,
	);
	assert.ok(data.skill.legacyFields.some((x) => x.name === "legacy-demo"));
	assert.equal(data.skill.available, true);
	// human mode surfaces it too
	const h = run(["brief"], { envHome: home });
	assert.match(h.stdout, /skill migrate/);
});

test("share links: link agents|skills, doctor warns, unlink, native refusal", () => {
	// Isolated home with personas + a store skill so sources are "live".
	const home = run(["init"]).home;
	run(["target", "enable", "claude"], { envHome: home }); // share-capable + enabled
	const roster = path.join(home, ".agents", "agents");
	mkdirSync(roster, { recursive: true });
	writeFileSync(
		path.join(roster, "scout.md"),
		"---\nname: scout\ndescription: scouts\n---\n\nbody\n",
	);
	const store = path.join(home, ".skill-cli", "store", "demo-skill");
	mkdirSync(store, { recursive: true });
	writeFileSync(
		path.join(store, "SKILL.md"),
		"---\nname: demo-skill\ndescription: demo\n---\n\nbody\n",
	);

	// doctor: enabled+capable targets unlinked → issues suggest the fix
	const d0 = run(["doctor", "--json"], { envHome: home });
	const d0data = parseJson(d0.stdout).data;
	assert.ok(
		d0data.issues.some((i) => i.includes("agent-cli link agents")),
		`issues: ${JSON.stringify(d0data.issues)}`,
	);

	// link agents (claude is enabled by init when .claude exists; pi likewise
	// when .pi exists — assert at least the linked-capable set is non-empty)
	const la = run(["link", "agents", "--json"], { envHome: home });
	ok(la);
	const laJson = parseJson(la.stdout);
	assert.equal(laJson.command, "link");
	const laData = laJson.data;
	assert.equal(laData.what, "agents");
	assert.ok(laData.results.length >= 1);
	assert.ok(laData.results.every((r) => r.linked));
	// claude agents dir now points at the roster
	const claudeAgents = path.join(home, ".claude", "agents");
	assert.ok(
		readFileSync(path.join(claudeAgents, "scout.md"), "utf8").includes("scout"),
		"persona readable through the link",
	);
	// idempotent
	const la2 = run(["link", "agents", "--json"], { envHome: home });
	assert.ok(parseJson(la2.stdout).data.results.every((r) => r.unchanged));

	// link skills: per-tool dirs (e.g. .claude/skills) — the store is the source.
	const ls = run(["link", "skills", "--json"], { envHome: home });
	ok(ls);
	assert.ok(
		existsSync(path.join(home, ".claude", "skills", "demo-skill", "SKILL.md")),
		"skill readable through the per-tool share link",
	);
	assert.ok(
		readFileSync(
			path.join(home, ".claude", "skills", "demo-skill", "SKILL.md"),
			"utf8",
		).includes("demo"),
	);

	// new persona in the roster appears through existing links (no re-run)
	writeFileSync(
		path.join(roster, "late.md"),
		"---\nname: late\ndescription: later\n---\n\nb\n",
	);
	assert.ok(existsSync(path.join(claudeAgents, "late.md")));

	// doctor now clean of share issues
	const d1 = run(["doctor", "--json"], { envHome: home });
	const d1data = parseJson(d1.stdout).data;
	assert.ok(
		!d1data.issues.some(
			(i) => i.includes("link agents") || i.includes("link skills"),
		),
		`issues after link: ${JSON.stringify(d1data.issues)}`,
	);

	// unknown kind errors
	const bad = run(["link", "personas", "--json"], { envHome: home });
	assert.notEqual(bad.code, 0);

	// native dir refusal: unlink codex first (it was linked earlier in the
	// test), then place real content, then re-link — must refuse, not clobber.
	const codexAgents = path.join(home, ".codex", "agents");
	run(["unlink", "agents", "-t", "codex", "--json"], { envHome: home });
	mkdirSync(codexAgents, { recursive: true });
	writeFileSync(path.join(codexAgents, "own.md"), "native");
	const nat = run(["link", "agents", "-t", "codex", "--json"], {
		envHome: home,
	});
	const natData = parseJson(nat.stdout).data;
	assert.ok(natData.results.every((r) => r.blocked === "native-content"));
	assert.equal(readFileSync(path.join(codexAgents, "own.md"), "utf8"), "native");

	// --force backs up native content, never deletes it
	const forced = run(["link", "agents", "-t", "codex", "--force", "--json"], {
		envHome: home,
	});
	const forcedData = parseJson(forced.stdout).data;
	const row = forcedData.results.find((r) => r.id === "codex");
	assert.ok(row.linked && row.backup, JSON.stringify(row));
	assert.ok(
		readFileSync(path.join(row.backup, "own.md"), "utf8") === "native",
		"native content preserved in backup",
	);

	// unlink removes only OUR links; native/backup untouched
	const un = run(["unlink", "skills", "--json"], { envHome: home });
	const unData = parseJson(un.stdout).data;
	assert.ok(unData.results.some((r) => r.id === "claude" && r.unlinked));
	assert.ok(!existsSync(path.join(home, ".claude", "skills")));
});

test("share link warnings surface in brief and vanish after linking", () => {
	const home = run(["init"]).home;
	run(["target", "enable", "claude"], { envHome: home }); // share-capable + enabled
	const roster = path.join(home, ".agents", "agents");
	mkdirSync(roster, { recursive: true });
	writeFileSync(
		path.join(roster, "scout.md"),
		"---\nname: scout\ndescription: s\n---\n\nb\n",
	);

	const j = run(["brief", "--json"], { envHome: home });
	ok(j);
	const data = parseJson(j.stdout).data;
	assert.ok(
		data.warnings.some((w) => w.includes("agent-cli link agents")),
		`warnings: ${JSON.stringify(data.warnings)}`,
	);

	ok(run(["link", "agents", "--json"], { envHome: home }));
	const j2 = run(["brief", "--json"], { envHome: home });
	const data2 = parseJson(j2.stdout).data;
	assert.ok(
		!data2.warnings.some((w) => w.includes("link agents")),
		`warnings after: ${JSON.stringify(data2.warnings)}`,
	);
});

test("snapshot create emits a populated JSON envelope (regression: missing await)", () => {
	// Regression for CodeQL P0-1: memory-ops.js called `snap()` without await,
	// so spreading the Promise into emit() produced `data: {}` and human mode
	// rendered "Snapshot undefined: undefined files → undefined".
	const home = run(["init"]).home;
	// seed a file so the snapshot count is meaningful
	const brain = path.join(home, ".agents");
	mkdirSync(path.join(brain, "agents"), { recursive: true });
	writeFileSync(path.join(brain, "AGENTS.md"), "# master\n");
	writeFileSync(path.join(brain, "agents", "scout.md"), "x\n");
	const r = parseJson(
		run(["snapshot", "create", "foo", "--json"], { envHome: home }).stdout,
	);
	assert.equal(r.ok, true, `envelope: ${JSON.stringify(r)}`);
	assert.equal(r.data.ok, true, `data: ${JSON.stringify(r.data)}`);
	assert.equal(
		typeof r.data.name,
		"string",
		`name missing: ${JSON.stringify(r.data)}`,
	);
	assert.equal(
		typeof r.data.files,
		"number",
		`files missing: ${JSON.stringify(r.data)}`,
	);
	assert.ok(r.data.files >= 2, `expected ≥2 files, got ${r.data.files}`);
	assert.ok(typeof r.data.path === "string" && r.data.path.length > 0);
});
