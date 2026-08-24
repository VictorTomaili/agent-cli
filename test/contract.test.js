// Unit tests for the JSON envelope contract (src/envelope.js).
// Behavioral exit-code tests live in test/cli.test.js (Phase 0 section).
import { test } from "node:test";
import assert from "node:assert";
import {
	API_VERSION,
	EXIT,
	envelope,
	stripAnsi,
	stripAnsiDeep,
	serializeEnvelope,
} from "../src/envelope.js";
import {
	RESOURCE_DESCRIPTORS,
	PROMPT_DESCRIPTORS,
	SUBSCRIBABLE,
} from "../src/serve/registry.js";
import { handleMessage } from "../src/serve.js";

test("envelope() builds the versioned shape", () => {
	const env = envelope({ command: "status", data: { ok: true } });
	assert.deepEqual(env, {
		ok: true,
		command: "status",
		apiVersion: API_VERSION,
		data: { ok: true },
	});
});

test("envelope() with an error flips ok and carries the message at top level", () => {
	const env = envelope({ command: "x", data: { id: 1 }, error: "boom" });
	assert.equal(env.ok, false);
	assert.equal(env.error, "boom");
	assert.deepEqual(env.data, { id: 1 });
});

test("envelope() defaults ok:true and empty data", () => {
	const env = envelope({ command: "y" });
	assert.equal(env.ok, true);
	assert.deepEqual(env.data, {});
});

test("EXIT codes match the documented contract", () => {
	assert.deepEqual(EXIT, { OK: 0, ERROR: 1, WORK: 2, PARTIAL: 3 });
});

test("stripAnsi removes SGR escape sequences", () => {
	const s = "\u001b[36mcyan\u001b[39m plain \u001b[1mbold\u001b[22m";
	assert.equal(stripAnsi(s), "cyan plain bold");
	assert.equal(stripAnsi("no escapes"), "no escapes");
	assert.equal(stripAnsi(null), "");
});

test("stripAnsiDeep recurses through arrays and objects", () => {
	const input = {
		a: "\u001b[1mhi\u001b[22m",
		list: ["\u001b[31mred\u001b[39m", 3, { b: "\u001b[90mdim\u001b[39m" }],
		n: null,
	};
	const out = stripAnsiDeep(input);
	assert.equal(out.a, "hi");
	assert.equal(out.list[0], "red");
	assert.equal(out.list[2].b, "dim");
	assert.equal(out.n, null);
});

test("serializeEnvelope emits plain (ANSI-free) JSON", () => {
	const out = serializeEnvelope(
		envelope({ command: "t", data: { msg: "\u001b[36mhi\u001b[39m" } }),
	);
	assert.ok(!out.includes("\u001b"));
	const parsed = JSON.parse(out);
	assert.equal(parsed.data.msg, "hi");
});

test("serializeEnvelope compact mode is single-line", () => {
	const out = serializeEnvelope(envelope({ command: "t" }), { compact: true });
	assert.ok(!out.includes("\n"));
});

// --- T6.1.4: manifest cross-check against pinned canonical Phase 6 set -------
//
// Per MASTER-PLAN §1 decision 6: the manifest parity test compares the MCP
// resources/prompts/tools against a PINNED canonical URI set — NOT equality,
// which can drift together when both sides are touched in the same patch.
// The canonical sources are read from src/serve/registry.js (the registry is
// the single source of truth for descriptors) and against a hardcoded
// string set for the 6 read-only TOOLS (TOOLS is a local constant in
// serve.js with no registry mirror). Each assertion uses `assert.deepEqual`
// on sorted URI/name strings — a "subset" or "intersects" check would let
// drift slip through silently.
//
// MUTATION-CHECK INVARIANT (qa-agent role card): each test must fail when
// the registry drifts. Verified by mutation in §VALIDATION of the qa-agent
// final report — adding/removing URIs to the registry surfaces here.

// Hardcoded canonical tool name set. TOOLS is a local constant in
// serve.js#TOOLS — no registry mirror exists for the 6 read-only tools.
// Pinning the names as a string array makes this test a true drift
// detector: any tool added/removed from serve.js's TOOLS breaks the parity
// test, regardless of whether the registry changes.
const CANONICAL_TOOLS = Object.freeze([
	"brief",
	"doctor",
	"search",
	"snapshot",
	"status",
	"spect_status",
]);

test("T6.1.4 resources/list === canonical RESOURCE_DESCRIPTORS (drift detector)", async () => {
	const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "resources/list" });
	assert.ok(res.result && Array.isArray(res.result.resources), "resources/list must return a resources array");
	const actual = res.result.resources.map((r) => r.uri).slice().sort();
	const canonical = RESOURCE_DESCRIPTORS.map((d) => d.uri).slice().sort();
	assert.deepEqual(
		actual,
		canonical,
		"resources/list URI set must match canonical RESOURCE_DESCRIPTORS bit-for-bit (MASTER-PLAN §1 decision 6)",
	);
});

test("T6.1.4 prompts/list === canonical PROMPT_DESCRIPTORS (drift detector)", async () => {
	const res = await handleMessage({ jsonrpc: "2.0", id: 2, method: "prompts/list" });
	assert.ok(res.result && Array.isArray(res.result.prompts), "prompts/list must return a prompts array");
	const actual = res.result.prompts.map((p) => p.name).slice().sort();
	const canonical = PROMPT_DESCRIPTORS.map((d) => d.name).slice().sort();
	assert.deepEqual(
		actual,
		canonical,
		"prompts/list name set must match canonical PROMPT_DESCRIPTORS bit-for-bit (MASTER-PLAN §1 decision 6)",
	);
});

test("T6.1.4 tools/list === canonical read-only TOOLS (drift detector)", async () => {
	const res = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" });
	assert.ok(res.result && Array.isArray(res.result.tools), "tools/list must return a tools array");
	const actual = res.result.tools.map((t) => t.name).slice().sort();
	const canonical = CANONICAL_TOOLS.slice().sort();
	assert.deepEqual(
		actual,
		canonical,
		"tools/list name set must match the 6 pinned read-only tools (any drift breaks parity)",
	);
});

test("T6.1.4 resources/subscribe data.subscribable === canonical SUBSCRIBABLE (drift detector)", async () => {
	// A4 — every -32602 rejection (both shapes: "unknown resource" and
	// "resource does not support subscribe") carries data.subscribable as
	// the canonical 2-entry set. We cross-check BOTH shapes because each
	// rejection path is built from the same SUBSCRIBABLE constant.
	const subscribableRejections = [
		// valid URI, not subscribable → "resource does not support subscribe"
		await handleMessage({
			jsonrpc: "2.0",
			id: 10,
			method: "resources/subscribe",
			params: { uri: "brain://files/SOUL.md" },
		}),
		// unknown URI → "unknown resource"
		await handleMessage({
			jsonrpc: "2.0",
			id: 11,
			method: "resources/subscribe",
			params: { uri: "brain://totally-unknown" },
		}),
	];
	const canonical = [...SUBSCRIBABLE].slice().sort();
	for (const r of subscribableRejections) {
		assert.equal(r.error.code, -32602, "subscribe rejection must be -32602");
		assert.ok(
			Array.isArray(r.error.data?.subscribable),
			"rejection must carry data.subscribable array",
		);
		const actual = r.error.data.subscribable.slice().sort();
		assert.deepEqual(
			actual,
			canonical,
			"resources/subscribe data.subscribable must match canonical SUBSCRIBABLE",
		);
	}
});

