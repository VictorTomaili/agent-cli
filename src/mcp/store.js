// src/mcp/store.js — agent-cli's own record of which discovered servers it is
// allowed to run, plus a cache of the tools each one advertises.
//
// This store holds REFERENCES, never definitions. A server's command, URL, env
// and headers stay in the harness config that owns them; agent-cli records only
// "<source>:<name>, approved at this fingerprint". Copying the definition here
// would mean a second place to rotate a credential and a second file to leak.
//
// TRUST ON FIRST USE. Discovery is read-only and lists everything; nothing is
// executable until `agent-cli mcp enable <ref>` records it. This matters more
// for agent-cli than for a chat client: `agent-cli mcp call` is meant to be run
// BY agents, non-interactively, and a design where merely appearing in a config
// file makes a server runnable would let anything that can write to
// ~/.claude.json get arbitrary code executed by the next agent that runs a tool.
//
// `enable` doubles as the approval prompt a non-interactive CLI cannot show.
// src/cli.js is explicit that agent-cli never blocks on interactive input, so
// the consent step has to be a separate command a human types once.

import path from "node:path";
import { AGENTS_DIR, readFileNoFollow, writeFileSync } from "../util.js";

/** ~/.agents/mcp.json — the approval list. */
export const STORE_FILE = path.join(AGENTS_DIR, "mcp.json");
/** ~/.agents/mcp-cache.json — tool catalogs, so a call can resolve a bare tool
 *  name without connecting to every configured server first. */
export const CACHE_FILE = path.join(AGENTS_DIR, "mcp-cache.json");

const MAX_STORE_BYTES = 4 * 1024 * 1024;

/** Canonical key for a discovered server. Always source-qualified, so the same
 *  name in two harnesses cannot silently share one approval. */
export function refKey(def) {
	return `${def.source}:${def.name}`;
}

function readJsonFile(file, fallback) {
	try {
		const parsed = JSON.parse(readFileNoFollow(file, { maxBytes: MAX_STORE_BYTES }));
		return parsed && typeof parsed === "object" ? parsed : fallback;
	} catch {
		return fallback;
	}
}

export function readStore() {
	const store = readJsonFile(STORE_FILE, null);
	if (!store || typeof store.enabled !== "object" || !store.enabled)
		return { version: 1, enabled: {} };
	return { version: 1, enabled: store.enabled };
}

// 0600: the store is not secret, but it records which servers this machine will
// execute. Anything that can rewrite it can redirect an approval, so it gets the
// same permissions as the secrets store rather than the default umask.
function writeStore(store) {
	writeFileSync(STORE_FILE, JSON.stringify(store, null, "\t") + "\n", { mode: 0o600 });
}

/** Record approval of a server AT ITS CURRENT FINGERPRINT. */
export function enable(def, { at }) {
	const store = readStore();
	store.enabled[refKey(def)] = {
		fingerprint: def.fingerprint,
		transport: def.transport,
		enabledAt: at,
	};
	writeStore(store);
	return store;
}

/** Withdraw approval. Returns whether anything was actually removed, so the
 *  caller can tell "disabled it" from "it was never enabled". */
export function disable(ref) {
	const store = readStore();
	const existed = Object.prototype.hasOwnProperty.call(store.enabled, ref);
	delete store.enabled[ref];
	if (existed) writeStore(store);
	return existed;
}

/** Trust states. `changed` is deliberately NOT `enabled`: a definition that
 *  moved after approval is treated as unapproved until a human re-enables it,
 *  which is what makes the fingerprint worth recording at all. */
export const TRUST = {
	ENABLED: "enabled",
	DISABLED: "disabled",
	CHANGED: "changed",
};

/**
 * What agent-cli is currently willing to do with this server.
 *
 * A `changed` verdict carries both fingerprints so the message can say what
 * moved rather than just refusing.
 */
export function trustOf(def, store = readStore()) {
	const entry = store.enabled[refKey(def)];
	if (!entry) return { state: TRUST.DISABLED };
	if (entry.fingerprint !== def.fingerprint)
		return {
			state: TRUST.CHANGED,
			approved: entry.fingerprint,
			current: def.fingerprint,
			enabledAt: entry.enabledAt,
		};
	return { state: TRUST.ENABLED, enabledAt: entry.enabledAt };
}

// --- tool cache -------------------------------------------------------------

export function readCache() {
	const cache = readJsonFile(CACHE_FILE, null);
	if (!cache || typeof cache.servers !== "object" || !cache.servers)
		return { version: 1, servers: {} };
	return { version: 1, servers: cache.servers };
}

/**
 * Remember the tool names one server advertises.
 *
 * Names only — not descriptions or schemas. The cache exists to answer "which
 * server owns this tool", and a server's description text is third-party prose
 * that would then be replayed from disk into an agent's context long after the
 * connection that produced it.
 */
export function cacheTools(def, toolNames, { at }) {
	const cache = readCache();
	cache.servers[refKey(def)] = {
		fingerprint: def.fingerprint,
		at,
		tools: [...new Set(toolNames.map(String))].sort(),
	};
	writeFileSync(CACHE_FILE, JSON.stringify(cache, null, "\t") + "\n", { mode: 0o600 });
	return cache;
}

/**
 * Which enabled servers claim a tool by this name.
 *
 * Only servers whose cached fingerprint still matches are considered — a stale
 * entry from a definition that has since changed is not evidence about what the
 * current definition exposes.
 */
export function serversForTool(toolName, servers, cache = readCache()) {
	const hits = [];
	for (const def of servers) {
		const entry = cache.servers[refKey(def)];
		if (!entry || entry.fingerprint !== def.fingerprint) continue;
		if (entry.tools.includes(toolName)) hits.push(def);
	}
	return hits;
}

/** True when nothing has ever been cached — the difference between "that tool
 *  does not exist" and "run `mcp tools` first". */
export function cacheIsCold(cache = readCache()) {
	return Object.keys(cache.servers).length === 0;
}
