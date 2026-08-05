// Skill authoring tests: create/validate/preview/test/run/lock/capture + gate
// single-sourcing + defaults verb merge.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import yamlMod from "yaml";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-skillauth-"));
process.env.AGENT_CLI_HOME = TMP;
process.env.SKILL_CLI_HOME = TMP; // paths.js prefers SKILL_CLI_HOME — isolate from any ambient value

const validateMod = await import("../src/skills/commands/validate.js");
const runMod = await import("../src/skills/commands/run.js");
const lockMod = await import("../src/skills/commands/lock.js");
const captureMod = await import("../src/skills/commands/capture.js");
const store = await import("../src/skills/lib/store.js");
const agentsMd = await import("../src/skills/lib/agents-md.js");
const gate = await import("../src/skills/lib/gate-policy.js");
const defaultsMod = await import("../src/skills/commands/defaults.js");
const skillConfig = await import("../src/skills/lib/config.js");

const GOOD = `---
name: demo
description: A demo skill
triggers: [/run, report]
version: 1.0.0
---

Do the thing.
`;

function tmpSkillDir(content = GOOD, { tool = false } = {}) {
	const d = mkdtempSync(path.join(tmpdir(), "agent-skill-auth-"));
	writeFileSync(path.join(d, "SKILL.md"), content);
	if (tool) {
		writeFileSync(
			path.join(d, "SKILL.tool.js"),
			`export async function run(argv = []) { return { ok: true, output: "ran:" + argv.join(",") } }`,
		);
	}
	return d;
}

test("validateSkill accepts a well-formed skill", () => {
	const v = validateMod.validateSkill(GOOD);
	assert.equal(v.ok, true);
	assert.equal(v.name, "demo");
	assert.equal(v.errors.length, 0);
	assert.deepEqual(v.triggers, ["run", "report"]);
});

test("validateSkill flags missing/invalid name and bad triggers", () => {
	const noName = validateMod.validateSkill("---\ndescription: x\n---\n\nbody\n");
	assert.equal(noName.ok, false);
	assert.ok(noName.errors.some((e) => e.includes("name")));

	const traversal = validateMod.validateSkill("---\nname: ../evil\ndescription: x\n---\n\nbody\n");
	assert.equal(traversal.ok, false);

	const badTrig = validateMod.validateSkill("---\nname: a\ntriggers: [has space]\n---\n\nbody\n");
	assert.equal(badTrig.ok, true);
	assert.ok(badTrig.warnings.some((w) => w.includes("space")));
});

test("validateSkill warns when description/body missing", () => {
	const v = validateMod.validateSkill("---\nname: a\n---\n\n");
	assert.ok(v.warnings.some((w) => w.includes("description")));
	assert.ok(v.warnings.some((w) => w.includes("body")));
});

test("checkToolImports enforces the allowlist", () => {
	assert.equal(runMod.checkToolImports(`import fs from "node:fs"\nexport async function run(){return {ok:true}}`).ok, true);
	assert.equal(runMod.checkToolImports(`import { exec } from "node:child_process"\n`).ok, false);
	assert.equal(runMod.checkToolImports(`import http from "node:http"\n`).ok, false);
	assert.equal(runMod.checkToolImports(`import path from "node:path"\n`).ok, true);
});

test("runSkillTool executes a tool module and returns its result", async () => {
	const d = tmpSkillDir(GOOD, { tool: true });
	const r = await runMod.runSkillTool(path.join(d, "SKILL.tool.js"), ["a", "b"]);
	assert.equal(r.ok, true);
	assert.equal(r.output, "ran:a,b");
});

test("runSkillTool rejects a module without run()", async () => {
	const d = tmpSkillDir(GOOD);
	writeFileSync(path.join(d, "SKILL.tool.js"), "export const x = 1\n");
	await assert.rejects(() => runMod.runSkillTool(path.join(d, "SKILL.tool.js")), /export a `run/);
});

test("writeLock/readLock record source + content hash; hash changes with content", () => {
	const d = tmpSkillDir(GOOD);
	const lock = lockMod.writeLock(d, "owner/repo");
	assert.equal(lock.source, "owner/repo");
	assert.ok(lock.contentHash);
	assert.ok(lock.installedAt);
	const read = lockMod.readLock("__notinstalled__");
	assert.equal(read, null);
	// contentHash is deterministic for the same SKILL.md
	const lock2 = lockMod.writeLock(d, "owner/repo");
	assert.equal(lock.contentHash, lock2.contentHash);
	// hash changes when content changes
	writeFileSync(path.join(d, "SKILL.md"), GOOD + "\nmore\n");
	const lock3 = lockMod.writeLock(d, "owner/repo");
	assert.notEqual(lock.contentHash, lock3.contentHash);
});

test("capture appends a lesson; skillLessons reads it", () => {
	const d = tmpSkillDir(GOOD);
	captureMod.cmdCapture([d, "always", "validate", "first"]);
	const lessons = captureMod.skillLessons(d);
	assert.ok(lessons.some((l) => l.includes("always validate first")));
	const md = readFileSync(path.join(d, "SKILL.md"), "utf8");
	assert.ok(md.includes("## Lessons"));
});

test("AGENTS_BLOCK is single-sourced from gate-policy", () => {
	// The injected bootstrap block embeds the shared policy — no drift.
	assert.ok(agentsMd.AGENTS_BLOCK.includes(gate.GATE_POLICY_TEXT.trim().slice(0, 40)));
	assert.ok(gate.GATE_POLICY_TEXT.includes("START GATE (mandatory)"));
	assert.ok(gate.GATE_DECIDE_HINT.includes("PROPOSE"));
	// cmdActive renders from the shared hint, not its own copy.
	const src = readFileSync(new URL("../src/skills/commands/defaults.js", import.meta.url), "utf8");
	assert.ok(src.includes("GATE_DECIDE_HINT"));
	assert.ok(!/→ For EACH skill above, decide in your reply:\n/.test(src.replace(/GATE_DECIDE_HINT/g, "")));
});

test("cmdDefaults lists global defaults via computeDefaults (verb merge)", () => {
	// `skill defaults` (plural) is distinct from `skill active` and lists the
	// global default set. Verify it uses computeDefaults and prints an entry.
	const cfg = { ...skillConfig.readGlobalConfig() };
	cfg.defaults = ["demo"];
	const cfgPath = path.join(TMP, ".skill-cli", "config.yaml");
	mkdirSync(path.dirname(cfgPath), { recursive: true });
	writeFileSync(cfgPath, yamlMod.stringify(cfg));
	// install "demo" into the store so computeDefaults can resolve it
	const storeDir = path.join(TMP, ".skill-cli", "store");
	mkdirSync(path.join(storeDir, "demo"), { recursive: true });
	writeFileSync(path.join(storeDir, "demo", "SKILL.md"), GOOD);
	// capture stdout
	const logs = [];
	const orig = console.log;
	console.log = (...a) => logs.push(a.join(" "));
	defaultsMod.cmdDefaults();
	console.log = orig;
	assert.ok(logs.some((l) => l.includes("demo")));
	assert.ok(logs.some((l) => l.includes("undefault")));
	assert.ok(!logs.some((l) => l.includes("No default skills")));
});
