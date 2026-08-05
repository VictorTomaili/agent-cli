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

test("setAlias stores ordered fallback models", () => {
	const a = models.setAlias("coding-model", {
		fallbacks: ["zai/glm-5.2", "zai/glm-5.2", "openai/fallback"],
	});
	assert.deepEqual(a.fallbacks, ["zai/glm-5.2", "openai/fallback"]);
});

test("model mappings are not seeded by agent-cli", () => {
	assert.equal(models.DEFAULT_ALIASES, undefined);
	assert.equal(models.ensureDefaultAliases, undefined);
});

test("livePicks maps live ids to categories and survives save/load", () => {
	const result = {
		ok: true,
		source: "openrouter",
		count: 4,
		fetchedAt: "2026-08-05T00:00:00.000Z",
		entries: [
			{ id: "openai/gpt-5", provider: "openai", context: 400000, inputPer1M: 2, outputPer1M: 10, modalities: "text" },
			{ id: "anthropic/claude-opus-5", provider: "anthropic", context: 1000000, inputPer1M: 15, outputPer1M: 75, modalities: "" },
			{ id: "google/gemini-3.6-flash", provider: "google", context: 1048576, inputPer1M: 1.5, outputPer1M: 7.5, modalities: "" },
			{ id: "qwen/qwen3.8-coder", provider: "qwen", context: 1000000, inputPer1M: 0.2, outputPer1M: 0.6, modalities: "" },
		],
	};
	models.saveLiveCatalog(result);
	// pickForCategory consults the live catalog first (not the bundled baseline).
	const smart = models.pickForCategory("smart");
	assert.equal(smart.id, "openai/gpt-5");
	const coding = models.pickForCategory("coding");
	assert.equal(coding.id, "qwen/qwen3.8-coder");
	const fast = models.pickForCategory("fast");
	assert.equal(fast.id, "google/gemini-3.6-flash");
});

test("writeModelsMd writes a tagged XML alias document", () => {
	const f = models.writeModelsMd();
	assert.ok(existsSync(f));
	const md = readFileSync(f, "utf8");
	assert.ok(md.includes("<ALIAS "));
	assert.ok(md.includes('fallbacks="'));
	assert.ok(md.includes("## Categories"));
});

test("getAliases treats corrupt config as empty (no throw)", () => {
	const p = cfgPath();
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(p, "{ not valid json");
	assert.deepEqual(models.getAliases(), {});
});

// ---------------------------------------------------------------------------
// Finding 5 — corrupt model configuration replacement.
// setAlias/writeModelsMd must refuse on malformed config WITHOUT destroying the
// original bytes; getAliases stays permissive (returns {}).
// ---------------------------------------------------------------------------
const expectCorruptSetAlias = (raw) => {
	writeFileSync(cfgPath(), raw);
	assert.throws(
		() => models.setAlias("coding-model", { model: "openai/gpt" }),
		/config\.json is corrupt/i,
	);
	assert.equal(readFileSync(cfgPath(), "utf8"), raw); // original bytes preserved
};

test("setAlias on malformed JSON refuses without destroying the file", () => {
	expectCorruptSetAlias("{ not valid json");
});

test("setAlias on a root-array config refuses without destroying the file", () => {
	expectCorruptSetAlias(JSON.stringify([1, 2, 3]));
});

test("setAlias on null top-level refuses without destroying the file", () => {
	expectCorruptSetAlias("null");
});

test("setAlias on semantically invalid aliases refuses without destroying the file", () => {
	expectCorruptSetAlias(
		JSON.stringify({ models: { aliases: { fast: ["not", "an", "object"] } } }),
	);
});

test("setAlias on partial valid config preserves unrelated fields", () => {
	const raw = JSON.stringify({ global: ["claude"], project: ["codex"] });
	writeFileSync(cfgPath(), raw);
	const a = models.setAlias("coding-model", { model: "openai/gpt" });
	assert.equal(a.model, "openai/gpt");
	const reloaded = JSON.parse(readFileSync(cfgPath(), "utf8"));
	assert.deepEqual(reloaded.global, ["claude"]); // untouched
	assert.deepEqual(reloaded.project, ["codex"]); // untouched
	assert.equal(reloaded.models.aliases["coding-model"].model, "openai/gpt");
});

test("writeModelsMd on corrupt config refuses without touching config.json", () => {
	const raw = "{ not valid json";
	writeFileSync(cfgPath(), raw);
	assert.throws(
		() => models.writeModelsMd(),
		/config\.json is corrupt/i,
	);
	assert.equal(readFileSync(cfgPath(), "utf8"), raw);
});

test("liveCatalogMarkdown renders a table from a synthetic fetch result", () => {
	const result = {
		ok: true,
		source: "openrouter",
		count: 2,
		fetchedAt: "2026-08-05T00:00:00.000Z",
		entries: [
			{ id: "openai/gpt-5", provider: "openai", context: 400000, inputPer1M: 2, outputPer1M: 10, modalities: "text,image" },
			{ id: "anthropic/claude-opus", provider: "anthropic", context: null, inputPer1M: 0, outputPer1M: 0, modalities: "" },
		],
	};
	const md = models.liveCatalogMarkdown(result);
	assert.match(md, /^## Live model catalog/m);
	assert.match(md, /openrouter at 2026-08-05T00:00:00\.000Z \(2 models\)/);
	// $/1M pricing renders with a slash, not bare dollars
	assert.match(md, /\| `openai\/gpt-5` \| openai \| 400000 \| \$2\/M \| \$10\/M \| text,image \|/);
	// null context / zero price render as em-dashes, not NaN
	assert.match(md, /\| `anthropic\/claude-opus` \| anthropic \| — \| — \| — \| — \|/);
});
