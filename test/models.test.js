import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	existsSync,
	readFileSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-models-"));
process.env.AGENT_CLI_HOME = TMP;

const models = await import("../src/models.js");

const cfgPath = () => path.join(TMP, ".agents", "config.json");

test("getAliases is {} when no config exists", () => {
	assert.deepEqual(models.getAliases(), {});
});

test("getAlias missing → null", () => {
	assert.equal(models.getAlias("nope"), null);
});

test("setAlias works even when ~/.agents does not yet exist (ensureDir)", () => {
	// ~/.agents is absent here — setAlias must create it, not throw ENOENT.
	const a = models.setAlias("coding-model", {
		model: "openai/gpt",
		thinking: "high",
	});
	assert.equal(a.model, "openai/gpt");
	assert.equal(a.thinking, "high");
	assert.ok(existsSync(cfgPath()));
});

test("setAlias partial update merges and preserves untouched fields", () => {
	const a = models.setAlias("coding-model", { category: "coding" });
	assert.equal(a.model, "openai/gpt"); // preserved
	assert.equal(a.thinking, "high"); // preserved
	assert.equal(a.category, "coding"); // newly set
});

test("setAlias with no provided fields preserves the entry unchanged", () => {
	models.setAlias("fast-model", { model: "x/y" });
	const before = models.getAlias("fast-model");
	models.setAlias("fast-model", {});
	assert.deepEqual(models.getAlias("fast-model"), before);
});

test("ensureDefaultAliases seeds defaults without overwriting user aliases", () => {
	models.setAlias("my-custom", { model: "custom/1" });
	const a = models.ensureDefaultAliases();
	assert.ok(a["fast-model"]);
	assert.ok(a["my-custom"]);
	assert.equal(a["my-custom"].model, "custom/1");
});

test("writeModelsMd writes a table incl. all aliases + categories", () => {
	const f = models.writeModelsMd();
	assert.ok(existsSync(f));
	const md = readFileSync(f, "utf8");
	assert.ok(md.includes("fast-model"));
	assert.ok(md.includes("## Categories"));
});

test("getAliases treats corrupt config as empty (no throw)", () => {
	const p = cfgPath();
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(p, "{ not valid json");
	assert.deepEqual(models.getAliases(), {});
});
