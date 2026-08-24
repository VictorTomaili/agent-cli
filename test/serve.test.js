// MCP stdio server tests (in-process message handler).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_CLI_HOME = mkdtempSync(path.join(tmpdir(), "agent-serve-"));
const serve = await import("../src/serve.js");

test("initialize returns protocol version + server info", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-06-18", capabilities: {} },
	});
	assert.equal(res.id, 1);
	assert.equal(res.result.protocolVersion, "2025-06-18");
	assert.equal(res.result.serverInfo.name, "agent-cli");
	assert.ok(res.result.capabilities.tools);
});

test("tools/list exposes the read-only tool set", async () => {
	const res = await serve.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	const names = res.result.tools.map((t) => t.name);
	for (const expected of ["brief", "doctor", "search", "snapshot", "status", "spect_status"]) {
		assert.ok(names.includes(expected), `missing tool ${expected}`);
	}
	// every tool has an inputSchema
	for (const t of res.result.tools) assert.ok(t.inputSchema, `no schema for ${t.name}`);
});

test("tools/call brief returns a text content block", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: { name: "brief", arguments: { offline: true } },
	});
	assert.equal(res.result.isError, false);
	assert.equal(res.result.content[0].type, "text");
	const parsed = JSON.parse(res.result.content[0].text);
	assert.ok("suggestedActions" in parsed || "health" in parsed);
});

test("tools/call unknown tool returns -32602", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 4,
		method: "tools/call",
		params: { name: "nope" },
	});
	assert.equal(res.error.code, -32602);
});

test("unknown method returns -32601; ping returns empty result", async () => {
	const res = await serve.handleMessage({ jsonrpc: "2.0", id: 5, method: "frobnicate" });
	assert.equal(res.error.code, -32601);
	const pong = await serve.handleMessage({ jsonrpc: "2.0", id: 6, method: "ping" });
	assert.deepEqual(pong.result, {});
});

test("notifications produce no response", async () => {
	const res = await serve.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	assert.equal(res, null);
});

// --- T6.3.3: Phase 6 prompt regression tests (6 named tests) -----------------
//
// prompts/list + prompts/get wire up to PROMPT_DESCRIPTORS in
// src/serve/registry.js (T6.0.1). The in-process handleMessage is the unit
// under test here; the spawned stdio parity test in test/serve-stdio.test.js
// is the load-bearing byte-comparison check against the real CLI (per
// MASTER-PLAN §1 decision 10: in-process tests are necessary but not
// sufficient — the wire path MUST be exercised through a real stdin/stdout
// pipe to detect serializer drift).

test("prompts/list returns 3 prompts (session-start, instructions, brief-plan)", async () => {
	const res = await serve.handleMessage({ jsonrpc: "2.0", id: 400, method: "prompts/list" });
	assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
	const { prompts } = res.result;
	assert.ok(Array.isArray(prompts), "prompts/list did not return an array");
	assert.equal(prompts.length, 3, `expected 3 prompts, got ${prompts.length}`);
	// Sorted names — the registry lists session-start, instructions, brief-plan
	// in that order, so a sort to a canonical array is the right shape check.
	const names = prompts.map((p) => p.name).sort();
	assert.deepEqual(
		names,
		["brief-plan", "instructions", "session-start"],
		`unexpected prompt names: ${JSON.stringify(names)}`,
	);
	// Every entry carries the wire-shape contract: non-empty description +
	// arguments array (can be empty for prompts without args).
	for (const p of prompts) {
		assert.equal(
			typeof p.description,
			"string",
			`${p.name} description is not a string`,
		);
		assert.ok(
			p.description.length > 0,
			`${p.name} description is empty`,
		);
		assert.ok(
			Array.isArray(p.arguments),
			`${p.name} arguments is not an array`,
		);
	}
});

test("prompts/get session-start returns a single user text message with non-empty text", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 401,
		method: "prompts/get",
		params: { name: "session-start" },
	});
	assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
	const msgs = res.result.messages;
	assert.ok(Array.isArray(msgs), "messages is not an array");
	assert.equal(msgs.length, 1, `expected 1 message, got ${msgs.length}`);
	assert.equal(msgs[0].role, "user");
	assert.equal(msgs[0].content.type, "text");
	assert.equal(
		typeof msgs[0].content.text,
		"string",
		"session-start text is not a string",
	);
	assert.ok(
		msgs[0].content.text.length > 0,
		"session-start text is empty",
	);
});

test("prompts/get instructions returns a single user text message with non-empty text", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 402,
		method: "prompts/get",
		params: { name: "instructions" },
	});
	assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
	const msgs = res.result.messages;
	assert.ok(Array.isArray(msgs), "messages is not an array");
	assert.equal(msgs.length, 1, `expected 1 message, got ${msgs.length}`);
	assert.equal(msgs[0].role, "user");
	assert.equal(msgs[0].content.type, "text");
	assert.equal(
		typeof msgs[0].content.text,
		"string",
		"instructions text is not a string",
	);
	assert.ok(
		msgs[0].content.text.length > 0,
		"instructions text is empty",
	);
});

test("prompts/get brief-plan JSON-stringifies a structured payload (with `for` arg)", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 403,
		method: "prompts/get",
		params: { name: "brief-plan", arguments: { for: "phase-6-mcp" } },
	});
	assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
	const msgs = res.result.messages;
	assert.equal(msgs.length, 1, `expected 1 message, got ${msgs.length}`);
	assert.equal(msgs[0].role, "user");
	assert.equal(msgs[0].content.type, "text");
	// brief-plan's `text` is a JSON-stringified structured payload (per
	// serve.js PRODUCERS_PROMPTS). Hosts JSON.parse it client-side.
	let parsed;
	assert.doesNotThrow(
		() => {
			parsed = JSON.parse(msgs[0].content.text);
		},
		"brief-plan text is not valid JSON",
	);
	assert.equal(
		parsed.for,
		"phase-6-mcp",
		`brief-plan payload must echo the for argument; got ${JSON.stringify(parsed.for)}`,
	);
});

test("prompts/get unknown prompt returns -32602 'unknown prompt: <name>'", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 404,
		method: "prompts/get",
		params: { name: "not-a-real-prompt" },
	});
	assert.ok(res.error, `expected error, got ${JSON.stringify(res)}`);
	assert.equal(res.error.code, -32602);
	assert.equal(res.error.message, "unknown prompt: not-a-real-prompt");
});

test("prompts/get without a name returns -32602 (params missing)", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 405,
		method: "prompts/get",
		params: {},
	});
	assert.ok(res.error, `expected error, got ${JSON.stringify(res)}`);
	assert.equal(res.error.code, -32602);
	// Message must be non-empty so a host can surface a useful diagnostic.
	// The wire code concatenates "unknown prompt: " with the missing name
	// (undefined → "undefined" via String()); either is acceptable.
	assert.equal(typeof res.error.message, "string");
	assert.ok(
		res.error.message.length > 0,
		"error message must be non-empty",
	);
});
