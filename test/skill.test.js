import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-skill-"));
process.env.AGENT_CLI_HOME = TMP;

const skill = await import("../src/skill.js");

test("submodulePresent / submoduleHasDeps are booleans (no side effects)", () => {
	assert.equal(typeof skill.submodulePresent(), "boolean");
	assert.equal(typeof skill.submoduleHasDeps(), "boolean");
});

test("readSubmodulePkg returns a parsed pkg or null; submoduleVersion derives from it", () => {
	const pkg = skill.readSubmodulePkg();
	if (pkg) assert.equal(typeof pkg.version, "string");
	const v = skill.submoduleVersion();
	assert.ok(v === null || typeof v === "string");
});

test("ensureSkillStore creates store + config, then is idempotent", async () => {
	const r1 = await skill.ensureSkillStore();
	assert.equal(r1.ok, true);
	assert.ok(r1.actions.includes("created-store"));
	assert.ok(r1.actions.includes("created-config"));
	assert.ok(existsSync(r1.store));
	assert.ok(existsSync(r1.config));
	const r2 = await skill.ensureSkillStore();
	assert.equal(r2.ok, true);
	assert.equal(r2.actions.length, 0); // nothing new the second time
});

test("isSkillAvailable returns a boolean without throwing", () => {
	assert.equal(typeof skill.isSkillAvailable(), "boolean");
});

test("PATHS point under the isolated HOME", () => {
	assert.equal(skill.PATHS.SKILL_HOME, path.join(TMP, ".skill-cli"));
	assert.ok(skill.PATHS.SKILL_STORE.startsWith(skill.PATHS.SKILL_HOME));
	assert.ok(skill.PATHS.SKILL_CONFIG.startsWith(skill.PATHS.SKILL_HOME));
});
