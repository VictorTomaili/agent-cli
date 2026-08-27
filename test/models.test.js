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

// Regression: agent-cli models set/write must never destroy hand-curated content
// (a custom catalog, or trailing sections like "Pi Agent Bridge") - only the
// "## Aliases" block is config-truth and safe to regenerate unconditionally.
//
// The fixture APPENDS its sections instead of anchoring on a heading agent-cli
// emits. agent-cli no longer writes any catalog section, and a fixture built by
// replacing one silently became a no-op the moment that stopped: the assertions
// kept passing while testing nothing.
test("writeModelsMd preserves a hand-written catalog and trailing sections", () => {
	const f = models.writeModelsMd();
	const before = readFileSync(f, "utf8");
	const customized =
		before.trimEnd() +
		"\n\n## Curated model catalog\n\n| id | notes |\n|---|---|\n| `hand-written-entry` | do not clobber me |\n" +
		"\n## Pi Agent Bridge\n\nSome hand-written notes that must survive.\n";
	writeFileSync(f, customized);
	assert.ok(
		customized.includes("hand-written-entry"),
		"fixture must actually contain the row it then asserts on",
	);

	models.setAlias("smart-model", { model: "prov-a/model-one", category: "smart" });
	models.writeModelsMd(); // default call, as used by `agent-cli models set`

	const after = readFileSync(f, "utf8");
	assert.ok(after.includes("hand-written-entry"), "custom catalog row survived");
	assert.ok(
		after.includes("Some hand-written notes that must survive."),
		"trailing custom section survived",
	);
	assert.ok(after.includes("<ALIAS "), "alias section still regenerated");
	assert.ok(after.includes("prov-a/model-one"), "the new alias was written");
});

// agent-cli used to ship a hardcoded model catalog, and `models research
// --refresh` re-embedded it over whatever was on disk - the one code path in the
// product that could destroy hand-curated content. Both are gone. This pins the
// removal so no option can resurrect a clobbering path.
test("no writeModelsMd option can clobber a hand-written catalog", () => {
	const f = models.writeModelsMd();
	writeFileSync(
		f,
		readFileSync(f, "utf8").trimEnd() +
			"\n\n## Curated model catalog\n\n| id | notes |\n|---|---|\n| `user-curated-entry` | mine |\n",
	);

	// The old clobbering options, passed explicitly. They are no longer read,
	// so they must be inert rather than destructive.
	models.writeModelsMd({ includeCatalog: true, refreshCatalog: true });

	const after = readFileSync(f, "utf8");
	assert.ok(
		after.includes("user-curated-entry"),
		"a hand-written catalog must survive every write path",
	);
	assert.equal(typeof models.CATALOG, "undefined", "CATALOG must stay deleted");
	assert.equal(
		typeof models.catalogMarkdown,
		"undefined",
		"catalogMarkdown must stay deleted - it emitted the bundled data",
	);
	assert.equal(
		typeof models.findInCatalog,
		"undefined",
		"findInCatalog must stay deleted",
	);
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

// ---------------------------------------------------------------------------
// P11 — reject invalid alias names on write (closes proposal finding F10).
// The historical write path accepted ANY key (e.g. a pasted HTML comment in the
// name). setAlias must reject a key failing ^[a-z0-9][a-z0-9-]*$ with a
// structured INVALID_ALIAS_NAME error — never silently accept.
// ---------------------------------------------------------------------------
test("setAlias rejects an invalid alias name with code INVALID_ALIAS_NAME", () => {
	assert.throws(
		() => models.setAlias("smart-model <!-- foo -->", { model: "openai/gpt" }),
		(e) => {
			assert.equal(e.code, "INVALID_ALIAS_NAME");
			assert.match(e.message, /invalid alias name: smart-model <!-- foo -->/);
			assert.match(e.message, /\^\[a-z0-9\]\[a-z0-9-\]\*\$/);
			return true;
		},
	);
});

test("setAlias accepts a valid alias name", () => {
	// reset config to a clean state (the corrupt-config tests above left garbage)
	mkdirSync(path.dirname(cfgPath()), { recursive: true });
	writeFileSync(
		cfgPath(),
		JSON.stringify({ global: [], models: { aliases: {} } }),
	);
	const a = models.setAlias("my-new-alias", { model: "openai/gpt" });
	assert.equal(a.model, "openai/gpt");
	assert.ok(existsSync(cfgPath()));
	assert.ok(models.getAlias("my-new-alias"));
});

test("invalidAliasNames lists only keys that fail the safe pattern", () => {
	const names = models.invalidAliasNames({
		"good-model": { model: "x" },
		"smart-model <!-- foo -->": { model: "y" },
		UPPER: { model: "z" },
	});
	assert.deepEqual(names.sort(), ["UPPER", "smart-model <!-- foo -->"]);
});

test("isValidAliasName honors the ^[a-z0-9][a-z0-9-]*$ contract", () => {
	assert.equal(models.isValidAliasName("coding-model"), true);
	assert.equal(models.isValidAliasName("a"), true);
	assert.equal(models.isValidAliasName("-starts-with-dash"), false);
	assert.equal(models.isValidAliasName("Has-Upper"), false);
	assert.equal(models.isValidAliasName("has space"), false);
	assert.equal(models.isValidAliasName(""), false);
});

// --- removeAlias ------------------------------------------------------------
// The counterpart to the P11 name check: `set` refuses to WRITE a malformed
// name, but aliases written before that check landed still sit in config.json.
// `removeAlias` is the only way out of that state, so it must not apply the
// same validation that would make those very keys undeletable.

test("removeAlias returns the removed entry and drops the key", () => {
	mkdirSync(path.dirname(cfgPath()), { recursive: true });
	writeFileSync(
		cfgPath(),
		JSON.stringify({
			global: [],
			models: {
				aliases: {
					"keep-model": { category: "coding", model: "openai/a" },
					"drop-model": { category: "smart", model: "openai/b" },
				},
			},
		}),
	);
	const removed = models.removeAlias("drop-model");
	assert.equal(removed.model, "openai/b");
	assert.equal(models.getAlias("drop-model"), null);
	// untouched siblings survive
	assert.equal(models.getAlias("keep-model").model, "openai/a");
	// and the change is persisted, not only in memory
	const onDisk = JSON.parse(readFileSync(cfgPath(), "utf8"));
	assert.deepEqual(Object.keys(onDisk.models.aliases), ["keep-model"]);
});

test("removeAlias deletes a malformed pre-P11 name that setAlias would reject", () => {
	const bad = "smart-model <!-- why this model -->";
	mkdirSync(path.dirname(cfgPath()), { recursive: true });
	writeFileSync(
		cfgPath(),
		JSON.stringify({
			global: [],
			models: { aliases: { [bad]: { category: "smart", model: "openai/gpt-5" } } },
		}),
	);
	assert.equal(models.isValidAliasName(bad), false, "precondition: unwritable name");
	const removed = models.removeAlias(bad);
	assert.equal(removed.model, "openai/gpt-5");
	assert.deepEqual(models.getAliases(), {});
});

test("removeAlias returns null for an unknown alias and leaves config alone", () => {
	mkdirSync(path.dirname(cfgPath()), { recursive: true });
	writeFileSync(
		cfgPath(),
		JSON.stringify({ global: [], models: { aliases: { "a-model": { model: "x" } } } }),
	);
	const before = readFileSync(cfgPath(), "utf8");
	assert.equal(models.removeAlias("nope"), null);
	assert.equal(readFileSync(cfgPath(), "utf8"), before);
});

test("removeAlias returns null when there are no aliases at all", () => {
	writeFileSync(cfgPath(), JSON.stringify({ global: [] }));
	assert.equal(models.removeAlias("anything"), null);
});

test("removeAlias refuses to touch a corrupt config", () => {
	writeFileSync(cfgPath(), "{ not json");
	assert.throws(() => models.removeAlias("a-model"));
	// original bytes intact — a corrupt file is never silently rewritten
	assert.equal(readFileSync(cfgPath(), "utf8"), "{ not json");
});
