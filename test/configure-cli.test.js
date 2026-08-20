// Integration tests for the runner CLI surface: `agent-cli configure run` +
// `agent-cli run` end-to-end through REAL child processes (fixture CLIs written
// into a temp dir and pointed at via AGENT_RUN_BIN_PI/AGENT_RUN_BIN_CODEX —
// resolveSpawn runs .cjs targets through node, so the fixtures spawn
// cross-platform without any shell). Isolated AGENT_CLI_HOME per invocation,
// following the test/cli.test.js helper pattern.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.resolve("src/cli.js");

// Fixture CLIs (module-level, shared by every test): fake-pi reads the
// trailing @promptFile arg; fake-codex echoes its last argv (the task).
const FIX = mkdtempSync(path.join(tmpdir(), "agent-cfgcli-fix-"));
const FAKE_PI = path.join(FIX, "fake-pi.cjs");
const FAKE_CODEX = path.join(FIX, "fake-codex.cjs");
writeFileSync(
	FAKE_PI,
	[
		"// fixture: stands in for the `pi` CLI (reads the @promptFile arg)",
		"const args = process.argv.slice(2);",
		'if (process.env.FAKE_PI_QUOTA === "1") {',
		'\tconsole.error("API Error: 429 rate limit exceeded (quota reached)");',
		"\tprocess.exit(1);",
		"}",
		'const at = args.find((a) => a.startsWith("@"));',
		'if (!at) { console.error("fake-pi: no @promptFile arg"); process.exit(2); }',
		'const prompt = require("fs").readFileSync(at.slice(1), "utf8").trim();',
		'console.log("FAKE-PI-OK " + prompt);',
	].join("\n"),
);
writeFileSync(
	FAKE_CODEX,
	[
		"// fixture: stands in for the `codex` CLI (task is the trailing arg)",
		"const args = process.argv.slice(2);",
		'console.log("FAKE-CODEX-OK " + (args[args.length - 1] ?? ""));',
	].join("\n"),
);

function run(args, { envHome, cwd, env: extraEnv } = {}) {
	const env = { ...process.env };
	// Runner binaries never leak in from the outer environment.
	delete env.AGENT_RUN_BIN_PI;
	delete env.AGENT_RUN_BIN_CODEX;
	delete env.FAKE_PI_QUOTA;
	Object.assign(env, extraEnv || {});
	const home = envHome || mkdtempSync(path.join(tmpdir(), "agent-cfgcli-"));
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

/** Configure pi (+codex fallback) in a fresh isolated home, point both tools
 *  at the fixtures, and return that home for follow-up invocations. */
function configuredHome() {
	const env = { AGENT_RUN_BIN_PI: FAKE_PI, AGENT_RUN_BIN_CODEX: FAKE_CODEX };
	const r = run(
		[
			"configure",
			"run",
			"pi",
			"--provider",
			"zai",
			"--model",
			"glm-5.3",
			"--thinking",
			"high",
			"--fallback",
			"codex:gpt-5.6-luna",
		],
		{ env },
	);
	ok(r);
	return r.home;
}

test("configure run pi persists the runners entry and makes it the default", () => {
	const home = configuredHome();
	const cfg = JSON.parse(
		readFileSync(path.join(home, ".agents", "config.json"), "utf8"),
	);
	assert.equal(cfg.runners.default, "pi");
	assert.deepEqual(cfg.runners.tools.pi, {
		provider: "zai",
		model: "glm-5.3",
		thinking: "high",
		fallbacks: ["codex:gpt-5.6-luna"],
	});
	// `agent-cli config` exposes the same entry.
	const c = run(["config", "--json"], { envHome: home });
	ok(c);
	assert.equal(parseJson(c.stdout).data.config.runners.default, "pi");
	assert.equal(
		parseJson(c.stdout).data.config.runners.tools.pi.model,
		"glm-5.3",
	);
});

test("bare `configure run` exits 0 and lists the configured tool", () => {
	const home = configuredHome();
	const r = run(["configure", "run"], { envHome: home });
	ok(r);
	assert.match(r.stdout, /pi/);
	assert.match(r.stdout, /glm-5\.3/);
});

test("`agent-cli run` dispatches to the real fixture CLI (prompt-file path)", () => {
	const home = configuredHome();
	const r = run(["run", "hello world"], {
		envHome: home,
		env: { AGENT_RUN_BIN_PI: FAKE_PI, AGENT_RUN_BIN_CODEX: FAKE_CODEX },
	});
	ok(r);
	assert.match(r.stdout, /FAKE-PI-OK hello world/);
	assert.doesNotMatch(r.stdout, /FAKE-CODEX/);
});

test("quota failure on pi falls through to the codex fixture, exit 0, attempts[0].kind === quota", () => {
	const home = configuredHome();
	const r = run(["run", "--json", "fix the bug please"], {
		envHome: home,
		env: {
			AGENT_RUN_BIN_PI: FAKE_PI,
			AGENT_RUN_BIN_CODEX: FAKE_CODEX,
			FAKE_PI_QUOTA: "1",
		},
	});
	ok(r);
	const j = parseJson(r.stdout);
	assert.equal(j.ok, true);
	assert.equal(j.data.tool, "codex");
	assert.match(j.data.output, /FAKE-CODEX-OK fix the bug please/);
	assert.equal(j.data.attempts.length, 1);
	assert.equal(j.data.attempts[0].tool, "pi");
	assert.equal(j.data.attempts[0].kind, "quota");
});

test("`agent-cli run` with no task / no runners configured exits non-zero with guidance", () => {
	// No task text → usage guidance (new runner mode via --tool).
	const usage = run(["run", "--tool", "pi"]);
	bad(usage);
	assert.match(usage.stderr + usage.stdout, /Usage: agent-cli run/);
	// Task text but nothing configured → config guidance.
	const home = mkdtempSync(path.join(tmpdir(), "agent-cfgcli-"));
	const uncfg = run(["run", "do the thing"], { envHome: home });
	bad(uncfg);
	assert.match(uncfg.stderr + uncfg.stdout, /No runners configured/);
});
