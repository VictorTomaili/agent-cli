// src/serve.js — minimal Model Context Protocol (MCP) server over stdio.
// Exposes the read-only SDK (api/index.js) as MCP tools so an MCP host (Claude
// Desktop, VS Code, Cursor, etc.) can call `agent-cli brief`, `doctor`, `search`,
// `snapshot`, `status`, `spect status` as tools, and read/subscribe to MCP
// `resources`. JSON-RPC 2.0, newline-delimited on stdin/stdout. No dependencies.
//
// Phase 6 surface (v0.8.0 read-side → v0.8.1 write-side): tools/list+call
// (existing read tools + write tools gated by T6.2.5), resources/list,
// resources/read, resources/subscribe, plus message-driven change delivery via
// notifications/resources/updated (stateless — see MASTER-PLAN §1 decision 5 +
// A18). Write tools (T6.2.5) are exposed only after `initialize` establishes
// `serverInitialized` AND the host offered
// `capabilities.experimental.agentCli.writeTools === true` (exact boolean).

import { createHash } from "node:crypto";
import readline from "node:readline";
import * as sdk from "./api/index.js";
import {
	READ_CAPABILITIES,
	WRITE_CAPABILITY,
	RESOURCE_DESCRIPTORS,
	PROMPT_DESCRIPTORS,
	SUBSCRIBABLE,
	WRITE_TOOLS,
} from "./serve/registry.js";

export const SERVER_NAME = "agent-cli";
export const SERVER_VERSION = "2.0.0";
export const PROTOCOL_VERSION = "2025-06-18";

// --- Per-session capability state (T6.2.5) ----------------------------------
//
// serverInitialized: set to true only when `initialize` was received. Reporters
//   (tools/list, tools/call) use it to refuse write traffic before the host has
//   gone through the handshake (A19 — no writes, no crash).
// writeCapabilityOffered: set only when the host OFFERED write capability in
//   `initialize` (`capabilities.experimental.agentCli.writeTools === true`,
//   exact boolean — truthy strings fail closed per MASTER-PLAN §1 decision 4).
//   Bound per-session (A16); reconnect must re-`initialize` (resetSession()
//   clears both flags on process respawn/reconnect).
let serverInitialized = false;
let writeCapabilityOffered = false;

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

// --- Phase 6 write tool definitions (T6.2.5) ----------------------------------
//
// The 10 write tools mirror the SDK functions in src/api/write.js, which are
// re-exported from src/api/index.js — so the single `import * as sdk` in
// serve.js already sees both the read and write halves. Each `call` dispatches
// to the SDK function with the raw MCP arguments object; the SDK returns the
// `{ ok, command, apiVersion, data, ... }` envelope, which tools/call wraps in
// the MCP wire shape `{ content: [{ type: "text", text: JSON.stringify(...) }],
// isError: !result.ok }`.
//
// WRITE_TOOLS (registry.js) is the authoritative inventory + gate. These defs
// are only the tool metadata + dispatch — gating on serverInitialized and
// writeCapabilityOffered happens in tools/call (and tools/list only advertises
// them when offered).

const WRITE_TOOLS_TOOL_DEFS = [
	{
		name: "brain_write",
		description: "Write content to a brain file (SOUL/IDENTITY/USER/LESSONS/ENVIRONMENTS/MODELS) under a scope.",
		inputSchema: {
			type: "object",
			properties: {
				kind: {
					type: "string",
					enum: ["SOUL", "IDENTITY", "USER", "LESSONS", "ENVIRONMENTS", "MODELS"],
				},
				content: { type: "string" },
				scope: { type: "string", enum: ["global", "project"] },
				applyChanges: { type: "boolean" },
			},
			required: ["kind", "content"],
		},
		call: (args) => sdk.brainWrite(args),
	},
	{
		name: "lesson_capture",
		description: "Append a raw lesson capture to both the project and global inboxes.",
		inputSchema: {
			type: "object",
			properties: {
				topic: { type: "string" },
				body: { type: "string" },
			},
			required: ["topic"],
		},
		call: (args) => sdk.lessonCapture(args),
	},
	{
		name: "target_enable",
		description: "Enable a target: write the pointer stub and update config via atomic CAS.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				scope: { type: "string", enum: ["global", "project"] },
			},
			required: ["id"],
		},
		call: (args) => sdk.targetEnable(args),
	},
	{
		name: "target_disable",
		description: "Disable a target: remove the pointer stub and update config via atomic CAS.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				scope: { type: "string", enum: ["global", "project"] },
			},
			required: ["id"],
		},
		call: (args) => sdk.targetDisable(args),
	},
	{
		name: "link",
		description: "Write a pointer stub for a target (backup-first, force opt-in for native content).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				scope: { type: "string", enum: ["global", "project"] },
				force: { type: "boolean" },
				applyChanges: { type: "boolean" },
			},
			required: ["id"],
		},
		call: (args) => sdk.link(args),
	},
	{
		name: "unlink",
		description: "Remove a pointer stub for a target (pointer-only; refuses native content).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				scope: { type: "string", enum: ["global", "project"] },
				preserve: { type: "boolean" },
			},
			required: ["id"],
		},
		call: (args) => sdk.unlink(args),
	},
	{
		name: "memory_upgrade_prepare",
		description: "Atomic backup of a target file ahead of a memory-schema upgrade.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				scope: { type: "string", enum: ["global", "project"] },
			},
			required: ["id"],
		},
		call: (args) => sdk.memoryUpgradePrepare(args),
	},
	{
		name: "memory_upgrade_apply",
		description: "Bump the schema version marker (destructive; opt-in via applyChanges:true).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				scope: { type: "string", enum: ["global", "project"] },
				applyChanges: { type: "boolean" },
			},
			required: ["id"],
		},
		call: (args) => sdk.memoryUpgradeApply(args),
	},
	{
		name: "snapshot_now",
		description: "Take a snapshot of installed skills and brain files.",
		inputSchema: {
			type: "object",
			properties: {
				applyChanges: { type: "boolean" },
			},
		},
		call: (args) => sdk.snapshotNowWrite(args),
	},
	{
		name: "lesson_consolidate",
		description: "Promote recurring lessons to core and prune unrepeated ones (dry run by default).",
		inputSchema: {
			type: "object",
			properties: {
				scope: { type: "string", enum: ["global", "project"] },
				applyChanges: { type: "boolean" },
				promoteThreshold: { type: "number" },
			},
		},
		call: (args) => sdk.lessonConsolidate(args),
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
		"Current session metadata (startedAt, repo, branch, task, lessonsCaptured; cwd is redacted for least disclosure) or an empty { exists:false, session:null } payload when no session is active. Subscribable.",
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

// --- Phase 6 prompt wiring (T6.3.2) -----------------------------------------
//
// PROMPT_DESCRIPTORS is the registry's single source of truth (T6.0.1) — it
// already names each prompt, links it to its canonical CLI command via the
// internal `uri` field, and carries the human description. The MCP wire shape
// wants `{ name, description, arguments }`; the `uri` field is internal to the
// registry (CLI-command pointer, not an MCP wire detail) and is intentionally
// dropped from the wire shape.

const PROMPT_ARGUMENTS = Object.freeze({
	"session-start": [{ name: "for", description: "task-aware retrieval", required: false }],
	"instructions":  [],
	"brief-plan":    [{ name: "for", description: "task-aware retrieval", required: false }],
});

function listPrompts() {
	return PROMPT_DESCRIPTORS.map((d) => {
		const arguments_ = PROMPT_ARGUMENTS[d.name] || [];
		return { name: d.name, description: d.description, arguments: arguments_ };
	});
}

// --- PRODUCERS_PROMPTS (prompt name → MCP messages array) -------------------
//
// Each producer returns the MCP messages shape:
//   { description, messages: [{ role: "user", content: { type: "text",
//     text: ... } }] }
// session-start and instructions return the SDK producer's Markdown string
// verbatim; brief-plan returns a JSON-stringified structured payload so MCP
// hosts can JSON.parse it client-side. The SDK already does `if (task)`
// semantics, so an undefined `args.for` means "no task filter".

const PRODUCERS_PROMPTS = {
	"session-start": async (args) => ({
		description: "Dynamic session-start prompt tailored to your installed tools and pending actions.",
		messages: [{
			role: "user",
			content: { type: "text", text: await sdk.sessionStartPrompt({ for: args.for }) },
		}],
	}),
	"instructions": async () => ({
		description: "Canonical agent-cli instructions for AI agents.",
		messages: [{
			role: "user",
			content: { type: "text", text: await sdk.instructionsPrompt() },
		}],
	}),
	"brief-plan": async (args) => {
		const plan = await sdk.briefPlanPrompt({ for: args.for });
		return {
			description: "Planning-mode brief (equivalent of `agent-cli --json brief --plan`).",
			messages: [{
				role: "user",
				content: { type: "text", text: JSON.stringify(plan, null, 2) },
			}],
		};
	},
};

// --- A15 least-disclosure helper ---------------------------------------------
//
// Resource text + error payloads must not contain absolute paths, backup
// contents, stacks, or raw fs errors. Several SDK producers return path-bearing
// fields under keys the CLI uses but that MCP must redact:
//   - skillManifest `.path`, lessonsCore `.path`   (already stripped)
//   - sessionCurrent `.cwd`                        (F1: absolute working dir)
//   - inboxLessons `.file`                         (F2: absolute inbox file)
// We deep-walk the value, dropping ANY key whose name is a path-bearing key
// (`path`, `file`, `cwd`, `root`, `dir`, `location`, `absolute`), so the MCP
// layer cannot leak an absolute path through any producer — even one added
// later that happens to use one of these key names. The `"path"`-key behavior
// from before is a subset of this set, so nothing that was stripped regresses.

const PATH_KEYS = new Set(["path", "file", "cwd", "root", "dir", "location", "absolute"]);

function redactPaths(value, seen) {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return value;
	seen.add(value);
	if (Array.isArray(value)) return value.map((v) => redactPaths(v, seen));
	const out = {};
	for (const k of Object.keys(value)) {
		if (PATH_KEYS.has(k)) continue;
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
	serverInitialized = false;
	writeCapabilityOffered = false;
}

// --- handleMessage -----------------------------------------------------------
// Handle a single JSON-RPC message. Returns the response object for in-process
// testing, or null when the message produces no response (notifications).
// Writing to stdout happens in serve() via the returned object.

export async function handleMessage(msg) {
	if (!msg || typeof msg !== "object") return null;
	const { id, method, params } = msg;

	if (method === "initialize") {
		// A16 per-session capability binding. The write capability is offered
		// ONLY when the host sends the exact boolean true — truthy strings fail
		// closed (MASTER-PLAN §1 decision 4).
		serverInitialized = true;
		writeCapabilityOffered =
			params?.capabilities?.experimental?.agentCli?.writeTools === true;
		const capabilities = { ...READ_CAPABILITIES };
		if (writeCapabilityOffered) Object.assign(capabilities, WRITE_CAPABILITY);
		return {
			id,
			result: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities,
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
			},
		};
	}
	if (method === "notifications/initialized" || method === "notifications/cancelled") {
		return null;
	}
	if (method === "ping") return { id, result: {} };

	if (method === "tools/list") {
		const tools = TOOLS.map(({ call, ...t }) => t);
		// Write tools are listed ONLY when the host offered the write capability
		// during `initialize` (A16 — per-session binding).
		if (writeCapabilityOffered) {
			tools.push(...WRITE_TOOLS_TOOL_DEFS.map(({ call, ...t }) => t));
		}
		return { id, result: { tools } };
	}
	if (method === "tools/call") {
		const toolName = params && params.name;
		const tool = TOOLS.find((t) => t.name === toolName);
		if (!tool) {
			// Write tools are NOT in TOOLS — they're gated separately (T6.2.5).
			if (WRITE_TOOLS.has(toolName)) {
				// A19: refuse write traffic before `initialize` — no fs change, no crash.
				if (!serverInitialized) {
					return {
						id,
						error: {
							code: -32603,
							message: "write tool not available: " + toolName,
							data: { reason: "init_required" },
						},
					};
				}
				// A16: the host must have offered the write capability.
				if (!writeCapabilityOffered) {
					return {
						id,
						error: {
							code: -32603,
							message: "write tool not available: " + toolName,
							data: { reason: "write_capability_required" },
						},
					};
				}
				const writeTool = WRITE_TOOLS_TOOL_DEFS.find((t) => t.name === toolName);
				try {
					const result = await writeTool.call((params && params.arguments) || {});
					return {
						id,
						result: {
							content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
							isError: !result.ok,
						},
					};
				} catch (e) {
					// A15 least-disclosure: no stack, no raw fs errors — a stable
					// structured INTERNAL refusal.
					return {
						id,
						result: {
							content: [{
								type: "text",
								text: JSON.stringify({
									ok: false,
									command: toolName,
									error: "internal error",
									code: "INTERNAL",
								}, null, 2),
							}],
							isError: true,
						},
					};
				}
			}
			return { id, error: { code: -32602, message: "unknown tool: " + toolName } };
		}
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
			// A17 trust boundary, read side. Per the MCP spec resources/read params
			// carry only `uri`, but the raw host params object used to be forwarded
			// into the producers — and several of them (brainFile, lessonsCore,
			// inboxList) honor `scope` and `cwd`, so a host could read `.agents`
			// brain/lesson files from an arbitrary directory, escaping the
			// global-only contract those producers document. The write path already
			// pins LAUNCH_CWD and drops caller `cwd` (api/write.js, T6.2.7 F1); the
			// other two produce() call sites already pass {}. Read side now matches:
			// producers get no caller-controlled scope or cwd.
			raw = await produce(uri, {});
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
			// F3: a producer MATCHED but returned null — the only concrete
			// producer that can is `brain://session/current` when no session is
			// active (sessionCurrent()/readSession() returns null). That is a
			// VALID resource whose value is empty, not a "no producer" condition,
			// so the old "invalid skill URI" error was a mislabeled branch. Return
			// a structured payload so a host can distinguish "empty" from "broken".
			const clean = redactPaths(
				{ uri, exists: false, session: null },
				new WeakSet(),
			);
			return {
				id,
				result: {
					contents: [
						{ uri, mimeType: "application/json", text: JSON.stringify(clean, null, 2) },
					],
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

	// --- prompts/list -----------------------------------------------------
	if (method === "prompts/list") {
		return { id, result: { prompts: listPrompts() } };
	}

	// --- prompts/get ------------------------------------------------------
	if (method === "prompts/get") {
		const name = params && params.name;
		const args = (params && params.arguments) || {};
		const producer = PRODUCERS_PROMPTS[name];
		if (!producer) {
			return {
				id,
				error: { code: -32602, message: "unknown prompt: " + name },
			};
		}
		// Validate required arguments against the metadata advertised in
		// PROMPT_ARGUMENTS. None of the v0.8.0 prompts have a required arg,
		// but the check is here so future prompts can mark `required: true`
		// and the error surface stays consistent.
		const requiredArgs = PROMPT_ARGUMENTS[name] || [];
		for (const arg of requiredArgs) {
			if (arg.required && (args[arg.name] === undefined || args[arg.name] === null || args[arg.name] === "")) {
				return {
					id,
					error: { code: -32602, message: "missing required argument: " + arg.name },
				};
			}
		}
		try {
			const result = await producer(args);
			return { id, result };
		} catch (e) {
			return {
				id,
				error: { code: -32602, message: "prompt producer failed: " + ((e && e.message) || name) },
			};
		}
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