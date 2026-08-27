// src/mcp/discover.js — find the MCP servers already configured on this machine.
//
// The premise of `agent-cli mcp` is that a user has ALREADY wired MCP servers
// into Claude Code, pi, or a project's .mcp.json, and should not have to
// redeclare them a fourth time. This module reads those files and normalizes
// every entry into one shape, so the rest of the MCP code never has to know
// which harness a server came from.
//
// Reading only. Nothing here spawns, connects, or adopts — discovery must be
// safe to run against a config you have not vetted, because seeing what is in
// it is exactly how you vet it.

import path from "node:path";
import crypto from "node:crypto";
import { HOME, readFileNoFollow } from "../util.js";
import { ERROR_KIND } from "./protocol.js";
import { McpError } from "./client.js";

/** A harness config is JSON, not a database — anything larger is not one. */
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

/**
 * Server names reach the filesystem (cache keys) and the shell-free spawn path,
 * and are typed by a user as a CLI argument. Anything outside this set is
 * refused rather than escaped, because there is no legitimate server named
 * `../../etc`.
 */
export const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Package runners resolve to whatever the registry serves at the moment of
 * execution. That is not a reason to refuse — it is how most MCP servers ship —
 * but it IS worth showing at adopt time, because the code being trusted today
 * is not necessarily the code that runs tomorrow.
 */
const UNPINNED_RUNNERS = new Set(["npx", "npx.cmd", "uvx", "uvx.exe", "bunx", "pnpx", "dlx"]);

/** Where each harness keeps its MCP config. HOME-relative on purpose: the
 *  AGENT_CLI_HOME override is what makes these paths testable without ever
 *  touching a real user's configuration. */
export function configPaths(cwd = process.cwd()) {
	return {
		claude: path.join(HOME, ".claude.json"),
		pi: path.join(HOME, ".pi", "agent", "mcp.json"),
		project: path.join(cwd, ".mcp.json"),
	};
}

function readJson(file) {
	try {
		const raw = readFileNoFollow(file, { maxBytes: MAX_CONFIG_BYTES });
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		// Missing, refused (symlink), oversized or corrupt all mean the same
		// thing to a caller: this source contributed nothing.
		return null;
	}
}

/**
 * Normalize one raw config entry into agent-cli's server definition.
 *
 * Returns `null` for an entry we cannot make sense of rather than throwing —
 * one malformed server in a config with twelve of them must not take out
 * discovery for the other eleven.
 */
export function normalizeDef(name, raw, { source, scope = "user", origin }) {
	if (!raw || typeof raw !== "object") return null;
	if (!NAME_RE.test(String(name))) return null;

	const def = { name: String(name), source, scope, origin };

	if (typeof raw.url === "string" && raw.url) {
		def.transport = "http";
		def.url = raw.url;
		def.headers = plainStringMap(raw.headers);
	} else if (typeof raw.command === "string" && raw.command) {
		def.transport = "stdio";
		def.command = raw.command;
		def.args = Array.isArray(raw.args) ? raw.args.map(String) : [];
		def.env = plainStringMap(raw.env);
		if (typeof raw.cwd === "string" && raw.cwd) def.cwd = raw.cwd;
		def.unpinned = UNPINNED_RUNNERS.has(path.basename(def.command).toLowerCase());
	} else {
		return null;
	}

	def.fingerprint = fingerprint(def);
	return def;
}

/** Only string-valued own properties survive, so a nested object or a
 *  prototype-polluting key cannot reach the spawn or the header set. */
function plainStringMap(value) {
	const out = {};
	if (!value || typeof value !== "object") return out;
	for (const [k, v] of Object.entries(value)) {
		if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
			out[k] = String(v);
	}
	return out;
}

/**
 * Stable hash of everything that determines what will actually execute.
 *
 * This is the trust-on-first-use anchor: `mcp enable` records the fingerprint,
 * and a later run that finds a different one refuses instead of silently
 * running the new definition. Secret VALUES are inside the hash on purpose — a
 * rotated credential going to a server you approved is fine, but a changed
 * credential is still a change to what the invocation does, and the hash is
 * one-way so nothing about the value is recoverable from it.
 */
export function fingerprint(def) {
	const material = JSON.stringify([
		def.transport,
		def.command ?? null,
		def.args ?? [],
		def.url ?? null,
		sortedEntries(def.env),
		sortedEntries(def.headers),
		def.cwd ?? null,
	]);
	return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function sortedEntries(obj) {
	return Object.entries(obj || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// --- per-source readers -----------------------------------------------------

/**
 * Claude Code: `~/.claude.json`.
 *
 * Global `mcpServers` are user-scoped. Per-project entries live under
 * `projects[<abs path>]` and are honored ONLY when that project's
 * `hasTrustDialogAccepted` is true — the user was shown a trust prompt for that
 * directory and declined or never answered it, and agent-cli inheriting the
 * server anyway would route around a decision the user already made.
 */
export function fromClaude(file, { cwd = process.cwd() } = {}) {
	const cfg = readJson(file);
	if (!cfg) return [];
	const out = [];

	for (const [name, raw] of Object.entries(cfg.mcpServers || {})) {
		const def = normalizeDef(name, raw, {
			source: "claude",
			scope: "user",
			origin: file,
		});
		if (def) out.push(def);
	}

	const project = (cfg.projects || {})[cwd] || (cfg.projects || {})[path.resolve(cwd)];
	if (project && Object.keys(project.mcpServers || {}).length) {
		if (project.hasTrustDialogAccepted !== true) {
			out.push({
				name: null,
				source: "claude",
				scope: "project",
				origin: file,
				skipped: "project has not been trusted in Claude Code",
				count: Object.keys(project.mcpServers).length,
			});
		} else {
			const disabled = new Set([
				...(project.disabledMcpServers || []),
				...(project.disabledMcpjsonServers || []),
			]);
			for (const [name, raw] of Object.entries(project.mcpServers)) {
				if (disabled.has(name)) continue;
				const def = normalizeDef(name, raw, {
					source: "claude",
					scope: "project",
					origin: file,
				});
				if (def) out.push(def);
			}
		}
	}
	return out;
}

/** pi: `~/.pi/agent/mcp.json`, a plain `{ mcpServers: {...} }`. */
export function fromPi(file) {
	const cfg = readJson(file);
	if (!cfg) return [];
	const out = [];
	for (const [name, raw] of Object.entries(cfg.mcpServers || {})) {
		const def = normalizeDef(name, raw, {
			source: "pi",
			scope: "user",
			origin: file,
		});
		if (def) out.push(def);
	}
	return out;
}

/** A project's own `.mcp.json`, the format every harness reads. */
export function fromProjectFile(file) {
	const cfg = readJson(file);
	if (!cfg) return [];
	const out = [];
	for (const [name, raw] of Object.entries(cfg.mcpServers || {})) {
		const def = normalizeDef(name, raw, {
			source: "project",
			scope: "project",
			origin: file,
		});
		if (def) out.push(def);
	}
	return out;
}

/**
 * Every server visible from here, plus notes about what was skipped and why.
 *
 * Duplicates across sources are kept, not merged: the same name in Claude and
 * in pi may be two different definitions, and collapsing them would mean
 * adopting one while displaying the other. Callers disambiguate with
 * `<source>:<name>`.
 */
export function discoverAll({ cwd = process.cwd(), paths } = {}) {
	const p = paths || configPaths(cwd);
	const raw = [
		...fromClaude(p.claude, { cwd }),
		...fromPi(p.pi),
		...fromProjectFile(p.project),
	];
	const servers = raw.filter((d) => d.name);
	const skipped = raw.filter((d) => !d.name);
	return { servers, skipped, paths: p };
}

/**
 * Resolve a user-typed reference to exactly one server.
 *
 * An ambiguous bare name is an ERROR, never a guess. Picking a winner silently
 * would mean the command the user reads and the server that runs can differ,
 * which is precisely the failure mode this whole module exists to avoid.
 */
export function resolveRef(ref, servers) {
	const text = String(ref || "");
	const colon = text.indexOf(":");
	const source = colon === -1 ? null : text.slice(0, colon);
	const name = colon === -1 ? text : text.slice(colon + 1);

	const matches = servers.filter(
		(s) => s.name === name && (!source || s.source === source),
	);
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) {
		throw new McpError(
			ERROR_KIND.RESOLUTION,
			`no MCP server named ${text} — run \`agent-cli mcp servers\` to see what is configured`,
		);
	}
	throw new McpError(
		ERROR_KIND.RESOLUTION,
		`${name} is ambiguous — it is defined in ${matches.map((m) => m.source).join(" and ")}. Qualify it as ${matches.map((m) => `${m.source}:${name}`).join(" or ")}`,
	);
}
