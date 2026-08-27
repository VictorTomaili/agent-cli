// src/mcp/protocol.js — MCP wire constants and JSON-RPC framing.
//
// Shared by both sides: src/serve.js (agent-cli AS an MCP server) and
// src/mcp/client.js (agent-cli AS an MCP client, calling other servers). Kept
// dependency-free so either side can import it without pulling in the other.
//
// Framing is newline-delimited JSON-RPC 2.0 over stdio, matching what
// src/serve.js already speaks. There is no Content-Length header framing here
// because nothing agent-cli talks to uses it.

/** The MCP protocol revision agent-cli implements, on both sides. */
export const PROTOCOL_VERSION = "2025-06-18";

/** What agent-cli reports as its client identity during `initialize`. */
export const CLIENT_INFO = { name: "agent-cli", version: null };

/** JSON-RPC error codes we distinguish. */
export const RPC = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
};

/**
 * Error kinds surfaced to the user. These are the ONLY values that appear as
 * `errorKind` in an envelope, so a caller can branch on the category without
 * parsing prose.
 *
 * `tool` is deliberately distinct from the rest: it means the remote server ran
 * the tool and the tool itself reported failure. That is a successful round
 * trip, not a transport problem, and collapsing the two would make a working
 * connection indistinguishable from a dead one.
 */
export const ERROR_KIND = {
	RESOLUTION: "resolution",
	VALIDATION: "validation",
	TRANSPORT: "transport",
	PROTOCOL: "protocol",
	TIMEOUT: "timeout",
	POLICY: "policy",
	TOOL: "tool",
};

let nextId = 0;

/** Monotonic request id. Per-process, so correlation never collides. */
export function newId() {
	nextId += 1;
	return nextId;
}

/** Reset the id counter. Tests only — keeps assertions on ids stable. */
export function resetIds() {
	nextId = 0;
}

/** Build a JSON-RPC request object. */
export function request(method, params, id = newId()) {
	const msg = { jsonrpc: "2.0", id, method };
	if (params !== undefined) msg.params = params;
	return msg;
}

/** Build a JSON-RPC notification (no id, no response expected). */
export function notification(method, params) {
	const msg = { jsonrpc: "2.0", method };
	if (params !== undefined) msg.params = params;
	return msg;
}

/** Serialize one message for the newline-delimited stdio framing. */
export function encode(msg) {
	return JSON.stringify(msg) + "\n";
}

/**
 * Incremental newline-delimited JSON decoder.
 *
 * Servers routinely print non-JSON to stdout before the handshake — npm/npx
 * banners, deprecation notices, "Debugger attached". A decoder that treats the
 * first unparseable line as fatal fails against real servers, so non-JSON lines
 * are handed back separately as `noise` for diagnostics rather than thrown.
 *
 * `maxLineBytes` caps a single line so a server that never emits a newline
 * cannot grow the buffer without bound.
 */
export function createDecoder({ maxLineBytes = 8 * 1024 * 1024 } = {}) {
	let buf = "";
	return {
		/** Feed a chunk; returns { messages, noise, overflow }. */
		push(chunk) {
			buf += chunk;
			const messages = [];
			const noise = [];
			let overflow = false;
			let idx = buf.indexOf("\n");
			while (idx !== -1) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				if (line) {
					try {
						messages.push(JSON.parse(line));
					} catch {
						noise.push(line);
					}
				}
				idx = buf.indexOf("\n");
			}
			if (buf.length > maxLineBytes) {
				overflow = true;
				buf = "";
			}
			return { messages, noise, overflow };
		},
		/** Bytes still buffered without a terminating newline. */
		pending() {
			return buf.length;
		},
	};
}
