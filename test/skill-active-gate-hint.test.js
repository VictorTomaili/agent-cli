// Regression: `agent-cli skill active` must print the START GATE hint.
//
// The gate policy injected into AGENTS.md tells the agent to run this exact
// command and then classify what comes back. `skill active` is intercepted in
// src/commands/skill-cmds.js and never reaches cmdActive() in
// src/skills/commands/defaults.js, so for a while it returned a bare skill list
// with no instruction attached — the agent had nothing to act on and the gate
// silently did nothing. These tests pin the hint to the command the policy
// actually names, in both human and --json output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const { GATE_DECIDE_HINT } = await import("../src/skills/lib/gate-policy.js");

// Throwaway home so the real ~/.agents and ~/.skill-cli are never touched.
const HOME = mkdtempSync(path.join(tmpdir(), "agent-active-hint-"));
const CWD = mkdtempSync(path.join(tmpdir(), "agent-active-proj-"));

function installSkill(name) {
	const dir = path.join(HOME, ".skill-cli", "store", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, "SKILL.md"),
		["---", `name: ${name}`, `description: ${name} desc`, "---", `# ${name}`].join(
			"\n",
		),
		"utf8",
	);
}

function run(...args) {
	return spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		cwd: CWD,
		env: {
			...process.env,
			AGENT_CLI_HOME: HOME,
			HOME,
			USERPROFILE: HOME,
			NO_COLOR: "1",
		},
	});
}

installSkill("hint-probe");
// A skill is only "active" if a global default or the project allow-list names
// it, so opt the probe in through the project config.
writeFileSync(
	path.join(CWD, "skill.config"),
	"allow:\n  - hint-probe\n",
	"utf8",
);

test("`skill active` prints the shared gate hint after the catalog", () => {
	const r = run("skill", "active");
	assert.equal(r.status, 0, r.stderr);
	assert.ok(
		r.stdout.includes("hint-probe"),
		"the sandboxed skill should be listed",
	);
	// Every line of the shared constant must survive to stdout — a partial
	// render would give the agent a truncated rule.
	for (const line of GATE_DECIDE_HINT.split("\n")) {
		assert.ok(
			r.stdout.includes(line.trim()),
			`gate hint line missing from output: ${line.trim()}`,
		);
	}
	// The hint follows the catalog, so the agent reads the skills first.
	assert.ok(
		r.stdout.indexOf("→ Decide for each skill") > r.stdout.indexOf("hint-probe"),
		"hint must come after the skill catalog",
	);
});

test("`skill active --json` carries the hint as a field", () => {
	const r = run("skill", "active", "--json");
	assert.equal(r.status, 0, r.stderr);
	const payload = JSON.parse(r.stdout);
	const body = payload.data ?? payload;
	assert.equal(body.sub, "active");
	assert.ok(
		Array.isArray(body.active) && body.active.some((s) => s.name === "hint-probe"),
		"json output should list the sandboxed skill",
	);
	assert.equal(
		body.hint,
		GATE_DECIDE_HINT,
		"json output must carry the gate hint verbatim from the shared constant",
	);
});

test("the hint is rendered from the shared constant, not a local copy", () => {
	// Single source of truth: skill-cmds.js may reference the constant but must
	// not inline its text, or the CLI and AGENTS.md can drift apart.
	const src = spawnSync(
		process.execPath,
		[
			"-e",
			"process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))",
			fileURLToPath(new URL("../src/commands/skill-cmds.js", import.meta.url)),
		],
		{ encoding: "utf8" },
	).stdout;
	assert.ok(src.includes("GATE_DECIDE_HINT"));
	assert.ok(
		!src.includes("Decide for each skill above"),
		"skill-cmds.js must not inline the hint text",
	);
});
