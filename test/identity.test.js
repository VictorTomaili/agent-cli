import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-identity-"));
process.env.AGENT_CLI_HOME = TMP;

const id = await import("../src/identity.js");
const { readTag } = await import("../src/fields.js");

test("applyIdentity writes IDENTITY.md with archetype tags (name empty)", async () => {
	const r = await id.applyIdentity("coding");
	assert.ok(existsSync(r.file));
	const c = readFileSync(r.file, "utf8");
	assert.ok(readTag(c, "AGENT_ROLE").length > 0);
	assert.equal(readTag(c, "AGENT_NAME"), "");
});

test("applyIdentity unknown key still writes default content", async () => {
	const r = await id.applyIdentity("bogus-key");
	const c = readFileSync(r.file, "utf8");
	assert.ok(readTag(c, "AGENT_ROLE").length > 0);
});

test("applySoul writes SOUL.md with all soul tags filled", async () => {
	const r = await id.applySoul("mentor");
	const c = readFileSync(r.file, "utf8");
	for (const t of [
		"SOUL_PERSONALITY",
		"SOUL_VALUES",
		"SOUL_BELIEFS",
		"SOUL_MOTIVATIONS",
	])
		assert.ok(readTag(c, t).length > 0);
});

test("listIdentities / listSouls expose the catalogs", () => {
	assert.ok(id.listIdentities().length >= 6);
	assert.ok(id.listSouls().length >= 4);
});

test("setSection is tag-aware: writes AGENT_NAME by tag or label", async () => {
	await id.applyIdentity("general-purpose");
	const f = id.idFile("global");
	await id.setSection(f, "AGENT_NAME", "Marvin");
	assert.equal(readTag(readFileSync(f, "utf8"), "AGENT_NAME"), "Marvin");
	await id.setSection(f, "Name", "Marvin2"); // resolves by label
	assert.equal(readTag(readFileSync(f, "utf8"), "AGENT_NAME"), "Marvin2");
});

test("setSection falls back to ## section replace on a non-tagged file", async () => {
	const f = path.join(TMP, ".agents", "LESSONS.md");
	mkdirSync(path.dirname(f), { recursive: true });
	writeFileSync(f, "# LESSONS\n\n## Core\nold\n\n## Other\nkeep\n");
	await id.setSection(f, "Core", "new content");
	const c = readFileSync(f, "utf8");
	assert.ok(c.includes("## Core\nnew content"));
	assert.ok(c.includes("## Other\nkeep\n")); // other section untouched
});

test("setSection inserts the heading when absent", async () => {
	const f = path.join(TMP, ".agents", "ENVIRONMENTS.md");
	writeFileSync(f, "# ENV\n\nexisting body\n");
	await id.setSection(f, "NewSection", "val");
	assert.ok(readFileSync(f, "utf8").includes("## NewSection\nval"));
});

test("onboardSuggest returns question + options + souls + default", () => {
	const s = id.onboardSuggest();
	assert.ok(s.question);
	assert.ok(s.options.length >= 6);
	assert.ok(s.souls.length >= 4);
	assert.ok(s.default);
});

test("idFile / soulFile resolve under HOME for global scope", () => {
	assert.equal(id.idFile("global"), path.join(TMP, ".agents", "IDENTITY.md"));
	assert.equal(id.soulFile("global"), path.join(TMP, ".agents", "SOUL.md"));
});
