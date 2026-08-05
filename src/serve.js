// src/serve.js — minimal Model Context Protocol (MCP) server over stdio.
// Exposes the read-only SDK (api/index.js) as MCP tools so an MCP host (Claude
// Desktop, VS Code, Cursor, etc.) can call `agent brief`, `doctor`, `search`,
// `snapshot`, `status`, `spect status` as tools. JSON-RPC 2.0, newline-delimited
// on stdin/stdout. No dependencies.

import readline from "node:readline";
import * as sdk from "./api/index.js";

export const SERVER_NAME = "agent-cli";
export const SERVER_VERSION = "2.0.0";
export const PROTOCOL_VERSION = "2025-06-18";

// Tool → SDK call mapping. Each tool returns a plain object; the MCP layer wraps
// it in JSON content blocks.
const TOOLS = [
	{
		name: "brief",
		description: "Current state: drift, archetype, unresolved models, suggested actions.",
		inputSchema: { type: "object", properties: { offline: { type: "boolean" } } },
		call: async (args) => sdk.brief({ offline: !!(args && args.offline) }),
	},
	{
		name: "doctor",
		description: "Run the full diagnostic suite (exit-code-independent).",
		inputSchema: { type: "object", properties: { offline: { type: "boolean" } } },
		call: async (args) => sdk.doctor({ offline: !!(args && args.offline) }),
	},
	{
		name: "search",
		description: "Search lessons and the master for a query.",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		call: async (args) => sdk.search(args && args.query ? args.query : ""),
	},
	{
		name: "snapshot",
		description: "List snapshots (or take one with now=true).",
		inputSchema: { type: "object", properties: { now: { type: "boolean" } } },
		call: async (args) => (args && args.now ? sdk.snapshotNow() : sdk.snapshotsList()),
	},
	{
		name: "status",
		description: "Overall status: targets, pointers, skill, identity.",
		inputSchema: { type: "object", properties: { all: { type: "boolean" } } },
		call: async (args) => sdk.status({ all: !!(args && args.all) }),
	},
	{
		name: "spect_status",
		description: "Inspect the project SPECT: requirements, tasks, progress.",
		inputSchema: { type: "object", properties: {} },
		call: async () => sdk.spectStatus(),
	},
];

function rpc(id, result) {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function rpcError(id, code, message) {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

// Handle a single JSON-RPC message. Returns the response object for in-process
// testing, or null when the message produces no response (notifications).
// Writing to stdout happens in serve() via the returned object.
export async function handleMessage(msg) {
	if (!msg || typeof msg !== "object") return null;
	const { id, method, params } = msg;
	if (method === "initialize") {
		return { id, result: {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: { tools: {}, resources: {} },
			serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
		} };
	}
	if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
	if (method === "ping") return { id, result: {} };
	if (method === "tools/list") {
		return { id, result: { tools: TOOLS.map(({ call, ...t }) => t) } };
	}
	if (method === "tools/call") {
		const tool = TOOLS.find((t) => t.name === (params && params.name));
		if (!tool) return { id, error: { code: -32602, message: "unknown tool: " + (params && params.name) } };
		try {
			const result = await tool.call((params && params.arguments) || {});
			return { id, result: {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				isError: false,
			} };
		} catch (e) {
			return { id, result: {
				content: [{ type: "text", text: "error: " + (e && e.message) }],
				isError: true,
			} };
		}
	}
	if (method === "resources/list") return { id, result: { resources: [] } };
	return { id, error: { code: -32601, message: "method not found: " + method } };
}

// Start the stdio MCP server. Resolves only when stdin closes.
export function serve() {
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", (line) => {
		line = line.trim();
		if (!line) return;
		let msg;
		try { msg = JSON.parse(line); } catch { return; }
		handleMessage(msg).then((res) => {
			if (!res) return;
			if (res.error) rpcError(res.id, res.error.code, res.error.message);
			else rpc(res.id, res.result);
		}).catch(() => {});
	});
	return new Promise((resolve) => rl.on("close", resolve));
}
