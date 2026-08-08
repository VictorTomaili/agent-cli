import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate HOME before importing agent-cli modules.
const TMP = mkdtempSync(path.join(tmpdir(), "agent-hooks-"));
process.env.AGENT_CLI_HOME = TMP;

const hooks = await import("../src/hooks.js");
const targets = await import("../src/targets.js");

const AGENT_BIN = "C:/path/to/agent";

function writeJson(p, obj) {
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(obj, null, 2));
}

test("targetsWithHooks returns exactly 12 ids", () => {
	const list = hooks.targetsWithHooks();
	const ids = list.map((t) => t.id);
	assert.equal(list.length, 12);
	// The 12 expected ids, in registry order.
	assert.deepEqual(
		ids,
		["claude", "codex", "pi", "gemini", "cursor", "windsurf", "cline", "copilot", "junie", "trae", "opencode", "goose"],
	);
});

test("every hook-capable target declares event + configFile + home-relative path", () => {
	for (const t of hooks.targetsWithHooks()) {
		assert.ok(t.hooks.event, t.id + " missing event");
		assert.ok(t.hooks.configFile, t.id + " missing configFile");
		assert.ok(!path.isAbsolute(t.hooks.configFile), t.id + " configFile must be home-relative");
	}
});

test("renderHookConfig produces the Claude shape with our marker", () => {
	const claude = targets.getTarget("claude");
	const r = hooks.renderHookConfig(claude, { agentBin: AGENT_BIN });
	assert.equal(r.event, "SessionStart");
	assert.equal(r.configFile, ".claude/settings.json");
	assert.equal(r.hookCount, 1);
	assert.ok(r.json.hooks.SessionStart[0].hooks[0].name === hooks.HOOK_MARKER);
	assert.ok(r.json.hooks.SessionStart[0].hooks[0].command.includes(AGENT_BIN));
});

test("renderHookConfig embeds the marker in the claude target's command string too (regression: `claude plugin install/uninstall` re-serializes settings.json through its own schema and silently drops the `name` field)", () => {
	const claude = targets.getTarget("claude");
	const r = hooks.renderHookConfig(claude, { agentBin: AGENT_BIN });
	const command = r.json.hooks.SessionStart[0].hooks[0].command;
	assert.ok(command.includes(hooks.HOOK_MARKER), "command string must carry the marker independent of the name field");
	// Simulate Claude Code stripping the `name` field on a settings.json rewrite:
	// parseAgentCliHookEntry must still recognize the entry via the command string alone.
	const strippedEntry = { type: "command", command };
	assert.equal(hooks.parseAgentCliHookEntry(strippedEntry), true);
});

test("renderHookConfig does NOT embed the marker comment in other default-shape targets (codex/pi/gemini aren't rewritten by an external schema-typed tool)", () => {
	for (const id of ["codex", "pi", "gemini"]) {
		const target = targets.getTarget(id);
		const r = hooks.renderHookConfig(target, { agentBin: AGENT_BIN });
		const command = r.json.hooks[r.event][0].hooks[0].command;
		assert.ok(!command.includes(hooks.HOOK_MARKER), `${id} command should rely on the name field only, got: ${command}`);
	}
});

test("renderHookConfig produces the opencode array shape", () => {
	const oc = targets.getTarget("opencode");
	const r = hooks.renderHookConfig(oc, { agentBin: AGENT_BIN });
	assert.equal(r.event, "session_start");
	assert.ok(Array.isArray(r.json.hooks));
	assert.equal(r.json.hooks[0].name, hooks.HOOK_MARKER);
	assert.deepEqual(r.json.hooks[0].command, [AGENT_BIN, "brief", "--oneline"]);
});

test("renderHookConfig produces the cursor versioned shape", () => {
	const cur = targets.getTarget("cursor");
	const r = hooks.renderHookConfig(cur, { agentBin: AGENT_BIN });
	assert.equal(r.json.version, 1);
	assert.ok(Array.isArray(r.json.hooks.sessionStart));
	assert.equal(r.json.hooks.sessionStart[0].name, hooks.HOOK_MARKER);
});

test("renderHookConfig produces the windsurf pre_user_prompt shape with marker in command", () => {
	const w = targets.getTarget("windsurf");
	const r = hooks.renderHookConfig(w, { agentBin: AGENT_BIN });
	assert.equal(r.event, "pre_user_prompt");
	const entry = r.json.hooks.pre_user_prompt[0];
	assert.ok(entry.command.includes(hooks.HOOK_MARKER));
	assert.equal(entry.show_output, false);
});

test("parseAgentCliHookEntry identifies our entries and rejects others", () => {
	assert.equal(
		hooks.parseAgentCliHookEntry({ name: hooks.HOOK_MARKER, command: "x" }),
		true,
	);
	assert.equal(
		hooks.parseAgentCliHookEntry({ command: "/usr/local/bin/agent brief --oneline" }),
		false,
	);
	assert.equal(
		hooks.parseAgentCliHookEntry({ command: ["agent", "brief", "--oneline"] }),
		false,
	);
	assert.equal(
		hooks.parseAgentCliHookEntry({
			command: ["/usr/local/bin/agent", "brief", "--oneline"],
			name: hooks.HOOK_MARKER,
		}),
		true,
	);
	assert.equal(hooks.parseAgentCliHookEntry(null), false);
});

test("pickWindowsAgentBin prefers a .exe/.cmd/.bat match over an extensionless POSIX shim (regression: `where agent` on Windows can list the shim first, which native shells can't execute)", () => {
	assert.equal(
		hooks.pickWindowsAgentBin([
			"C:\\Users\\victor\\AppData\\Roaming\\npm\\agent",
			"C:\\Users\\victor\\AppData\\Roaming\\npm\\agent.cmd",
			"C:\\Users\\victor\\.grok\\bin\\agent.exe",
		]),
		"C:\\Users\\victor\\AppData\\Roaming\\npm\\agent.cmd",
	);
	assert.equal(
		hooks.pickWindowsAgentBin(["C:\\only\\extensionless\\agent"]),
		"C:\\only\\extensionless\\agent",
		"falls back to the first line when nothing matches a recognized extension",
	);
});

test("detectAgentBin returns { bin, extraArgs } with a non-empty bin (no exact assertion)", () => {
	const result = hooks.detectAgentBin();
	assert.ok(typeof result === "object" && result !== null, "expected an object");
	assert.ok(typeof result.bin === "string" && result.bin.length > 0, `expected non-empty bin, got: ${result.bin}`);
	assert.ok(Array.isArray(result.extraArgs), "expected extraArgs to be an array");
});

test("renderHookConfig quotes a single-token agentBin as one path, args unquoted (regression: quoteCommand used to wrap the whole invocation in one quote pair, making it an unparseable single token)", () => {
	// Uses "codex" rather than "claude" so the assertion isolates quoteCommand's
	// behavior from the claude-specific marker-comment suffix tested separately below.
	const codex = targets.getTarget("codex");
	const r = hooks.renderHookConfig(codex, { agentBin: "C:\\Program Files\\agent-cli\\agent.cmd", briefArgs: "--json --compact --offline" });
	const command = r.json.hooks.SessionStart[0].hooks[0].command;
	assert.equal(command, '"C:\\Program Files\\agent-cli\\agent.cmd" brief --json --compact --offline');
	// The binary path is quoted as its own token; args are separate, unquoted tokens.
	assert.ok(!command.startsWith('"C:\\Program Files\\agent-cli\\agent.cmd brief'), "must not wrap args inside the binary's quotes");
});

test("renderHookConfig quotes each path segment of a two-token agentBin (node.exe + cli.js fallback) individually", () => {
	const codex = targets.getTarget("codex");
	const r = hooks.renderHookConfig(codex, {
		agentBin: { bin: "C:\\Program Files\\nodejs\\node.exe", extraArgs: ["C:\\Users\\victor\\AppData\\Roaming\\npm\\node_modules\\agent-cli\\src\\cli.js"] },
		briefArgs: "--oneline",
	});
	const command = r.json.hooks.SessionStart[0].hooks[0].command;
	assert.equal(
		command,
		'"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\victor\\AppData\\Roaming\\npm\\node_modules\\agent-cli\\src\\cli.js" brief --oneline',
	);
});

test("installHook: no existing file → creates file with our entry, returns installed:true", async () => {
	const claude = targets.getTarget("claude");
	const r = await hooks.installHook(claude, { force: false, agentBin: AGENT_BIN });
	assert.equal(r.target, "claude");
	assert.equal(r.installed, true);
	const abs = path.join(TMP, ".claude/settings.json");
	const onDisk = JSON.parse(readFileSync(abs, "utf8"));
	assert.equal(
		onDisk.hooks.SessionStart[0].hooks[0].name,
		hooks.HOOK_MARKER,
	);
});

test("installHook: existing agent-cli entry → returns skipped:already-installed", async () => {
	const claude = targets.getTarget("claude");
	// Clean slate for this target.
	rmSync(path.join(TMP, ".claude/settings.json"), { force: true });
	const r1 = await hooks.installHook(claude, { force: false, agentBin: AGENT_BIN });
	assert.equal(r1.installed, true);
	const r2 = await hooks.installHook(claude, { force: false, agentBin: AGENT_BIN });
	assert.equal(r2.skipped, "already-installed");
});

test("installHook: existing native file → refuses with blocked:native-content", async () => {
	const codex = targets.getTarget("codex");
	const abs = path.join(TMP, ".codex/hooks.json");
	writeJson(abs, {
		hooks: {
			SessionStart: [
				{ hooks: [{ type: "command", command: "/usr/bin/custom" }] },
			],
		},
	});
	const r = await hooks.installHook(codex, { force: false, agentBin: AGENT_BIN });
	assert.equal(r.blocked, "native-content");
	assert.match(r.hint, /--force/);
});

test("installHook: existing native file with --force → overwrites and preserves user entry", async () => {
	const codex = targets.getTarget("codex");
	const abs = path.join(TMP, ".codex/hooks.json");
	writeJson(abs, {
		hooks: {
			SessionStart: [
				{ hooks: [{ type: "command", command: "/usr/bin/custom" }] },
			],
		},
	});
	const r = await hooks.installHook(codex, { force: true, agentBin: AGENT_BIN });
	assert.equal(r.installed, true);
	const onDisk = JSON.parse(readFileSync(abs, "utf8"));
	const allEntries = onDisk.hooks.SessionStart.flatMap((g) => g.hooks);
	assert.ok(allEntries.some((e) => e.command === "/usr/bin/custom"), "user entry preserved");
	assert.ok(
		allEntries.some((e) => e.name === hooks.HOOK_MARKER),
		"agent-cli entry added",
	);
});

test("uninstallHook: removes only agent-cli entries", async () => {
	const codex = targets.getTarget("codex");
	await hooks.installHook(codex, { force: true, agentBin: AGENT_BIN });
	// installHook with force: true keeps the previous user entry, so we now have both.
	const r = await hooks.uninstallHook(codex);
	assert.equal(r.unlinked, true);
	const abs = path.join(TMP, ".codex/hooks.json");
	if (existsSync(abs)) {
		const onDisk = JSON.parse(readFileSync(abs, "utf8"));
		const allEntries = onDisk.hooks
			? (onDisk.hooks.SessionStart || []).flatMap((g) => g.hooks || [])
			: [];
		assert.ok(
			!allEntries.some((e) => e.name === hooks.HOOK_MARKER),
			"agent-cli entry removed",
		);
	}
});

test("statusHook reports each state correctly", async () => {
	const gemini = targets.getTarget("gemini");
	const geminiAbs = path.join(TMP, ".gemini/settings.json");
	// absent
	const before = await hooks.statusHook(gemini);
	assert.equal(before.state, "absent");
	// install
	await hooks.installHook(gemini, { force: false, agentBin: AGENT_BIN });
	const after = await hooks.statusHook(gemini);
	assert.equal(after.state, "installed");
	assert.equal(after.installed, true);
	// uninstall
	await hooks.uninstallHook(gemini);
	const gone = await hooks.statusHook(gemini);
	assert.equal(gone.installed, false);
	// file may still exist (with version:1) but no agent-cli entry
	if (existsSync(geminiAbs)) {
		assert.match(gone.state, /stale|native-content|absent/);
	}
});

test("goose install/uninstall uses YAML config.yaml", async () => {
	const goose = targets.getTarget("goose");
	const abs = path.join(TMP, ".config/goose/config.yaml");
	// clean any prior
	if (existsSync(abs)) rmSync(abs, { force: true });
	const r1 = await hooks.installHook(goose, { force: false, agentBin: AGENT_BIN });
	assert.equal(r1.installed, true);
	assert.ok(existsSync(abs), "config.yaml should be created");
	const r2 = await hooks.installHook(goose, { force: false, agentBin: AGENT_BIN });
	assert.equal(r2.skipped, "already-installed");
	const r3 = await hooks.uninstallHook(goose);
	assert.equal(r3.unlinked, true);
	// After uninstall, the file should be removed (was only ours).
	assert.ok(!existsSync(abs), "config.yaml should be deleted when empty");
});

test("installAllHooks/statusAllHooks cover all 12 hook-capable targets", async () => {
	const r = await hooks.installAllHooks({ force: true, agentBin: AGENT_BIN });
	assert.equal(r.length, 12);
	const installedCount = r.filter((x) => x.installed).length;
	assert.equal(installedCount, 12);
	const s = await hooks.statusAllHooks();
	assert.equal(s.length, 12);
	assert.equal(s.filter((x) => x.installed).length, 12);
	const u = await hooks.uninstallAllHooks();
	assert.equal(u.length, 12);
});
