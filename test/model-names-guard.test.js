// Architecture regression, not a style nit: no concrete model identifier may be
// hardcoded in shipped source.
//
// agent-cli used to carry a 24-entry model catalog in src/models.js and write it
// into the user's MODELS.md as if authoritative. It went stale between releases
// — by the time it was removed it still named a GPT-5 that had been superseded
// twice — and it contradicted the header agent-cli itself writes into that file:
// "agent-cli only stores configuration; it does not perform research, model
// calls, or capability tests."
//
// Models are referred to by ALIAS (smart-model, fast-model, cheap-model,
// coding-model, review-model, deepsearch-model). Concrete provider/model ids
// live in the user's MODELS.md, imported by `agent-cli models research --fetch`.
//
// A line that genuinely needs a family keyword (the live-catalog classifier)
// opts out with a trailing `model-name-guard:allow` comment, so the exemption is
// visible at the point of use rather than hidden in a line range here.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["src", "seed", "scripts"];
const EXT = new Set([".js", ".mjs", ".json", ".md", ".yaml", ".yml"]);
const ALLOW_MARKER = "model-name-guard:allow";

// A model family name followed by a version number, in any of the separator
// styles vendors actually use: gpt-5, gpt-4.1, claude-opus-4-7, gemini-2.5-pro,
// mistral-large-2, llama-3.3-70b, qwen2.5-coder:32b, deepseek-r1:32b, glm-5.3.
// The `([-.:_][a-z]+)*` run is what catches the ones a naive
// `family[-.:_]?\d` pattern misses, i.e. every id with a size word before the
// number (claude-opus-4-7, mistral-large-2).
const FAMILY_VERSION =
	/\b(gpt|claude|gemini|llama|mistral|codestral|qwen|glm|grok|deepseek|minimax|phi|command-r)([-.:_][a-z]+)*[-.:_]?\d/i;

// Versionless but still concrete product ids.
const NAMED_MODEL = /\bdeepseek-(chat|reasoner|coder)\b|\bo[3-9]-(mini|preview)\b/i;

// A provider slug followed by a real model id (anthropic/claude-sonnet-4-5,
// openai/gpt-5). Placeholders like `<provider>/<model>` do not match.
const PROVIDER_SLUG =
	/\b(openai|anthropic|google|mistralai|deepseek|ollama|openrouter|zai|minimax|moonshot|meta-llama)\/[a-z0-9][a-z0-9._-]*/i;

const PATTERNS = [
	["family+version", FAMILY_VERSION],
	["named-model", NAMED_MODEL],
	["provider/model", PROVIDER_SLUG],
];

function walk(dir, out = []) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === "node_modules" || e.name === ".git") continue;
			walk(p, out);
		} else if (EXT.has(path.extname(e.name))) {
			out.push(p);
		}
	}
	return out;
}

function scan(files) {
	const hits = [];
	for (const file of files) {
		const rel = path.relative(ROOT, file).split(path.sep).join("/");
		const lines = fs.readFileSync(file, "utf8").split("\n");
		lines.forEach((line, i) => {
			if (line.includes(ALLOW_MARKER)) return;
			for (const [name, re] of PATTERNS) {
				if (re.test(line)) {
					hits.push(`${rel}:${i + 1} [${name}] ${line.trim().slice(0, 120)}`);
					break;
				}
			}
		});
	}
	return hits;
}

test("no concrete model identifier is hardcoded in src/, seed/ or scripts/", () => {
	const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)));
	assert.ok(files.length > 100, `expected to scan a real tree, got ${files.length}`);
	const hits = scan(files);
	assert.deepEqual(
		hits,
		[],
		`hardcoded model identifier(s) found — refer to models by alias instead, and let the user's MODELS.md hold concrete ids:\n${hits.join("\n")}`,
	);
});

test("the guard actually catches the catalog it was written to prevent", () => {
	// Every id from the deleted bundled catalog, verbatim. If a future edit
	// weakens the patterns, this fails before the guard silently stops working.
	// An earlier draft of these patterns matched only 15 of these 24.
	const DELETED_CATALOG_IDS = [
		"gpt-5",
		"gpt-5-mini",
		"gpt-4.1",
		"gpt-4.1-mini",
		"gpt-4.1-nano",
		"o3",
		"o4-mini",
		"claude-opus-4-7",
		"claude-sonnet-4-5",
		"claude-haiku-4-5",
		"gemini-2.5-pro",
		"gemini-2.5-flash",
		"gemini-2.5-flash-lite",
		"mistral-large-2",
		"mistral-small-3",
		"codestral-25",
		"deepseek-chat",
		"deepseek-reasoner",
		"qwen2.5-coder:32b",
		"qwen2.5:72b",
		"llama-3.3-70b",
		"deepseek-r1:32b",
		"anthropic/claude-sonnet-4-5",
		"openai/gpt-5",
	];
	const missed = DELETED_CATALOG_IDS.filter(
		(id) => !PATTERNS.some(([, re]) => re.test(`\t{ id: "${id}", provider: "x" },`)),
	);
	// `o3` alone is deliberately not matched: a bare two-character token is not
	// distinguishable from ordinary code, and it never appears without a
	// provider slug in practice. Every other id must be caught.
	assert.deepEqual(missed, ["o3"], "the guard must catch the ids it exists to catch");
});

test("the guard does not flag aliases, placeholders or tool names", () => {
	// False positives here would push people to disable the guard, so pin the
	// vocabulary the codebase legitimately uses.
	const MUST_NOT_MATCH = [
		"smart-model",
		"fast-model",
		"cheap-model",
		"coding-model",
		"review-model",
		"deepsearch-model",
		"agent-cli models set <alias> <provider/model>",
		"tool:provider/model[:thinking]",
		'"pi:<provider>/<model>:<thinking>"',
		// integration targets are products, not models
		"src/targets/deepseek.js",
		"~/.qwen/QWEN.md",
		"DeepSeek Harness",
		"Qwen Code",
		"npx -y @z_ai/mcp-server",
	];
	const wrong = MUST_NOT_MATCH.filter((s) =>
		PATTERNS.some(([, re]) => re.test(s)),
	);
	assert.deepEqual(wrong, [], "guard must not flag legitimate vocabulary");
});
