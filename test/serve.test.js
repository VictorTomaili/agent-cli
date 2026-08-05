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
