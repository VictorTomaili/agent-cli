// src/hooks.js — render + install/uninstall/status for native SessionStart hooks
// that call `agent brief --oneline` at the start of an agent session.
//
// Each supported agent reads a different file (settings.json, hooks.json,
// config.toml, opencode.json, config.yaml) with a different JSON shape.
// renderHookConfig() returns the snippet for one target; installHook/uninstallHook
// do the disk-touching merge under that target's config file.
//
// Marker convention: every generated entry carries the literal token
// "agent-cli-session-brief" so re-install / uninstall / status can recognize
// our own writes without touching the user's other hooks.

import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	HOME,
	exists,
	readIfExists,
	writeFile,
	ensureDir,
	pretty,
	normalizeEndings,
} from "./util.js";
import { targetsWithHooks, getTarget } from "./targets.js";

/** The literal token embedded in every agent-cli generated hook command. */
export const HOOK_MARKER = "agent-cli-session-brief";

/**
 * Detect the invocation for the running `agent` binary, with a robust
 * fallback for environments where `agent` is not on PATH.
 *
 * On Windows: prefer `where agent`; fall back to `<node.exe> <cli.js>`.
 * On POSIX:   prefer `which agent`; fall back to `<node> <cli.js>`.
 *
 * Returns `{ bin, extraArgs }`: `bin` is the executable to invoke, `extraArgs`
 * are argv entries that must precede the `brief` subcommand (e.g. the cli.js
 * script path when falling back to `node <cli.js>`). `bin` and each entry of
 * `extraArgs` are independent path tokens that may themselves contain spaces
 * (e.g. `C:\Program Files\nodejs\node.exe`) — callers must quote each one
 * individually rather than concatenating them into a single quoted blob.
 *
 * The fallback is always non-empty — the hook must work even on a dev
 * install before `npm link`.
 */
export function detectAgentBin() {
	try {
		const cmd = process.platform === "win32" ? "where" : "which";
		const out = execFileSync(cmd, ["agent"], { encoding: "utf8" });
		const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		if (lines.length > 0) {
			const bin = process.platform === "win32" ? pickWindowsAgentBin(lines) : lines[0];
			return { bin, extraArgs: [] };
		}
	} catch {
		/* not on PATH — fall through */
	}
	const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
	return { bin: process.execPath, extraArgs: [cliPath] };
}

/**
 * From a list of `where agent` match lines, prefer a recognized Windows
 * executable extension (.exe/.cmd/.bat) over an extensionless match.
 *
 * npm installs both an extensionless POSIX shim (for Git Bash) and a
 * .cmd/.ps1 wrapper (for cmd.exe/PowerShell) for the same binary name;
 * `where` can list the extensionless shim first, but native Windows shells
 * cannot execute it directly (it's a `#!/bin/sh` script, not a Windows
 * executable) — falls back to the first line if nothing matches.
 */
export function pickWindowsAgentBin(lines) {
	return lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) || lines[0];
}

/** Normalize an `agentBin` option (plain path string, or a detectAgentBin() result) to `{ bin, extraArgs }`. */
function normalizeAgentBin(agentBin) {
	if (typeof agentBin === "string") return { bin: agentBin, extraArgs: [] };
	return agentBin;
}

/**
 * Build a shell command string that invokes `bin` (plus any `extraArgs` path
 * tokens) followed by `brief <briefArgs>`. Each path token is quoted
 * individually — wrapping the whole invocation (binary + args) in a single
 * quote pair turns it into one unparseable token, which is the historical
 * bug this guards against.
 */
function quoteCommand(bin, extraArgs, briefArgs) {
	const tokens = [bin, ...extraArgs].map((t) => `"${t}"`);
	return `${tokens.join(" ")} brief ${briefArgs}`;
}

/**
 * Build the native hook config snippet for one target that calls
 * `agent brief --oneline` at session start.
 *
 * Returns: { event, json, configFile, scope, hookCount }
 *   - event      the native event name (SessionStart / sessionStart / session_start / pre_user_prompt)
 *   - json       the full JSON object to write/merge into the target's config file
 *   - configFile home-relative path the snippet lives at
 *   - scope      "global" for v1 (project-scope hooks are out of scope for this plan)
 *   - hookCount  number of hook entries added (1 for all targets)
 */
export function renderHookConfig(target, { agentBin, briefArgs = "--oneline" } = {}) {
	if (!target.hooks) {
		throw new Error(`target ${target.id} has no hooks config`);
	}
	const { bin, extraArgs } = normalizeAgentBin(agentBin);
	const cmd = quoteCommand(bin, extraArgs, briefArgs);
	const id = target.id;
	const event = target.hooks.event;
	const configFile = target.hooks.configFile;

	if (id === "opencode") {
		// opencode.json: top-level array of {event, command:[...]} objects.
		// Array form is exec'd directly (no shell), so argv entries are raw
		// path strings — no quoting needed, unlike the shell-string targets below.
		// Include a `name` field with our marker so parseAgentCliHookEntry can
		// identify our entry even though opencode's schema doesn't require it.
		return {
			event,
			json: {
				hooks: [
					{ name: HOOK_MARKER, event, command: [bin, ...extraArgs, "brief", briefArgs] },
				],
			},
			configFile,
			scope: "global",
			hookCount: 1,
		};
	}
	if (id === "cursor") {
		// cursor hooks.json: { version: 1, hooks: { sessionStart: [{ command, type }] } }
		return {
			event,
			json: {
				version: 1,
				hooks: {
					[event]: [
						{
							type: "command",
							name: HOOK_MARKER,
							command: cmd,
						},
					],
				},
			},
			configFile,
			scope: "global",
			hookCount: 1,
		};
	}
	if (id === "copilot") {
		// copilot ~/.copilot/hooks/hooks.json — same camelCase sessionStart shape,
		// with both command and powershell keys for Windows.
		const ps = process.platform === "win32"
			? quoteCommand(`${bin}.cmd`, extraArgs, briefArgs)
			: cmd;
		return {
			event,
			json: {
				version: 1,
				hooks: {
					[event]: [
						{ type: "command", name: HOOK_MARKER, command: cmd, powershell: ps },
					],
				},
			},
			configFile,
			scope: "global",
			hookCount: 1,
		};
	}
	if (id === "windsurf") {
		// windsurf: pre_user_prompt — flat command object with show_output false.
		// Embed the marker in the command as a no-op shell comment so re-install/uninstall
		// can recognize our writes.
		return {
			event,
			json: {
				hooks: {
					[event]: [
						{ command: `${cmd} # ${HOOK_MARKER}`, show_output: false },
					],
				},
			},
			configFile,
			scope: "global",
			hookCount: 1,
		};
	}
	if (id === "goose") {
		// goose config.yaml — handled by installHook (YAML). renderHookConfig
		// returns a sentinel; installHook ignores `json` for goose.
		return {
			event,
			json: null,
			configFile,
			scope: "global",
			hookCount: 1,
		};
	}
	// Default Claude-Code shape (claude, codex, gemini, cline, junie, trae, pi):
	// The `name` field is our primary marker, but Claude Code's own CLI
	// (plugin install/uninstall, and likely other settings.json rewrites)
	// re-serializes through its typed schema and silently drops unrecognized
	// fields like `name` — confirmed reproducible. For the `claude` target
	// specifically (the only one whose config file Claude Code's own tooling
	// rewrites), also embed the marker as a trailing shell comment, the same
	// technique windsurf already uses above — safe here too, since Claude
	// Code hook commands run via bash or PowerShell, both of which treat `#`
	// as a comment. This keeps re-install/status/uninstall working even after
	// Claude Code strips the `name` field.
	const claudeCmd = id === "claude" ? `${cmd} # ${HOOK_MARKER}` : cmd;
	return {
		event,
		json: {
			hooks: {
				[event]: [
					{
						hooks: [
							{ type: "command", name: HOOK_MARKER, command: claudeCmd },
						],
					},
				],
			},
		},
		configFile,
		scope: "global",
		hookCount: 1,
	};
}

/** Return true if an entry was written by agent-cli. */
export function parseAgentCliHookEntry(entry) {
	if (!entry || typeof entry !== "object") return false;
	if (entry.name === HOOK_MARKER) return true;
	const cmd = entry.command;
	if (Array.isArray(cmd)) {
		// opencode: command is an array — check for our marker token anywhere in it.
		return cmd.some((c) => typeof c === "string" && c.includes(HOOK_MARKER));
	}
	if (typeof cmd === "string") {
		return cmd.includes(HOOK_MARKER);
	}
	return false;
}
/** Read the existing config file (if any), parsed as JSON; null on missing/empty; throw on unparseable. */
async function readJsonConfig(absPath) {
	const existing = await readIfExists(absPath);
	if (existing == null) return null;
	const trimmed = existing.trim();
	if (!trimmed) return null;
	return JSON.parse(trimmed);
}

/** Resolve the absolute path for a target's hook config file. */
function hookConfigAbs(target) {
	return path.join(HOME, target.hooks.configFile);
}

/**
 * Install the SessionStart hook for one target.
 *
 * Behavior:
 *   - Goose target → YAML merge (config.yaml) instead of JSON.
 */
export async function installHook(target, { force = false, agentBin } = {}) {
	if (!target.hooks) return { target: target.id, skipped: "unsupported" };
	const abs = hookConfigAbs(target);

	if (target.id === "goose") {
		// goose config.yaml: append a single entry under the `hooks:` array. The
		// `yaml` package is already a dep.
		const { default: YAML } = await import("yaml");
		const { bin, extraArgs } = normalizeAgentBin(agentBin || detectAgentBin());
		await ensureDir(path.dirname(abs));
		const existing = await readIfExists(abs);
		const doc = existing ? YAML.parse(existing) || {} : {};
		const existingHooks = Array.isArray(doc.hooks) ? doc.hooks : [];
		const has = existingHooks.some(
			(h) =>
				h &&
				((typeof h.command === "string" && h.command.includes(HOOK_MARKER)) ||
					h.name === HOOK_MARKER),
		);
		if (has && !force) {
			return { target: target.id, path: abs, skipped: "already-installed" };
		}
		if (!has && existingHooks.length > 0 && !force) {
			return { target: target.id, path: abs, blocked: "native-content", hint: "agent hooks install --force" };
		}
		const cmd = quoteCommand(bin, extraArgs, "--oneline");
		const next = [
			...existingHooks.filter(
				(h) =>
					!h ||
					!(
						(typeof (h.command || "") === "string" && h.command.includes(HOOK_MARKER)) ||
						h.name === HOOK_MARKER
					),
			),
			{
				name: HOOK_MARKER,
				events: [target.hooks.event],
				command: cmd,
			},
		];
		doc.hooks = next;
		await writeFile(abs, YAML.stringify(doc));
		return { target: target.id, path: abs, installed: true };
	}

	// JSON path (every other hook-capable target).
	const bin = agentBin || detectAgentBin();
	const snippet = renderHookConfig(target, { agentBin: bin });
	await ensureDir(path.dirname(abs));

	let doc = null;
	try {
		doc = await readJsonConfig(abs);
	} catch (error) {
		return {
			target: target.id,
			path: abs,
			blocked: "unparseable",
			hint: "agent hooks install --force",
			detail: error.message,
		};
	}

	const ours = findOurEntry(doc, target);
	if (ours && !force) {
		return { target: target.id, path: abs, skipped: "already-installed" };
	}
	if (!ours && doc != null && hasAnyEntries(doc, target) && !force) {
		return {
			target: target.id,
			path: abs,
			blocked: "native-content",
			hint: "agent hooks install --force",
		};
	}

	const merged = mergeEntry(doc, snippet, target);
	await writeFile(abs, JSON.stringify(merged, null, 2) + "\n");
	return { target: target.id, path: abs, installed: true };
}

/** Remove agent-cli hook entries from the target's config file; delete the file if empty. */
export async function uninstallHook(target) {
	if (!target.hooks) return { target: target.id, skipped: "unsupported" };
	const abs = hookConfigAbs(target);
	if (!(await exists(abs))) {
		return { target: target.id, path: abs, missing: true };
	}

	if (target.id === "goose") {
		const { default: YAML } = await import("yaml");
		const existing = await readIfExists(abs);
		const doc = existing ? YAML.parse(existing) || {} : {};
		const before = Array.isArray(doc.hooks) ? doc.hooks.length : 0;
		doc.hooks = (doc.hooks || []).filter(
			(h) =>
				!h ||
				!(
					(typeof h.command === "string" && h.command.includes(HOOK_MARKER)) ||
					h.name === HOOK_MARKER
				),
		);
		const after = doc.hooks.length;
		if (after === 0) {
			const { rm } = await import("node:fs/promises");
			await rm(abs, { force: true });
			return { target: target.id, path: abs, unlinked: true, removed: before };
		}
		await writeFile(abs, YAML.stringify(doc));
		return { target: target.id, path: abs, unlinked: true, removed: before - after };
	}

	let doc;
	try {
		doc = await readJsonConfig(abs);
	} catch {
		return { target: target.id, path: abs, blocked: "unparseable" };
	}
	if (doc == null) {
		return { target: target.id, path: abs, missing: true };
	}
	const next = stripOurEntry(doc, target);
	if (JSON.stringify(next) === JSON.stringify(doc)) {
		// Nothing to remove; user has no agent-cli entry.
		return { target: target.id, path: abs, missing: true };
	}
	const { rm } = await import("node:fs/promises");
	if (Object.keys(next).length === 0) {
		await rm(abs, { force: true });
		return { target: target.id, path: abs, unlinked: true };
	}
	await writeFile(abs, JSON.stringify(next, null, 2) + "\n");
	return { target: target.id, path: abs, unlinked: true };
}

/** Status of one target's hook. */
export async function statusHook(target) {
	if (!target.hooks) return { target: target.id, installed: false, state: "unsupported" };
	const abs = hookConfigAbs(target);
	const existsHere = await exists(abs);
	if (!existsHere) {
		return {
			target: target.id,
			id: target.id,
			name: target.name,
			installed: false,
			state: "absent",
			path: abs,
			prettyPath: pretty(abs),
		};
	}
if (target.id === "goose") {
		const { default: YAML } = await import("yaml");
		const existing = await readIfExists(abs);
		const doc = existing ? YAML.parse(existing) || {} : {};
		const ours = (doc.hooks || []).some(
			(h) =>
				h &&
				((typeof h.command === "string" && h.command.includes(HOOK_MARKER)) ||
					h.name === HOOK_MARKER),
		);
		return {
			target: target.id,
			id: target.id,
			name: target.name,
			installed: ours,
			state: ours ? "installed" : "stale",
			path: abs,
			prettyPath: pretty(abs),
		};
	}
	let doc;
	try {
		doc = await readJsonConfig(abs);
	} catch {
		return {
			target: target.id,
			id: target.id,
			name: target.name,
			installed: false,
			state: "unparseable",
			path: abs,
			prettyPath: pretty(abs),
		};
	}
	const ours = !!findOurEntry(doc, target);
	return {
		target: target.id,
		id: target.id,
		name: target.name,
		installed: ours,
		state: ours ? "installed" : hasAnyEntries(doc, target) ? "native-content" : "stale",
		path: abs,
		prettyPath: pretty(abs),
	};
}

/** Install hooks for every hook-capable target. Returns array of per-target results. */
export async function installAllHooks({ force = false, agentBin } = {}) {
	const bin = agentBin || detectAgentBin();
	const results = [];
	for (const t of targetsWithHooks()) {
		results.push(await installHook(t, { force, agentBin: bin }));
	}
	return results;
}

/** Uninstall hooks for every hook-capable target. */
export async function uninstallAllHooks({ agentBin } = {}) {
	const results = [];
	for (const t of targetsWithHooks()) {
		results.push(await uninstallHook(t));
	}
	return results;
}

/** Status for every hook-capable target. */
export async function statusAllHooks() {
	const results = [];
	for (const t of targetsWithHooks()) {
		results.push(await statusHook(t));
	}
	return results;
}

// --- per-shape helpers ------------------------------------------------------
// Every JSON-config agent has a slightly different "where do the hook entries
// live in the document" structure. These helpers centralize that.

function entryList(doc, target) {
	if (!doc || typeof doc !== "object") return null;
	if (target.id === "opencode") {
		// top-level array under `hooks`
		const arr = Array.isArray(doc.hooks) ? doc.hooks : [];
		return arr;
	}
	if (target.id === "cursor" || target.id === "copilot") {
		const eventMap = doc.hooks && typeof doc.hooks === "object" ? doc.hooks : {};
		return Array.isArray(eventMap[target.hooks.event]) ? eventMap[target.hooks.event] : [];
	}
	if (target.id === "windsurf") {
		const eventMap = doc.hooks && typeof doc.hooks === "object" ? doc.hooks : {};
		return Array.isArray(eventMap[target.hooks.event]) ? eventMap[target.hooks.event] : [];
	}
	// Default Claude shape: { hooks: { SessionStart: [{ hooks: [...] }] } }
	const eventMap = doc.hooks && typeof doc.hooks === "object" ? doc.hooks : {};
	const outer = Array.isArray(eventMap[target.hooks.event]) ? eventMap[target.hooks.event] : [];
	return outer.flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks : []));
}

function findOurEntry(doc, target) {
	const list = entryList(doc, target);
	if (!list) return null;
	return list.find((e) => parseAgentCliHookEntry(e)) || null;
}

function hasAnyEntries(doc, target) {
	const list = entryList(doc, target);
	return Array.isArray(list) && list.length > 0;
}

function mergeEntry(doc, snippet, target) {
	const base = doc && typeof doc === "object" ? { ...doc } : {};
	if (target.id === "opencode") {
		const arr = Array.isArray(base.hooks) ? [...base.hooks] : [];
		const filtered = arr.filter((e) => !parseAgentCliHookEntry(e));
		base.hooks = [...filtered, ...snippet.json.hooks];
		return base;
	}
	if (target.id === "cursor" || target.id === "copilot") {
		base.hooks = base.hooks && typeof base.hooks === "object" ? { ...base.hooks } : {};
		const eventArr = Array.isArray(base.hooks[snippet.event])
			? [...base.hooks[snippet.event]]
			: [];
		const filtered = eventArr.filter((e) => !parseAgentCliHookEntry(e));
		base.hooks[snippet.event] = [...filtered, ...snippet.json.hooks[snippet.event]];
		if (snippet.json.version != null && base.version == null) {
			base.version = snippet.json.version;
		}
		return base;
	}
	if (target.id === "windsurf") {
		base.hooks = base.hooks && typeof base.hooks === "object" ? { ...base.hooks } : {};
		const eventArr = Array.isArray(base.hooks[snippet.event])
			? [...base.hooks[snippet.event]]
			: [];
		const filtered = eventArr.filter((e) => !parseAgentCliHookEntry(e));
		base.hooks[snippet.event] = [...filtered, ...snippet.json.hooks[snippet.event]];
		return base;
	}
	// Default Claude shape.
	base.hooks = base.hooks && typeof base.hooks === "object" ? { ...base.hooks } : {};
	const outerArr = Array.isArray(base.hooks[snippet.event])
		? [...base.hooks[snippet.event]]
		: [];
	const filteredOuter = outerArr.filter(
		(g) => !(g && Array.isArray(g.hooks) && g.hooks.some((e) => parseAgentCliHookEntry(e))),
	);
	base.hooks[snippet.event] = [...filteredOuter, ...snippet.json.hooks[snippet.event]];
	return base;
}

function stripOurEntry(doc, target) {
	const base = doc && typeof doc === "object" ? { ...doc } : {};
	if (target.id === "opencode") {
		base.hooks = (Array.isArray(base.hooks) ? base.hooks : []).filter(
			(e) => !parseAgentCliHookEntry(e),
		);
		if (base.hooks.length === 0) return {};
		return base;
	}
	if (
		target.id === "cursor" ||
		target.id === "copilot" ||
		target.id === "windsurf"
	) {
		base.hooks = base.hooks && typeof base.hooks === "object" ? { ...base.hooks } : {};
		const arr = Array.isArray(base.hooks[target.hooks.event])
			? base.hooks[target.hooks.event]
			: [];
		base.hooks[target.hooks.event] = arr.filter((e) => !parseAgentCliHookEntry(e));
		if (Object.keys(base.hooks).length === 0) {
			delete base.hooks;
		}
		return base;
	}
	// Default Claude shape: strip only inner entries marked as ours.
	base.hooks = base.hooks && typeof base.hooks === "object" ? { ...base.hooks } : {};
	const outerArr = Array.isArray(base.hooks[target.hooks.event])
		? base.hooks[target.hooks.event]
		: [];
	const stripped = outerArr
		.map((g) => {
			if (!g || !Array.isArray(g.hooks)) return g;
			const inner = g.hooks.filter((e) => !parseAgentCliHookEntry(e));
			return { ...g, hooks: inner };
		})
		.filter((g) => g.hooks && g.hooks.length > 0);
	if (stripped.length === 0) {
		delete base.hooks[target.hooks.event];
	} else {
		base.hooks[target.hooks.event] = stripped;
	}
	if (Object.keys(base.hooks).length === 0) {
		delete base.hooks;
	}
	return base;
}


export { targetsWithHooks, getTarget };
