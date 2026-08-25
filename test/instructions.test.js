// Tests for src/instructions.js + src/commands/instructions.js — the LLM
// discoverability surface. Verifies the Markdown payload is stable
// (snapshot-style), the JSON envelope shape is correct, the CLI command
// emits the expected structure, and Levenshtein-based "Did you mean"
// suggestions work for unknown-command paths.

import { test } from "node:test";
import assert from "node:assert";
import { Command } from "commander";
import {
	INSTRUCTIONS_MARKDOWN,
	INSTRUCTIONS_TOPICS,
	INSTRUCTIONS_BYTE_LENGTH,
	buildInstructionsPayload,
} from "../src/instructions.js";
import {
	registerInstructionsCommand,
	levenshtein,
	closestMatches,
	suggestCommand,
} from "../src/commands/instructions.js";

// ---------------------------------------------------------------------------
// Pure-helper tests (no I/O)
// ---------------------------------------------------------------------------

test("INSTRUCTIONS_MARKDOWN is non-empty and well-formed", () => {
	assert.ok(INSTRUCTIONS_MARKDOWN.length > 1000);
	assert.ok(INSTRUCTIONS_MARKDOWN.startsWith("# agent-cli"));
	assert.ok(INSTRUCTIONS_MARKDOWN.includes("## What this CLI is for"));
	assert.ok(INSTRUCTIONS_MARKDOWN.includes("## Output contract"));
	assert.ok(INSTRUCTIONS_MARKDOWN.includes("## Core workflows"));
	assert.ok(INSTRUCTIONS_MARKDOWN.includes("## Hard rules"));
	assert.ok(INSTRUCTIONS_MARKDOWN.includes("## Quick reference"));
});

test("INSTRUCTIONS_TOPICS covers every H2 section", () => {
	// Headings list: parallel array of expected H2 strings (one per topic).
	// If you rename a section in INSTRUCTIONS_MARKDOWN, update here too —
	// the test guards against silent drift between topics and visible structure.
	const headings = [
		"What this CLI is for",
		"How to run it",
		"Output contract",
		"How to discover",
		"Core workflows",
		"Hard rules",
		"Quick reference",
	];
	for (const topic of [
		"what-this-cli-is-for",
		"how-to-run-it",
		"output-contract",
		"how-to-discover",
		"core-workflows",
		"hard-rules",
		"quick-reference",
	]) {
		assert.ok(INSTRUCTIONS_TOPICS.includes(topic), `topic ${topic} listed`);
	}
	for (const heading of headings) {
		assert.ok(
			INSTRUCTIONS_MARKDOWN.includes(`## ${heading}`),
			`heading '${heading}' present in markdown`,
		);
	}
});

test("INSTRUCTIONS_BYTE_LENGTH matches Buffer.byteLength", () => {
	assert.equal(
		INSTRUCTIONS_BYTE_LENGTH,
		Buffer.byteLength(INSTRUCTIONS_MARKDOWN, "utf8"),
	);
});

test("buildInstructionsPayload returns the documented shape", () => {
	const p = buildInstructionsPayload({ version: "9.9.9", byteLength: 12345 });
	assert.equal(p.content, INSTRUCTIONS_MARKDOWN);
	assert.deepEqual(p.topics, INSTRUCTIONS_TOPICS);
	assert.equal(p.version, "9.9.9");
	assert.equal(p.byteLength, 12345);
	assert.ok(Array.isArray(p.coreCommands) && p.coreCommands.length > 0);
});

// ---------------------------------------------------------------------------
// Levenshtein / closestMatches — pure
// ---------------------------------------------------------------------------

test("levenshtein distance is symmetric and bounded", () => {
	assert.equal(levenshtein("", ""), 0);
	assert.equal(levenshtein("abc", "abc"), 0);
	assert.equal(levenshtein("abc", "abd"), 1);
	assert.equal(levenshtein("abc", "xyz"), 3);
	assert.equal(levenshtein("a", "abc"), 2);
	assert.equal(levenshtein("abc", "a"), 2);
});

test("levenshtein respects the cap (returns cap+1 when exceeded)", () => {
	assert.equal(levenshtein("abcdef", "ghijkl", 3), 4);
	assert.equal(levenshtein("abc", "abc", 100), 0); // below cap
});

test("closestMatches returns suggestions in closeness order", () => {
	const r = closestMatches("stauts", ["status", "stats", "start"], {
		maxSuggestions: 3,
		cap: 4,
	});
	// All three are within edit distance 4 — verify the suggestions include
	// at least the closest matches and are sorted by closeness, not the input
	// order. The exact ordering is implementation-defined for ties.
	assert.ok(r.includes("status"), "status in suggestions");
	assert.ok(r.length <= 3);
	// First element should be at most as far as the last element (sorted asc).
	if (r.length > 1) {
		const first = levenshtein("stauts", r[0], 10);
		const last = levenshtein("stauts", r[r.length - 1], 10);
		assert.ok(first <= last, "sorted by closeness");
	}
});

test("closestMatches returns [] when nothing within cap", () => {
	assert.deepEqual(closestMatches("xyzzy", ["status", "doctor"], { cap: 2 }), []);
});

test("suggestCommand renders the agent-cli <name> form", () => {
	const s = suggestCommand("stauts", ["status", "stats"]);
	assert.match(s, /Did you mean:/);
	assert.match(s, /`agent-cli status`/);
});

test("suggestCommand returns null when no match", () => {
	assert.equal(suggestCommand("zzzzzzz", ["status"]), null);
});

// ---------------------------------------------------------------------------
// CLI surface tests
// ---------------------------------------------------------------------------

function cliHarness() {
	const emitted = [];
	const program = new Command();
	const captured = {
		log: { info() {}, success() {}, warn() {}, error() {}, raw() {}, dim() {}, kv() {} },
		c: new Proxy(
			{},
			{
				get: (_, k) =>
					typeof k === "string" && /^[a-z]/.test(k)
						? (s) => String(s)
						: undefined,
			},
		),
		pretty: (s) => String(s),
		VERSION: "9.9.9",
	};
	registerInstructionsCommand(program, {
		emit: (obj) => {
			emitted.push(obj);
			return obj;
		},
		fail: (msg) => {
			throw new Error(msg);
		},
		...captured,
		isJson: () => false,
	});
	return { program, emitted };
}

async function run(h, args) {
	await h.program.parseAsync(["node", "agent", ...args]);
}

test("CLI instructions prints Markdown by default", async () => {
	const h = cliHarness();
	const captured = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk, ...rest) => {
		captured.push(String(chunk));
		return origWrite(chunk, ...rest);
	};
	try {
		await run(h, ["instructions"]);
	} finally {
		process.stdout.write = origWrite;
	}
	const out = captured.join("");
	assert.ok(out.includes("# agent-cli"));
	assert.ok(out.includes("## What this CLI is for"));
});

test("CLI instructions --json returns the structured payload", async () => {
	// Override isJson via a second registration — easier: use --json by
	// patching the harness.
	const capturedFail = [];
	const program2 = new Command();
	program2.option("--json");
	program2.option("--compact");
	program2.exitOverride();
	const emitted = [];
	registerInstructionsCommand(program2, {
		emit: (obj) => emitted.push(obj),
		fail: (msg) => capturedFail.push(msg),
		log: { info() {}, success() {}, warn() {}, error() {}, raw() {}, dim() {}, kv() {} },
		c: new Proxy({}, { get: () => (s) => String(s) }),
		pretty: (s) => String(s),
		VERSION: "9.9.9",
		isJson: () => true,
	});
	await program2.parseAsync(["node", "agent", "instructions", "--json"]);
	const out = emitted[0];
	assert.equal(out.command, "instructions");
	assert.equal(out.content, INSTRUCTIONS_MARKDOWN);
	assert.equal(out.version, "9.9.9");
	assert.equal(out.byteLength, INSTRUCTIONS_BYTE_LENGTH);
	assert.deepEqual(out.topics, INSTRUCTIONS_TOPICS);
});

test("CLI instructions --topics-only prints the topic list", async () => {
	const h = cliHarness();
	const captured = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk) => {
		captured.push(String(chunk));
		return true;
	};
	try {
		await run(h, ["instructions", "--topics-only"]);
	} finally {
		process.stdout.write = origWrite;
	}
	const out = captured.join("");
	assert.ok(out.includes("what-this-cli-is-for"));
	assert.ok(out.includes("output-contract"));
	assert.ok(out.includes("hard-rules"));
});

test("CLI instructions --commands-only prints the core command list", async () => {
	const h = cliHarness();
	const captured = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk) => {
		captured.push(String(chunk));
		return true;
	};
	try {
		await run(h, ["instructions", "--commands-only"]);
	} finally {
		process.stdout.write = origWrite;
	}
	const out = captured.join("");
	assert.ok(out.includes("init"));
	assert.ok(out.includes("doctor"));
	assert.ok(out.includes("brief"));
});

// ---------------------------------------------------------------------------
// CLI surface test: unknown command surfaces a "Did you mean:" suggestion
// (verified through the registerInstructionsCommand flow + suggestion helpers
// directly — the actual cli.js path is wired in src/cli.js but we don't import
// it here to avoid pulling in the whole program).
// ---------------------------------------------------------------------------

test("suggestCommand for typical typos returns the right fixes", () => {
	assert.match(suggestCommand("stauts", ["status", "doctor", "init"]), /status/);
	assert.match(suggestCommand("docotr", ["doctor", "status", "init"]), /doctor/);
	assert.match(suggestCommand("inist", ["init", "doctor", "status"]), /init/);
});

// function kebabToHeading removed (was unused; js/unused-local-variable)