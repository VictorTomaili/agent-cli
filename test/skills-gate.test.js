// Structured skill-gate tests: activation contract, gate classification, ack persistence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_CLI_HOME = mkdtempSync(path.join(tmpdir(), "agent-gate-"));
const gate = await import("../src/skills-gate.js");
const HOME = process.env.AGENT_CLI_HOME;

function installSkill(name, activation) {
	const dir = path.join(HOME, ".skill-cli", "store", name);
	mkdirSync(dir, { recursive: true });
	const fm = [`---`, `name: ${name}`, `description: ${name} desc`];
	if (activation) fm.push(`activation:`);
	if (activation?.mode) fm.push(`  mode: ${activation.mode}`);
	if (activation?.axes) fm.push(`  axes: [${activation.axes.join(", ")}]`);
	if (activation?.question) fm.push(`  question: ${activation.question}`);
	fm.push(`---`, `# ${name}`);
	writeFileSync(path.join(dir, "SKILL.md"), fm.join("\n"), "utf8");
}

test("listSkills reads the activation contract", () => {
	installSkill("parser-fix", { mode: "ask", axes: ["parser", "syntax"], question: "Load parser-fix?" });
	installSkill("git-workflow", { mode: "auto", axes: ["git", "merge"] });
	installSkill("plain", null); // default mode auto
	const skills = gate.listSkills();
	const pf = skills.find((s) => s.name === "parser-fix");
	assert.equal(pf.activation.mode, "ask");
	assert.deepEqual(pf.activation.axes, ["parser", "syntax"]);
	assert.equal(pf.activation.question, "Load parser-fix?");
	assert.equal(skills.find((s) => s.name === "plain").activation.mode, "auto");
});

test("gateForTask classifies by mode + axes", () => {
	const r = gate.gateForTask("refactor the parser for speed");
	assert.ok(r.ask.includes("parser-fix"));
	assert.equal(r.questions.length, 1);
	const auto = gate.gateForTask("merge branches");
	assert.ok(auto.autoLoad.includes("git-workflow"));
});

test("effectiveSkills respects global defaults + project allow/deny", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "gate-proj-"));
	// no project config, no defaults → effective empty
	assert.deepEqual(gate.effectiveSkills(cwd), []);
	// global default
	const cfg = path.join(HOME, ".skill-cli", "config.yaml");
	mkdirSync(path.dirname(cfg), { recursive: true });
	writeFileSync(cfg, "version: 1\ndefaults: [git-workflow]\n", "utf8");
	assert.deepEqual(gate.effectiveSkills(cwd), ["git-workflow"]);
	// project allow adds
	writeFileSync(path.join(cwd, "skill.config"), "inherit: true\nallow: [parser-fix]\n", "utf8");
	const eff = gate.effectiveSkills(cwd);
	assert.ok(eff.includes("parser-fix"));
});

// A denied skill must actually be removed from the effective set. The test above
// only exercised the empty/defaults/allow paths, so the `deny` branch of
// effectiveSkills() could be deleted with the suite still green — a project that
// deliberately denies a skill would have kept auto-loading it.
test("effectiveSkills: a project deny removes an inherited skill", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "gate-deny-"));
	const cfg = path.join(HOME, ".skill-cli", "config.yaml");
	mkdirSync(path.dirname(cfg), { recursive: true });
	writeFileSync(cfg, "version: 1\ndefaults: [git-workflow]\n", "utf8");
	// sanity: inherited before any deny
	assert.deepEqual(gate.effectiveSkills(cwd), ["git-workflow"]);
	writeFileSync(
		path.join(cwd, "skill.config"),
		"inherit: true\ndeny: [git-workflow]\n",
		"utf8",
	);
	assert.deepEqual(
		gate.effectiveSkills(cwd),
		[],
		"a denied skill must not stay in the effective set",
	);
});

test("effectiveSkills: deny ['*'] clears every inherited skill", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "gate-deny-all-"));
	const cfg = path.join(HOME, ".skill-cli", "config.yaml");
	mkdirSync(path.dirname(cfg), { recursive: true });
	writeFileSync(cfg, "version: 1\ndefaults: [git-workflow, plain]\n", "utf8");
	assert.deepEqual(gate.effectiveSkills(cwd), ["git-workflow", "plain"]);
	writeFileSync(path.join(cwd, "skill.config"), 'inherit: true\ndeny: ["*"]\n', "utf8");
	assert.deepEqual(gate.effectiveSkills(cwd), [], "deny '*' must clear the set");
});

test("effectiveSkills: allow wins over deny for the same skill", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "gate-deny-allow-"));
	const cfg = path.join(HOME, ".skill-cli", "config.yaml");
	mkdirSync(path.dirname(cfg), { recursive: true });
	writeFileSync(cfg, "version: 1\ndefaults: [git-workflow]\n", "utf8");
	writeFileSync(
		path.join(cwd, "skill.config"),
		"inherit: true\ndeny: [git-workflow]\nallow: [git-workflow]\n",
		"utf8",
	);
	assert.deepEqual(
		gate.effectiveSkills(cwd),
		["git-workflow"],
		"an explicit allow must survive a deny of the same name",
	);
});

test("gateAck persists decisions and --remember writes the project config", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "gate-ack-"));
	const r = gate.gateAck({ enable: ["parser-fix"], disable: [], remember: true, cwd });
	assert.equal(r.ok, true);
	assert.ok(r.decisionId);
	const proj = readFileSync(path.join(cwd, "skill.config"), "utf8");
	assert.match(proj, /parser-fix/);
	const status = gate.gateStatus(cwd);
	assert.ok(status.policy.decisions.length >= 1);
});
