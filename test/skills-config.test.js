// Tests for src/skills/lib/config.js — Finding 6: nested schema validation at
// the load boundary. Wrong shapes (defaults/allow/deny not arrays, inherit not
// boolean, store not string) are classified as corrupt and refuse to be
// overwritten by mutations.
import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-skillcfg-"));
process.env.SKILL_CLI_HOME = TMP;

const sc = await import("../src/skills/lib/config.js");

const globalFile = () => path.join(TMP, ".skill-cli", "config.yaml");
const projectFile = (cwd) => path.join(cwd, "skill.config");

const projectDir = (name) => {
	const dir = path.join(TMP, name);
	mkdirSync(dir, { recursive: true });
	return dir;
};

test("readGlobalConfig returns defaults when the file is missing", () => {
	const cfg = sc.readGlobalConfig();
	assert.equal(sc.isGlobalConfigCorrupt(cfg), false);
	assert.deepEqual(cfg.defaults, []);
	assert.equal(typeof cfg.store, "string");
});

test("readGlobalConfig marks malformed YAML corrupt and write refuses", () => {
	mkdirSync(path.dirname(globalFile()), { recursive: true });
	const raw = "defaults: [broken\n";
	writeFileSync(globalFile(), raw);
	const cfg = sc.readGlobalConfig();
	assert.equal(sc.isGlobalConfigCorrupt(cfg), true);
	assert.throws(
		() => sc.writeGlobalConfig(cfg),
		/config\.yaml is corrupt/i,
	);
	assert.equal(readFileSync(globalFile(), "utf8"), raw); // original bytes intact
});

test("readGlobalConfig marks non-array defaults corrupt", () => {
	writeFileSync(globalFile(), "defaults: always\n");
	const cfg = sc.readGlobalConfig();
	assert.equal(sc.isGlobalConfigCorrupt(cfg), true);
});

test("readGlobalConfig marks non-string store corrupt", () => {
	writeFileSync(globalFile(), "store: [a, b]\n");
	const cfg = sc.readGlobalConfig();
	assert.equal(sc.isGlobalConfigCorrupt(cfg), true);
});

test("readGlobalConfig accepts valid defaults + store string", () => {
	writeFileSync(globalFile(), "version: 1\nstore: /x/y\ndefaults:\n  - react\n");
	const cfg = sc.readGlobalConfig();
	assert.equal(sc.isGlobalConfigCorrupt(cfg), false);
	assert.deepEqual(cfg.defaults, ["react"]);
	assert.equal(cfg.store, "/x/y");
});

test("readGlobalConfig legacy union (enabled_global + defaults_global) still works", () => {
	writeFileSync(
		globalFile(),
		"enabled_global:\n  - react\n  - web\ndefaults_global:\n  - react\n",
	);
	const cfg = sc.readGlobalConfig();
	assert.equal(sc.isGlobalConfigCorrupt(cfg), false);
	assert.deepEqual(cfg.defaults, ["react", "web"]);
});

test("readGlobalConfig new-format defaults wins over legacy lists", () => {
	writeFileSync(
		globalFile(),
		"defaults:\n  - react\nenabled_global:\n  - old\n",
	);
	const cfg = sc.readGlobalConfig();
	assert.equal(sc.isGlobalConfigCorrupt(cfg), false);
	assert.deepEqual(cfg.defaults, ["react"]);
});

test("readProjectConfig returns null when missing", () => {
	assert.equal(sc.readProjectConfig(projectDir("proj-missing")), null);
});

test("readProjectConfig marks malformed YAML corrupt and write refuses", () => {
	const dir = projectDir("proj-bad");
	const raw = "inherit: [broken\n";
	writeFileSync(projectFile(dir), raw);
	const cfg = sc.readProjectConfig(dir);
	assert.ok(cfg);
	assert.equal(sc.isProjectConfigCorrupt(cfg), true);
	assert.throws(
		() => sc.writeProjectConfig(dir, cfg),
		/skill\.config is corrupt/i,
	);
	assert.equal(readFileSync(projectFile(dir), "utf8"), raw); // original bytes intact
});

test("readProjectConfig marks non-array allow corrupt", () => {
	const dir = projectDir("proj-allow");
	writeFileSync(projectFile(dir), "allow: react\n");
	const cfg = sc.readProjectConfig(dir);
	assert.equal(sc.isProjectConfigCorrupt(cfg), true);
});

test("readProjectConfig marks non-array deny corrupt", () => {
	const dir = projectDir("proj-deny");
	writeFileSync(projectFile(dir), "deny: 42\n");
	const cfg = sc.readProjectConfig(dir);
	assert.equal(sc.isProjectConfigCorrupt(cfg), true);
});

test("readProjectConfig marks non-boolean inherit corrupt", () => {
	const dir = projectDir("proj-inherit");
	writeFileSync(projectFile(dir), 'inherit: "no"\n');
	const cfg = sc.readProjectConfig(dir);
	assert.equal(sc.isProjectConfigCorrupt(cfg), true);
});

test("readProjectConfig accepts valid arrays + boolean", () => {
	const dir = projectDir("proj-ok");
	writeFileSync(
		projectFile(dir),
		"inherit: false\ndeny:\n  - react\nallow:\n  - web\n",
	);
	const cfg = sc.readProjectConfig(dir);
	assert.equal(sc.isProjectConfigCorrupt(cfg), false);
	assert.equal(cfg.inherit, false);
	assert.deepEqual(cfg.deny, ["react"]);
	assert.deepEqual(cfg.allow, ["web"]);
});

test("writeProjectConfig round-trips a valid schema", () => {
	const dir = projectDir("proj-roundtrip");
	sc.writeProjectConfig(dir, { inherit: true, deny: ["react"], allow: [] });
	const cfg = sc.readProjectConfig(dir);
	assert.equal(sc.isProjectConfigCorrupt(cfg), false);
	assert.equal(cfg.inherit, true);
	assert.deepEqual(cfg.deny, ["react"]);
	assert.deepEqual(cfg.allow, []);
});

test("computeEffective/computeDefaults tolerate corrupt configs without crashing", () => {
	const installed = [{ name: "react-bp" }, { name: "web" }];
	// Corrupt config.yaml explicitly — it must be read as corrupt yet still have
	// a valid shape so computeEffective/computeDefaults do not crash.
	mkdirSync(path.dirname(globalFile()), { recursive: true });
	writeFileSync(globalFile(), "defaults: [broken\n");
	const g = sc.readGlobalConfig();
	assert.equal(sc.isGlobalConfigCorrupt(g), true);
	const p = sc.readProjectConfig(projectDir("proj-allow"));
	assert.equal(sc.isProjectConfigCorrupt(p), true);
	assert.ok(Array.isArray(sc.computeEffective(installed, g, p)));
	assert.ok(Array.isArray(sc.computeDefaults(installed, g)));
});
