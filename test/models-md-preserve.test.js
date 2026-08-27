// Regression: `agent-cli models set` must UPSERT a single <ALIAS> line in
// ~/.agents/MODELS.md, not regenerate the whole `## Aliases` block from
// config.json.
//
// The bug: writeModelsMd() rendered the block from `config.json#models.aliases`
// alone, so every alias line the config had not (yet) heard of was deleted, and
// setAlias() merged over a config-only `prev`, so the target's fallback chain
// was cleared too. One documented invocation
// (`agent-cli models set <alias> <provider/model>`) could leave the machine with
// a single alias and no failover chain — silently, with a success line printed.
// MODELS.md is hand-editable by design and is not tracked by git, so the drift
// that triggers this is normal, and the loss is unrecoverable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"cli.js",
);

// Sandbox every home-ish variable BEFORE importing any src module: HOME is
// resolved at import time, and the real ~/.agents must never be reachable.
const TMP = mkdtempSync(path.join(tmpdir(), "agent-modelsmd-"));
process.env.AGENT_CLI_HOME = TMP;
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const models = await import("../src/models.js");

// A MODELS.md as a real machine has it: several aliases, each with its own
// non-empty fallback chain, around hand-written prose. `cheap-model` is written
// with its attributes in a different order — a byte-identical survival check is
// only meaningful if the writer cannot have re-rendered the line to match.
const SEED = `# MODELS.md — model aliases

> Edit with \`agent-cli models set <alias> <provider/model> --fallback <provider/model>...\`.

## Aliases

<ALIAS name="coding-model" category="coding" thinking="high" fallbacks="openai/gpt-5.6-sol,zai/glm-5.3">anthropic/claude-opus-5</ALIAS>
<ALIAS name="fast-model" category="fast" thinking="off" fallbacks="google/gemini-3-flash">anthropic/claude-haiku-4-5</ALIAS>
<ALIAS name="smart-model" category="smart" thinking="high" fallbacks="openai/gpt-5.6-terra">anthropic/claude-opus-5</ALIAS>
<ALIAS thinking="off" name="cheap-model" fallbacks="deepseek/v4-flash" category="cheap">zai/glm-5.3</ALIAS>
<ALIAS name="deepsearch-model" category="deepsearch" thinking="high" fallbacks="openai/o5">google/gemini-3-pro</ALIAS>
<ALIAS name="haiku" category="fast" thinking="off" fallbacks="google/gemini-3-flash">anthropic/claude-haiku-4-5</ALIAS>
<ALIAS name="review-model" category="smart" thinking="high" fallbacks="minimax/MiniMax-M3,openai/gpt-5.6-sol,openai/gpt-5.6-terra">zai/glm-5.2</ALIAS>

## Categories
- **fast** — low-latency, simple tasks

## Pi Agent Bridge

Hand-written prose that must survive.
`;

/** A fresh sandboxed home seeded with SEED. Never touches the real ~/.agents. */
function seedHome() {
	const home = mkdtempSync(path.join(tmpdir(), "agent-modelsmd-home-"));
	mkdirSync(path.join(home, ".agents"), { recursive: true });
	writeFileSync(path.join(home, ".agents", "MODELS.md"), SEED);
	return home;
}

function run(args, home) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			AGENT_CLI_HOME: home,
			HOME: home,
			USERPROFILE: home,
			AGENT_OFFLINE: "1",
		},
	});
	let parsed = null;
	try {
		parsed = JSON.parse(r.stdout);
	} catch {
		/* non-JSON output */
	}
	return { status: r.status, parsed, stdout: r.stdout, stderr: r.stderr };
}

const readMd = (home) =>
	readFileSync(path.join(home, ".agents", "MODELS.md"), "utf8");
const aliasLines = (md) =>
	md.split("\n").filter((l) => l.trimStart().startsWith("<ALIAS "));
const lineFor = (md, name) =>
	aliasLines(md).find((l) => l.includes(`name="${name}"`));

test("models set rewrites one alias line and leaves every other byte-identical", () => {
	const home = seedHome();
	const before = readMd(home);
	const beforeLines = aliasLines(before);
	assert.equal(beforeLines.length, 7, "seed has 7 aliases");

	const r = run(
		["models", "set", "review-model", "zai/glm-5.3", "--category", "smart", "--thinking", "high"],
		home,
	);
	assert.equal(r.status, 0, r.stderr);

	const after = readMd(home);
	const afterLines = aliasLines(after);

	// (a) the alias count is unchanged.
	assert.equal(afterLines.length, beforeLines.length);

	// (b) every other alias line is byte-identical, and still in place.
	for (let i = 0; i < beforeLines.length; i++) {
		if (beforeLines[i].includes('name="review-model"')) continue;
		assert.equal(afterLines[i], beforeLines[i], `alias line ${i} changed`);
	}

	// (c) the target's fallbacks survive because --fallback was not passed.
	assert.equal(
		lineFor(after, "review-model"),
		'<ALIAS name="review-model" category="smart" thinking="high" fallbacks="minimax/MiniMax-M3,openai/gpt-5.6-sol,openai/gpt-5.6-terra">zai/glm-5.3</ALIAS>',
	);

	// Hand-written prose outside the block is untouched, as before.
	assert.ok(after.includes("Hand-written prose that must survive."));
});

test("models set without --fallback preserves fallbacks in config.json too", () => {
	const home = seedHome();
	run(["models", "set", "review-model", "zai/glm-5.3"], home);
	const resolved = run(["models", "resolve", "review-model", "--json"], home);
	assert.equal(resolved.parsed.ok, true);
	assert.deepEqual(resolved.parsed.data.resolved.fallbacks, [
		"minimax/MiniMax-M3",
		"openai/gpt-5.6-sol",
		"openai/gpt-5.6-terra",
	]);
	// category/thinking carried over from MODELS.md as well.
	assert.equal(resolved.parsed.data.resolved.category, "smart");
	assert.equal(resolved.parsed.data.resolved.thinking, "high");
});

test("(d) --fallback still replaces the chain", () => {
	const home = seedHome();
	const r = run(
		["models", "set", "review-model", "zai/glm-5.3", "--fallback", "openai/gpt-5.6-sol", "openai/gpt-5.6-terra"],
		home,
	);
	assert.equal(r.status, 0, r.stderr);
	const after = readMd(home);
	assert.equal(
		lineFor(after, "review-model"),
		'<ALIAS name="review-model" category="smart" thinking="high" fallbacks="openai/gpt-5.6-sol,openai/gpt-5.6-terra">zai/glm-5.3</ALIAS>',
	);
	assert.equal(aliasLines(after).length, 7, "still 7 aliases");
});

test("a brand-new alias is appended without disturbing the existing lines", () => {
	const home = seedHome();
	const beforeLines = aliasLines(readMd(home));
	const r = run(
		["models", "set", "vision-model", "google/gemini-3-pro", "--category", "vision"],
		home,
	);
	assert.equal(r.status, 0, r.stderr);
	const afterLines = aliasLines(readMd(home));
	assert.equal(afterLines.length, 8);
	assert.deepEqual(afterLines.slice(0, 7), beforeLines);
	assert.match(afterLines[7], /name="vision-model"/);
});

test("models rm removes exactly the one alias line", () => {
	const home = seedHome();
	const beforeLines = aliasLines(readMd(home));
	const r = run(["models", "rm", "review-model"], home);
	assert.equal(r.status, 0, r.stderr);
	const afterLines = aliasLines(readMd(home));
	assert.equal(afterLines.length, 6);
	assert.deepEqual(
		afterLines,
		beforeLines.filter((l) => !l.includes('name="review-model"')),
	);
});

test("models rm clears a line that exists only in MODELS.md", () => {
	const home = seedHome();
	// `haiku` is in the file and has never been through config.json.
	const r = run(["models", "rm", "haiku"], home);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(aliasLines(readMd(home)).length, 6);
	assert.equal(lineFor(readMd(home), "haiku"), undefined);

	const missing = run(["models", "rm", "not-an-alias"], home);
	assert.equal(missing.status, 1);
});

test("two consecutive sets are each a single-line change", () => {
	const home = seedHome();
	run(["models", "set", "fast-model", "google/gemini-3-flash"], home);
	const mid = aliasLines(readMd(home));
	run(["models", "set", "smart-model", "openai/gpt-5.6-terra"], home);
	const after = aliasLines(readMd(home));
	assert.equal(after.length, 7);
	for (let i = 0; i < mid.length; i++) {
		if (mid[i].includes('name="smart-model"')) continue;
		assert.equal(after[i], mid[i]);
	}
});

test("parseAliasLine round-trips attribute order and escaped characters", () => {
	const shuffled =
		'<ALIAS thinking="off" name="cheap-model" fallbacks="deepseek/v4-flash" category="cheap">zai/glm-5.3</ALIAS>';
	assert.deepEqual(models.parseAliasLine(shuffled), {
		name: "cheap-model",
		entry: {
			model: "zai/glm-5.3",
			category: "cheap",
			thinking: "off",
			fallbacks: ["deepseek/v4-flash"],
		},
	});
	// Escaped characters decode; &amp; is undone last so nothing double-decodes.
	const escaped =
		'<ALIAS name="odd" category="smart" thinking="" fallbacks="a&amp;b/x">p&amp;q/&lt;m&gt;</ALIAS>';
	assert.deepEqual(models.parseAliasLine(escaped).entry, {
		model: "p&q/<m>",
		category: "smart",
		fallbacks: ["a&b/x"],
	});
	assert.equal(models.parseAliasLine("not an alias line"), null);
	assert.equal(models.parseAliasLine("<ALIAS category=\"smart\">x/y</ALIAS>"), null);
});

test("parseModelsMdAliases reads every line of a seeded document", () => {
	const parsed = models.parseModelsMdAliases(SEED);
	assert.deepEqual(Object.keys(parsed), [
		"coding-model",
		"fast-model",
		"smart-model",
		"cheap-model",
		"deepsearch-model",
		"haiku",
		"review-model",
	]);
	assert.deepEqual(parsed["coding-model"].fallbacks, [
		"openai/gpt-5.6-sol",
		"zai/glm-5.3",
	]);
});
