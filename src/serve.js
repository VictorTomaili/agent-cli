// src/serve.js — minimal Model Context Protocol (MCP) server over stdio.
// Exposes the read-only SDK (api/index.js) as MCP tools so an MCP host (Claude
// Desktop, VS Code, Cursor, etc.) can call `agent-cli brief`, `doctor`, `search`,
// `snapshot`, `status`, `spect status` as tools, and read/subscribe to MCP
// `resources`. JSON-RPC 2.0, newline-delimited on stdin/stdout. No dependencies.
//
// Phase 6 read-side surface (v0.8.0): tools/list+call (existing), resources/list,
// resources/read, resources/subscribe, plus message-driven change delivery via
// notifications/resources/updated (stateless — see MASTER-PLAN §1 decision 5 +
// A18). Write tools are out of scope until T6.2.5 (v0.8.1).

import { createHash } from "node:crypto";
import readline from "node:readline";
import * as sdk from "./api/index.js";
import {
	READ_CAPABILITIES,
	RESOURCE_DESCRIPTORS,
	SUBSCRIBABLE,
} from "./serve/registry.js";

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

// --- Phase 6 resource wiring (T6.1.2) ----------------------------------------
//
// Mapping rationale: MCP `resources/list` advertises RESOURCE_DESCRIPTORS verbatim
// from the registry (the single source of truth), plus a short `description`
// per entry — the MCP spec wants `{ uri, name, description?, mimeType? }`. We do
// NOT mutate the registry constant; descriptions are appended in serve.js so
// the registry's "zero imports / no-runtime-data" contract (T6.0.3 guard) stays
// clean.

const DESCRIPTIONS = Object.freeze({
	"brain://files/SOUL.md":
		"Brain file: SOUL.md (personality, archetype, voice). Metadata-shaped payload per A3; symlink refusal + missing file returns exists:false.",
	"brain://files/IDENTITY.md":
		"Brain file: IDENTITY.md (agent persona, archetype, model bindings). Same metadata contract as SOUL.md.",
	"brain://files/USER.md":
		"Brain file: USER.md (user profile, preferences). Same metadata contract as SOUL.md.",
	"brain://files/LESSONS.md":
		"Brain file: LESSONS.md (lessons index + content). Same metadata contract as SOUL.md.",
	"brain://files/ENVIRONMENTS.md":
		"Brain file: ENVIRONMENTS.md (per-project environment overrides). Same metadata contract as SOUL.md.",
	"brain://files/MODELS.md":
		"Brain file: MODELS.md (model aliases + providers). Same metadata contract as SOUL.md.",
	"brain://skills/{name}":
		"Installed skill manifest for {name} (RFC 6570 URI template; resolved per read). Returns ok:false + reason on invalid name or not installed.",
	"brain://targets":
		"Enabled integration targets with state (pointer/native/missing/stale) and visibility filter. All 11 targets by default.",
	"brain://lessons/inbox":
		"Raw inbox captures awaiting review (from .inbox directory). Returns {scope, name, file}[] — project + global.",
	"brain://lessons/core":
		"Always-on core lessons extracted from LESSONS.md `## Core` section. Project scope preferred; falls back to global.",
	"brain://session/current":
		"Current session metadata (startedAt, cwd, repo, branch, task, lessonsCaptured) or null when no session is active. Subscribable.",
});

function listResources() {
	return RESOURCE_DESCRIPTORS.map((d) => {
		const description = DESCRIPTIONS[d.uri];
		return description ? { ...d, description } : { ...d };
	});
}

// --- PRODUCERS (URI → SDK call) ----------------------------------------------
//
// PRODUCERS is keyed by exact URI for the 10 concrete URIs in
// RESOURCE_DESCRIPTORS. The single URI template `brain://skills/{name}` is
// handled separately (regex match in produce()). brain://brief is intentionally
// NOT in this map — it is subscribe-only and never readable, so we never want
// resources/read brain://brief to succeed; if a host calls resources/read with
// it, we return "unknown resource" via the RESOURCE_DESCRIPTORS check.

const PRODUCERS = {
	"brain://files/SOUL.md": (args) => sdk.brainFile("SOUL", args || {}),
	"brain://files/IDENTITY.md": (args) => sdk.brainFile("IDENTITY", args || {}),
	"brain://files/USER.md": (args) => sdk.brainFile("USER", args || {}),
	"brain://files/LESSONS.md": (args) => sdk.brainFile("LESSONS", args || {}),
	"brain://files/ENVIRONMENTS.md": (args) => sdk.brainFile("ENVIRONMENTS", args || {}),
	"brain://files/MODELS.md": (args) => sdk.brainFile("MODELS", args || {}),
	"brain://targets": (args) => sdk.targets({ all: true, ...(args || {}) }),
	"brain://lessons/inbox": (args) => sdk.inboxList(args || {}),
	"brain://lessons/core": (args) => sdk.lessonsCore(args || {}),
	"brain://session/current": () => sdk.sessionCurrent(),
};

const SKILL_URI_RE = /^brain:\/\/skills\/([^/]+)$/;

/** Dispatch a URI to its SDK producer. Returns null when no producer matches. */
function produce(uri, args) {
	const producer = PRODUCERS[uri];
	if (producer) return producer(args || {});
	const m = uri.match(SKILL_URI_RE);
	if (m) return sdk.skillManifest(m[1]);
	return null;
}

// --- A15 least-disclosure helper ---------------------------------------------
//
// Resource text + error payloads must not contain absolute paths, backup
// contents, stacks, or raw fs errors. Some SDK payloads (skillManifest,
// lessonsCore, sessionCurrent) include a `path` field that the CLI uses but
// MCP must redact. We deep-walk the value, dropping any `path` key, so the
// MCP layer cannot accidentally leak an absolute path through any producer.

function redactPaths(value, seen) {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return value;
	seen.add(value);
	if (Array.isArray(value)) return value.map((v) => redactPaths(v, seen));
	const out = {};
	for (const k of Object.keys(value)) {
		if (k === "path") continue;
		out[k] = redactPaths(value[k], seen);
	}
	return out;
}

// --- Subscription state (stateless + message-driven, A18) --------------------
//
// No timers, no watchers (per MASTER-PLAN §1 decision 5 + A18). Each inbound
// JSON-RPC message is the "poll tick": after computing the response but
// BEFORE writing it to stdout, serve() walks the subscribed URI set, sha1-
// fingerprints each producer's current output, and emits a
// notifications/resources/updated for any URI whose fingerprint changed since
// the last tick. lastEtagByUri seeds with the first observation after the
// subscribe call so we do not emit a synthetic update the moment a host
// subscribes.

const subscriptions = new Set();
const lastEtagByUri = new Map();

function sha1(s) {
	return createHash("sha1").update(s).digest("hex");
}

/** Deep-stable JSON for fingerprinting (order-independent at the top level). */
function fingerprint(value) {
	return sha1(JSON.stringify(value) || "null");
}

// --- JSON-RPC output helpers ------------------------------------------------

function rpc(id, result) {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function rpcError(id, code, message, data) {
	const error = { code, message };
	if (data !== undefined) error.data = data;
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error }) + "\n");
}
function rpcNotification(method, params) {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

// --- Subscription polling (called by serve() before writing the response) ----
//
// One notification per URI that has changed since the last tick. brain://brief
// and brain://session/current are the only subscribable URIs in v0.8.0. We
// tolerate producer failures (return null/undefined or throw) by leaving the
// lastEtagByUri entry unchanged; the next tick will retry.

async function pollSubscriptions() {
	const updates = [];
	for (const uri of subscriptions) {
		let result;
		try {
			result = await produce(uri, {});
		} catch {
			continue;
		}
		if (result == null) continue;
		const etag = fingerprint(redactPaths(result, new WeakSet()));
		if (lastEtagByUri.get(uri) !== etag) {
			lastEtagByUri.set(uri, etag);
			updates.push({ uri });
		}
	}
	return updates;
}

/**
 * Drop subscription state. Called on stdio reconnect (or process respawn) so a
 * stale subscription set cannot outlive a session. Re-exported for any future
 * `notifications/cancelled` handler.
 */
export function resetSession() {
	subscriptions.clear();
	lastEtagByUri.clear();
}

// --- handleMessage -----------------------------------------------------------
// Handle a single JSON-RPC message. Returns the response object for in-process
// testing, or null when the message produces no response (notifications).
// Writing to stdout happens in serve() via the returned object.

export async function handleMessage(msg) {
	if (!msg || typeof msg !== "object") return null;
	const { id, method, params } = msg;

	if (method === "initialize") {
		return {
			id,
			result: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: READ_CAPABILITIES,
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
			},
		};
	}
	if (method === "notifications/initialized" || method === "notifications/cancelled") {
		return null;
	}
	if (method === "ping") return { id, result: {} };

	if (method === "tools/list") {
		return { id, result: { tools: TOOLS.map(({ call, ...t }) => t) } };
	}
	if (method === "tools/call") {
		const tool = TOOLS.find((t) => t.name === (params && params.name));
		if (!tool) return { id, error: { code: -32602, message: "unknown tool: " + (params && params.name) } };
		try {
			const result = await tool.call((params && params.arguments) || {});
			return {
				id,
				result: {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					isError: false,
				},
			};
		} catch (e) {
			return {
				id,
				result: {
					content: [{ type: "text", text: "error: " + (e && e.message) }],
					isError: true,
				},
			};
		}
	}

	// --- resources/list ---------------------------------------------------
	if (method === "resources/list") {
		return { id, result: { resources: listResources() } };
	}

	// --- resources/read ----------------------------------------------------
	if (method === "resources/read") {
		const uri = params && params.uri;
		if (typeof uri !== "string" || !uri) {
			return { id, error: { code: -32602, message: "uri required" } };
		}
		// brain://brief is subscribe-only and NOT in RESOURCE_DESCRIPTORS, so
		// any resources/read brain://brief surfaces as "unknown resource".
		// The skill URI template is recognized via regex so a host that
		// resolves the template client-side still hits the producer.
		const inList = RESOURCE_DESCRIPTORS.some((d) => d.uri === uri);
		const isTemplate = SKILL_URI_RE.test(uri);
		if (!inList && !isTemplate) {
			return {
				id,
				error: {
					code: -32602,
					message: "unknown resource: " + uri,
					data: { uri, subscribable: [...SUBSCRIBABLE] },
				},
			};
		}
		let raw;
		try {
			raw = await produce(uri, params);
		} catch (e) {
			// A15 least-disclosure: surface structured error.reason only —
			// no absolute paths, no stacks, no raw fs errors.
			const reason = (e && (e.reason || e.code || e.message)) || "producer failed";
			return {
				id,
				result: {
					contents: [{ uri, mimeType: "text/plain", text: "error: " + String(reason) }],
					isError: true,
				},
			};
		}
		if (raw == null) {
			return {
				id,
				error: {
					code: -32602,
					message: "invalid skill URI: " + uri,
					data: { uri, subscribable: [...SUBSCRIBABLE] },
				},
			};
		}
		// A15: strip `path` keys before serialization. JSON.parse(JSON.stringify(...))
		// would lose Map/Set/Date fidelity but every producer here returns a plain
		// object/array; the WeakSet cycle guard handles accidental cycles.
		const clean = redactPaths(raw, new WeakSet());
		return {
			id,
			result: {
				contents: [
					{ uri, mimeType: "application/json", text: JSON.stringify(clean, null, 2) },
				],
			},
		};
	}

	// --- resources/subscribe ----------------------------------------------
	if (method === "resources/subscribe") {
		const uri = params && params.uri;
		if (typeof uri !== "string" || !uri) {
			return { id, error: { code: -32602, message: "uri required" } };
		}
		if (!SUBSCRIBABLE.has(uri)) {
			// Two distinct messages per A4: "unknown resource" (URI not in
			// RESOURCE_DESCRIPTORS + not a template) vs "does not support
			// subscribe" (URI IS in RESOURCE_DESCRIPTORS but not subscribable).
			const inList = RESOURCE_DESCRIPTORS.some((d) => d.uri === uri);
			const isTemplate = SKILL_URI_RE.test(uri);
			const message = inList || isTemplate
				? "resource does not support subscribe: " + uri
				: "unknown resource: " + uri;
			return {
				id,
				error: {
					code: -32602,
					message,
					data: { uri, subscribable: [...SUBSCRIBABLE] },
				},
			};
		}
		// Accept. Seed the fingerprint so the next poll tick does not emit a
		// synthetic update for unchanged state.
		subscriptions.add(uri);
		try {
			const r = await produce(uri, {});
			if (r != null) lastEtagByUri.set(uri, fingerprint(redactPaths(r, new WeakSet())));
			else lastEtagByUri.delete(uri);
		} catch {
			/* leave lastEtagByUri untouched; next tick will catch any change */
		}
		return { id, result: {} };
	}

	return { id, error: { code: -32601, message: "method not found: " + method } };
}

// --- serve() ----------------------------------------------------------------
// Start the stdio MCP server. Resolves only when stdin closes. Subscription
// notifications are emitted on every inbound message, BEFORE the response —
// no timers, no watchers (A18).

export function serve() {
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", async (line) => {
		line = line.trim();
		if (!line) return;
		let msg;
		try { msg = JSON.parse(line); } catch { return; }
		let res;
		try {
			res = await handleMessage(msg);
		} catch {
			return; // never crash the host
		}
		if (!res) return;
		// Poll subscriptions BEFORE writing the response (A18). On reconnect
		// the host must re-initialize; subscriptions cleared via resetSession()
		// from any future notifications/cancelled handler, so a fresh session
		// starts empty.
		try {
			const updates = await pollSubscriptions();
			for (const u of updates) {
				rpcNotification("notifications/resources/updated", u);
			}
		} catch {
			/* swallow — never let poll failures break the response */
		}
		if (res.error) {
			rpcError(res.id, res.error.code, res.error.message, res.error.data);
		} else {
			rpc(res.id, res.result);
		}
	});
	return new Promise((resolve) => rl.on("close", resolve));
}