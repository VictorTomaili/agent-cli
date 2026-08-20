// Unit tests for src/runners.js — runner config (agent configure run) +
// task dispatch with fallbacks (agent run). In-process with an isolated
// AGENT_CLI_HOME (imported AFTER the env is set, like test/config.test.js).
import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-runners-"));
process.env.AGENT_CLI_HOME = TMP;
delete process.env.AGENT_RUN_BIN_PI;
delete process.env.AGENT_RUN_BIN_CODEX;

const runners = await import("../src/runners.js");

const CONFIG = path.join(TMP, ".agents", "config.json");
const resetConfig = () => {
	mkdirSync(path.dirname(CONFIG), { recursive: true });
	writeFileSync(CONFIG, JSON.stringify({ version: 2, global: [] }));
};

// ---------------------------------------------------------------------------
// parseFallback
// ---------------------------------------------------------------------------
test("KNOWN_TOOLS is the closed tool list", () => {
	assert.deepEqual(runners.KNOWN_TOOLS, ["pi", "codex"]);
});

test("parseFallback: pi spec with provider, model and thinking", () => {
	assert.deepEqual(runners.parseFallback("pi:zai/glm-5.3:high"), {
		tool: "pi",
		provider: "zai",
		model: "glm-5.3",
		thinking: "high",
	});
});

test("parseFallback: pi spec without thinking", () => {
	assert.deepEqual(runners.parseFallback("pi:anthropic/claude-sonnet-4-5"), {
		tool: "pi",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		thinking: null,
	});
});

test("parseFallback: codex has no provider", () => {
	assert.deepEqual(runners.parseFallback("codex:gpt-5.6-luna"), {
		tool: "codex",
		provider: null,
		model: "gpt-5.6-luna",
		thinking: null,
	});
});

test("parseFallback: codex with optional provider and thinking", () => {
	assert.deepEqual(runners.parseFallback("codex:openai/gpt-5.1:high"), {
		tool: "codex",
		provider: "openai",
		model: "gpt-5.1",
		thinking: "high",
	});
});

test("parseFallback: malformed specs throw descriptive errors", () => {
	assert.throws(
		() => runners.parseFallback("zai/glm-5.3"),
		/Invalid fallback spec/,
	);
	assert.throws(() => runners.parseFallback("pi:"), /missing model/);
	assert.throws(() => runners.parseFallback("pi:glm-5.3"), /needs a provider/);
	assert.throws(() => runners.parseFallback(""), /Invalid fallback spec/);
	assert.throws(() => runners.parseFallback("pi:/model"), /empty provider/);
});

test("parseFallback: unknown tool throws", () => {
	assert.throws(() => runners.parseFallback("vibe:x/y"), /Unknown tool 'vibe'/);
});

// ---------------------------------------------------------------------------
// setRunner / getRunners (config.json persistence)
// ---------------------------------------------------------------------------
test("setRunner persists entries; the first tool becomes default automatically", () => {
	resetConfig();
	const entry = runners.setRunner("pi", {
		provider: "zai",
		model: "glm-5.3",
		thinking: "high",
		fallbacks: ["codex:gpt-5.6-luna"],
	});
	assert.equal(entry.model, "glm-5.3");
	const saved = JSON.parse(readFileSync(CONFIG, "utf8"));
	assert.equal(saved.runners.default, "pi");
	assert.equal(saved.runners.tools.pi.provider, "zai");
	assert.equal(saved.runners.tools.pi.model, "glm-5.3");
	assert.deepEqual(saved.runners.tools.pi.fallbacks, ["codex:gpt-5.6-luna"]);
	assert.equal(runners.getRunners().tools.pi.model, "glm-5.3");
});

test("setRunner: a second tool does not steal default; makeDefault forces it", () => {
	runners.setRunner("codex", { model: "gpt-5.6-luna" });
	assert.equal(runners.getRunners().default, "pi");
	runners.setRunner("codex", { model: "gpt-5.6-luna", makeDefault: true });
	assert.equal(runners.getRunners().default, "codex");
});

test("setRunner merges over the previous entry (unspecified fields survive)", () => {
	runners.setRunner("pi", { model: "glm-5.4" });
	const pi = runners.getRunners().tools.pi;
	assert.equal(pi.model, "glm-5.4"); // updated
	assert.equal(pi.thinking, "high"); // preserved
	assert.equal(pi.provider, "zai"); // preserved
});

test("setRunner rejects unknown tools, missing model and malformed fallbacks", () => {
	resetConfig();
	assert.throws(() => runners.setRunner("vibe", { model: "x" }), /Unknown tool/);
	assert.throws(
		() => runners.setRunner("pi", { provider: "zai" }),
		/--model is required/,
	);
	assert.throws(
		() =>
			runners.setRunner("pi", { provider: "z", model: "m", fallbacks: ["bogus"] }),
		/Invalid fallback spec/,
	);
	// nothing was persisted by the rejected calls
	assert.deepEqual(runners.getRunners(), { default: null, tools: {} });
});

test("setRunner refuses to replace a corrupt config; getRunners reads empty", () => {
	writeFileSync(CONFIG, "{ broken json");
	assert.throws(
		() => runners.setRunner("pi", { provider: "z", model: "m" }),
		/config\.json is corrupt/,
	);
	assert.equal(readFileSync(CONFIG, "utf8"), "{ broken json");
	assert.deepEqual(runners.getRunners(), { default: null, tools: {} });
	resetConfig();
});

// ---------------------------------------------------------------------------
// resolveChain
// ---------------------------------------------------------------------------
test("resolveChain: the chosen tool's entry first, then parsed fallbacks", () => {
	resetConfig();
	runners.setRunner("pi", {
		provider: "zai",
		model: "glm-5.3",
		thinking: "high",
		fallbacks: ["codex:gpt-5.6-luna", "pi:openrouter/qwen3-coder:medium"],
	});
	const chain = runners.resolveChain({});
	assert.equal(chain.length, 3);
	assert.deepEqual(chain[0], {
		tool: "pi",
		provider: "zai",
		model: "glm-5.3",
		thinking: "high",
	});
	assert.deepEqual(chain[1], {
		tool: "codex",
		provider: null,
		model: "gpt-5.6-luna",
		thinking: null,
	});
	assert.deepEqual(chain[2], {
		tool: "pi",
		provider: "openrouter",
		model: "qwen3-coder",
		thinking: "medium",
	});
});

test("resolveChain: toolOverride picks that tool's chain", () => {
	runners.setRunner("codex", { model: "gpt-5.6-luna" });
	const chain = runners.resolveChain({ toolOverride: "codex" });
	assert.equal(chain[0].tool, "codex");
	assert.equal(chain[0].model, "gpt-5.6-luna");
});

test("resolveChain errors when nothing is configured or the tool is unknown", () => {
	resetConfig();
	assert.throws(() => runners.resolveChain({}), /No runners configured/);
	runners.setRunner("pi", { provider: "zai", model: "m" });
	assert.throws(
		() => runners.resolveChain({ toolOverride: "codex" }),
		/Runner 'codex' is not configured/,
	);
});

// ---------------------------------------------------------------------------
// buildArgv
// ---------------------------------------------------------------------------
test("buildArgv pi: full arg vector, @promptFile last, task never on argv", () => {
	const { cmd, args } = runners.buildArgv(
		{ tool: "pi", provider: "zai", model: "glm-5.3", thinking: "high" },
		{ task: "do the thing", promptFile: "/tmp/p.md", readOnly: false },
	);
	assert.equal(cmd, "pi");
	assert.deepEqual(args, [
		"-p",
		"--no-session",
		"--offline",
		"-na",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--provider",
		"zai",
		"--model",
		"glm-5.3",
		"--thinking",
		"high",
		"@/tmp/p.md",
	]);
	assert.ok(!args.includes("do the thing"), "task text must not be argv");
});

test("buildArgv pi: read-only adds the read-only tool allowlist; no thinking flag when unset", () => {
	const { args } = runners.buildArgv(
		{ tool: "pi", provider: "zai", model: "m" },
		{ task: "t", promptFile: "/x.md", readOnly: true },
	);
	assert.deepEqual(args.slice(-3), ["--tools", "read,grep,find,ls", "@/x.md"]);
	assert.ok(!args.includes("--thinking"));
});

test("buildArgv pi: AGENT_RUN_BIN_PI overrides the binary", () => {
	process.env.AGENT_RUN_BIN_PI = "/opt/pi/bin/pi";
	try {
		const { cmd } = runners.buildArgv(
			{ tool: "pi", provider: "z", model: "m" },
			{ task: "t", promptFile: "/x" },
		);
		assert.equal(cmd, "/opt/pi/bin/pi");
	} finally {
		delete process.env.AGENT_RUN_BIN_PI;
	}
});

test("buildArgv codex: sandbox flag by readOnly, model + task on argv", () => {
	const w = runners.buildArgv(
		{ tool: "codex", model: "gpt-5.6-luna" },
		{ task: "say hi", readOnly: false },
	);
	assert.equal(w.cmd, "codex");
	assert.deepEqual(w.args, [
		"exec",
		"-s",
		"workspace-write",
		"-m",
		"gpt-5.6-luna",
		"say hi",
	]);
	const ro = runners.buildArgv(
		{ tool: "codex", model: "gpt-5.6-luna" },
		{ task: "say hi", readOnly: true },
	);
	assert.deepEqual(ro.args, [
		"exec",
		"-s",
		"read-only",
		"-m",
		"gpt-5.6-luna",
		"say hi",
	]);
});

test("buildArgv codex: AGENT_RUN_BIN_CODEX overrides the binary", () => {
	process.env.AGENT_RUN_BIN_CODEX = "/opt/codex/bin/codex";
	try {
		const { cmd } = runners.buildArgv(
			{ tool: "codex", model: "m" },
			{ task: "t" },
		);
		assert.equal(cmd, "/opt/codex/bin/codex");
	} finally {
		delete process.env.AGENT_RUN_BIN_CODEX;
	}
});

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------
test("classifyFailure: quota-shaped output vs generic error", () => {
	assert.equal(runners.classifyFailure("Error: rate limit exceeded"), "quota");
	assert.equal(runners.classifyFailure("HTTP 429 too many requests"), "quota");
	assert.equal(runners.classifyFailure("usage limit reached"), "quota");
	assert.equal(runners.classifyFailure("insufficient balance"), "quota");
	assert.equal(runners.classifyFailure("quota exhausted for today"), "quota");
	assert.equal(runners.classifyFailure("command not found: pi"), "error");
	assert.equal(runners.classifyFailure(""), "error");
});

// ---------------------------------------------------------------------------
// runTask (injectable spawnImpl)
// ---------------------------------------------------------------------------
test("runTask: first attempt succeeds — pi prompt file written before spawn, cleaned up after", () => {
	resetConfig();
	runners.setRunner("pi", {
		provider: "zai",
		model: "glm-5.3",
		thinking: "high",
	});
	const seen = [];
	const res = runners.runTask({
		task: "say hi please",
		toolOverride: "pi",
		timeoutMs: 12345,
		cwd: TMP,
		spawnImpl: (cmd, args, opts) => {
			seen.push({ cmd, args, opts });
			const at = args.find((a) => a.startsWith("@"));
			assert.ok(at, "pi argv must carry the @promptFile arg");
			const file = at.slice(1);
			assert.ok(existsSync(file), "prompt file exists during spawn");
			assert.equal(readFileSync(file, "utf8"), "say hi please");
			seen.push({ promptFile: file });
			return { status: 0, stdout: "hello from pi\n", stderr: "" };
		},
	});
	assert.equal(res.ok, true);
	assert.equal(res.tool, "pi");
	assert.equal(res.provider, "zai");
	assert.equal(res.model, "glm-5.3");
	assert.equal(res.output, "hello from pi");
	assert.deepEqual(res.attempts, []);
	// spawn options are the hardened profile
	assert.equal(seen[0].cmd, "pi");
	assert.equal(seen[0].opts.shell, false);
	assert.equal(seen[0].opts.timeout, 12345);
	assert.equal(seen[0].opts.windowsHide, true);
	assert.equal(seen[0].opts.cwd, TMP);
	assert.deepEqual(seen[0].opts.stdio, ["ignore", "pipe", "pipe"]);
	// prompt file removed after the attempt
	assert.ok(!existsSync(seen[1].promptFile), "prompt file cleaned up");
});

test("runTask: quota failure on pi falls through to the codex fallback", () => {
	resetConfig();
	runners.setRunner("pi", {
		provider: "zai",
		model: "glm-5.3",
		fallbacks: ["codex:gpt-5.6-luna"],
	});
	const calls = [];
	const res = runners.runTask({
		task: "do work",
		spawnImpl: (cmd) => {
			calls.push(cmd);
			if (calls.length === 1)
				return {
					status: 1,
					stdout: "",
					stderr: "API Error: 429 rate limit exceeded, quota reached",
				};
			return { status: 0, stdout: "codex handled it", stderr: "" };
		},
	});
	assert.equal(res.ok, true);
	assert.equal(res.tool, "codex");
	assert.equal(res.model, "gpt-5.6-luna");
	assert.equal(res.provider, null);
	assert.equal(res.output, "codex handled it");
	assert.equal(res.attempts.length, 1);
	assert.equal(res.attempts[0].tool, "pi");
	assert.equal(res.attempts[0].kind, "quota");
	assert.match(res.attempts[0].detail, /rate limit/);
	assert.deepEqual(calls, ["pi", "codex"]);
});

test("runTask: all entries fail → ok:false with an attempt per entry", () => {
	resetConfig();
	runners.setRunner("codex", {
		model: "quota-model",
		fallbacks: ["codex:ok-model"],
	});
	const res = runners.runTask({
		task: "x",
		spawnImpl: () => ({ status: 1, stdout: "", stderr: "boom" }),
	});
	assert.equal(res.ok, false);
	assert.equal(res.attempts.length, 2);
	assert.equal(res.attempts[0].kind, "error");
	assert.equal(res.attempts[0].model, "quota-model");
	assert.equal(res.attempts[1].model, "ok-model");
	assert.equal(res.attempts[1].detail, "boom");
});

test("runTask: attempt detail keeps only the last 400 chars", () => {
	resetConfig();
	runners.setRunner("codex", { model: "m" });
	const long = "e".repeat(1000);
	const res = runners.runTask({
		task: "x",
		spawnImpl: () => ({ status: 1, stdout: "", stderr: long }),
	});
	assert.equal(res.ok, false);
	assert.equal(res.attempts[0].detail.length, 400);
	assert.equal(res.attempts[0].detail, "e".repeat(400));
});

test("runTask: spawn errors (missing binary) record an attempt and fall through", () => {
	resetConfig();
	runners.setRunner("pi", {
		provider: "z",
		model: "m",
		fallbacks: ["codex:gpt-5.6-luna"],
	});
	const res = runners.runTask({
		task: "x",
		spawnImpl: (cmd) =>
			cmd === "pi"
				? { error: new Error("spawn pi ENOENT"), status: null }
				: { status: 0, stdout: "ok", stderr: "" },
	});
	assert.equal(res.ok, true);
	assert.equal(res.tool, "codex");
	assert.equal(res.attempts.length, 1);
	assert.equal(res.attempts[0].kind, "error");
	assert.match(res.attempts[0].detail, /ENOENT/);
});

test("runTask throws (not returns) when no runners are configured", () => {
	resetConfig();
	assert.throws(
		() =>
			runners.runTask({
				task: "x",
				spawnImpl: () => assert.fail("never spawned"),
			}),
		/No runners configured/,
	);
});

// ---------------------------------------------------------------------------
// resolveSpawn (Windows npm-shim resolution — never a shell)
// ---------------------------------------------------------------------------
test("resolveSpawn: a direct .cjs path runs through node itself", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "agent-respawn-"));
	const cli = path.join(dir, "fake-tool.cjs");
	writeFileSync(cli, "console.log('ok')\n");
	const r = runners.resolveSpawn(cli, ["exec", "-m", "some model"]);
	assert.equal(r.cmd, process.execPath);
	assert.deepEqual(r.args, [cli, "exec", "-m", "some model"]);
});

test("resolveSpawn: npm-style .cmd shim on PATH resolves to node + the absolute js target", () => {
	if (process.platform !== "win32") {
		// Non-win32 never parses .cmd shims — direct spawn (rule c), verified
		// with a real file so the path resolves.
		const dir2 = mkdtempSync(path.join(tmpdir(), "agent-respawn-"));
		const shim = path.join(dir2, "x.cmd");
		writeFileSync(shim, "@echo off\n");
		assert.deepEqual(runners.resolveSpawn(shim, ["a"]), {
			cmd: shim,
			args: ["a"],
		});
		return;
	}
	// A realistic npm cmd-shim + its real JS target living beside it.
	const dir = mkdtempSync(path.join(tmpdir(), "agent-respawn-"));
	const jsTarget = path.join(dir, "node_modules", "tool", "bin", "cli.js");
	mkdirSync(path.dirname(jsTarget), { recursive: true });
	writeFileSync(jsTarget, "#!/usr/bin/env node\nconsole.log('tool entry')\n");
	writeFileSync(
		path.join(dir, "tool.cmd"),
		[
			"@ECHO off",
			"GOTO start",
			":find_dp0",
			"SET dp0=%~dp0",
			":start",
			'IF EXIST "%dp0%\\node.exe" (',
			'  SET "_prog=%dp0%\\node.exe"',
			") ELSE (",
			'  SET "_prog=node"',
			"  SET PATHEXT=%PATHEXT:;.JS;=;%",
			")",
			"endLocal & goto #_undefined_#",
			"",
			'"%_prog%"   "%~dp0\\node_modules\\tool\\bin\\cli.js" %*',
		].join("\r\n"),
	);
	// npm also drops an extensionless POSIX sh-script sibling next to the
	// .cmd — it must NOT shadow the spawnable shim on win32.
	writeFileSync(
		path.join(dir, "tool"),
		'#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/node_modules/tool/bin/cli.js" "$@"\n',
	);
	const savedPath = process.env.PATH;
	process.env.PATH = dir + path.delimiter + savedPath;
	try {
		// Bare name found through PATH + extension probing (".cmd" probe).
		const r = runners.resolveSpawn("tool", ["--flag", "task text"]);
		assert.equal(r.cmd, process.execPath);
		assert.equal(path.resolve(r.args[0]), path.resolve(jsTarget));
		assert.deepEqual(r.args.slice(1), ["--flag", "task text"]);
		// Explicit path to the shim resolves the same way.
		const r2 = runners.resolveSpawn(path.join(dir, "tool.cmd"), []);
		assert.equal(r2.cmd, process.execPath);
		assert.equal(path.resolve(r2.args[0]), path.resolve(jsTarget));
		assert.deepEqual(r2.args.slice(1), []);
	} finally {
		process.env.PATH = savedPath;
	}
});

test("resolveSpawn: a non-npm .cmd shim throws — never a cmd.exe invocation", () => {
	if (process.platform !== "win32") return; // .cmd files only parse on win32
	const dir = mkdtempSync(path.join(tmpdir(), "agent-respawn-"));
	const evil = path.join(dir, "evil.cmd");
	writeFileSync(evil, "@echo off\r\necho raw batch file, not a shim\r\n");
	// Must throw (fail closed) — the only alternative would be routing the
	// task through cmd.exe, which this repo forbids for untrusted text.
	assert.throws(
		() => runners.resolveSpawn(evil, ["payload & del *.*"]),
		/unsupported \.cmd shim \(not an npm cmd-shim\)/,
	);
	const savedPath = process.env.PATH;
	process.env.PATH = dir + path.delimiter + savedPath;
	try {
		assert.throws(
			() => runners.resolveSpawn("evil", []),
			/command not found|unsupported \.cmd shim/,
		);
	} finally {
		process.env.PATH = savedPath;
	}
});

test("resolveSpawn: missing command → command not found", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "agent-respawn-"));
	const savedPath = process.env.PATH;
	process.env.PATH = dir; // empty temp dir — nothing to find
	try {
		assert.throws(
			() => runners.resolveSpawn("no-such-agent-tool-xyz", ["a"]),
			/command not found: no-such-agent-tool-xyz/,
		);
	} finally {
		process.env.PATH = savedPath;
	}
});

test("runTask (real spawn path): an unresolvable runner records a spawn-kind attempt and falls through", () => {
	resetConfig();
	// fake: codex is resolvable via AGENT_RUN_BIN_CODEX (.cjs → node-direct)
	const dir = mkdtempSync(path.join(tmpdir(), "agent-respawn-"));
	const codexBin = path.join(dir, "fake-codex.cjs");
	writeFileSync(
		codexBin,
		"console.log('FAKE-CODEX-OK ' + process.argv.slice(2).pop())\n",
	);
	process.env.AGENT_RUN_BIN_PI = path.join(dir, "no-such-pi-binary.js");
	process.env.AGENT_RUN_BIN_CODEX = codexBin;
	try {
		runners.setRunner("pi", {
			provider: "z",
			model: "m",
			fallbacks: ["codex:gpt-5.6-luna"],
		});
		// Bare unresolvable name → resolveSpawn throws → spawn-kind attempt.
		process.env.AGENT_RUN_BIN_PI = "no-such-pi-binary-xyz";
		const res = runners.runTask({ task: "x" }); // real spawnSync, no impl
		assert.equal(res.ok, true);
		assert.equal(res.tool, "codex");
		assert.match(res.output, /FAKE-CODEX-OK/);
		assert.equal(res.attempts.length, 1);
		assert.equal(res.attempts[0].tool, "pi");
		assert.equal(res.attempts[0].kind, "spawn");
		assert.match(
			res.attempts[0].detail,
			/command not found: no-such-pi-binary-xyz/,
		);
	} finally {
		delete process.env.AGENT_RUN_BIN_PI;
		delete process.env.AGENT_RUN_BIN_CODEX;
	}
});
