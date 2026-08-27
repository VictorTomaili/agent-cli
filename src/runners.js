// src/runners.js — external coding-agent runners: persisted config
// (`agent-cli configure run`) + task dispatch with a fallback chain (`agent-cli run`).
// Stored in config.json `runners`: { default: string|null, tools: {
//   <toolId>: { provider, model, thinking, fallbacks[] } } }.
// Follows the models.js persistence pattern (loadConfigSync → mutate →
// saveConfigSync) and never imports from src/commands/*.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadConfigSync, saveConfigSync, isConfigCorrupt } from "./config.js";

export const KNOWN_TOOLS = ["pi", "codex"];

const CORRUPT_MSG =
	"config.json is corrupt; repair or remove it before changing runners";

/** Load config through the central corruption-aware loader. Throws on corrupt. */
function readConfig() {
	const cfg = loadConfigSync();
	if (isConfigCorrupt(cfg)) throw new Error(CORRUPT_MSG);
	return cfg;
}

/**
 * Parse a fallback spec "tool:provider/model[:thinking]" into
 * { tool, provider, model, thinking }. Codex has no provider, so
 * "codex:<model>" parses with provider null; every other tool requires
 * one ("pi:<provider>/<model>:<thinking>"). Throws a descriptive Error on a malformed
 * spec or an unknown tool.
 */
export function parseFallback(spec) {
	const raw = String(spec ?? "").trim();
	const shape = "tool:provider/model[:thinking]";
	if (!raw) throw new Error(`Invalid fallback spec '' (expected ${shape})`);
	const colon = raw.indexOf(":");
	if (colon < 1)
		throw new Error(`Invalid fallback spec '${raw}' (expected ${shape})`);
	const tool = raw.slice(0, colon);
	if (!KNOWN_TOOLS.includes(tool))
		throw new Error(
			`Unknown tool '${tool}' in fallback spec '${raw}' (known tools: ${KNOWN_TOOLS.join(", ")})`,
		);
	let rest = raw.slice(colon + 1);
	if (!rest) throw new Error(`Invalid fallback spec '${raw}' (missing model)`);
	let provider = null;
	const slash = rest.indexOf("/");
	if (slash === 0)
		throw new Error(`Invalid fallback spec '${raw}' (empty provider)`);
	if (slash > 0) {
		provider = rest.slice(0, slash);
		rest = rest.slice(slash + 1);
	} else if (tool !== "codex") {
		throw new Error(
			`Fallback spec '${raw}' for '${tool}' needs a provider (${shape})`,
		);
	}
	let thinking = null;
	const tc = rest.indexOf(":");
	if (tc >= 0) {
		thinking = rest.slice(tc + 1);
		rest = rest.slice(0, tc);
	}
	if (!rest) throw new Error(`Invalid fallback spec '${raw}' (missing model)`);
	if (thinking === "") thinking = null; // trailing colon = no thinking level
	return { tool, provider, model: rest, thinking };
}

/** Empty (but well-shaped) runner config. */
function emptyRunners() {
	return { default: null, tools: {} };
}

/**
 * Persist a runner entry (models.js setAlias pattern: load → merge → save).
 * The first configured tool becomes the default automatically; `makeDefault`
 * forces it. Returns the saved entry. Throws on a corrupt config, an unknown
 * tool, a missing model on first configuration, or malformed fallback specs
 * (validated here so resolveChain can never see junk).
 */
export function setRunner(
	toolId,
	{ provider, model, thinking, fallbacks, makeDefault } = {},
) {
	if (!KNOWN_TOOLS.includes(toolId))
		throw new Error(
			`Unknown tool '${toolId}' (known tools: ${KNOWN_TOOLS.join(", ")})`,
		);
	const cfg = readConfig(); // throws on corrupt BEFORE any mutation
	cfg.runners = cfg.runners || emptyRunners();
	cfg.runners.tools = cfg.runners.tools || {};
	const wasEmpty = Object.keys(cfg.runners.tools).length === 0;
	const prev = cfg.runners.tools[toolId] || {};
	const entry = {
		...prev,
		...(provider === undefined ? {} : { provider: provider ?? null }),
		...(model == null ? {} : { model }),
		...(thinking === undefined ? {} : { thinking: thinking ?? null }),
		...(fallbacks == null
			? {}
			: { fallbacks: [...new Set(fallbacks.filter(Boolean))] }),
	};
	if (entry.model == null)
		throw new Error(
			`--model is required when configuring '${toolId}' for the first time (agent-cli configure run ${toolId} --model <id>)`,
		);
	for (const spec of entry.fallbacks || []) parseFallback(spec);
	cfg.runners.tools[toolId] = entry;
	if (makeDefault || wasEmpty) cfg.runners.default = toolId;
	saveConfigSync(cfg);
	return entry;
}

/** Read the persisted runner config. Permissive on a corrupt config (reads
 *  as empty, mirroring models.getAliases). */
export function getRunners() {
	let cfg;
	try {
		cfg = readConfig();
	} catch {
		return emptyRunners();
	}
	return cfg.runners ?? emptyRunners();
}

/**
 * Ordered dispatch chain: the chosen tool's own entry first, then its parsed
 * fallbacks. `toolOverride` picks a specific configured tool; otherwise the
 * configured default (or the only configured tool). Throws when nothing is
 * configured or the chosen tool has no entry.
 */
export function resolveChain({ toolOverride } = {}) {
	const runners = getRunners();
	const tools = runners.tools || {};
	const toolId = toolOverride || runners.default || Object.keys(tools)[0];
	if (!toolId)
		throw new Error(
			"No runners configured — run: agent-cli configure run <tool> --model <model>",
		);
	const entry = tools[toolId];
	if (!entry)
		throw new Error(
			`Runner '${toolId}' is not configured — run: agent-cli configure run ${toolId} --model <model>`,
		);
	const chain = [
		{
			tool: toolId,
			provider: entry.provider ?? null,
			model: entry.model,
			thinking: entry.thinking ?? null,
		},
	];
	for (const spec of entry.fallbacks || []) chain.push(parseFallback(spec));
	return chain;
}

/**
 * Build the spawn command line for one chain entry — an argv array only,
 * never a shell string. pi reads the task from a prompt FILE (the trailing
 * "@<path>" arg, written by runTask); codex takes the task as a trailing
 * argv token. `cwd` is applied by the spawn call itself (kept in the
 * signature for symmetry with runTask).
 */
export function buildArgv(entry, { task, promptFile, readOnly, cwd } = {}) {
	if (entry.tool === "codex") {
		return {
			cmd: process.env.AGENT_RUN_BIN_CODEX || "codex",
			args: [
				"exec",
				"-s",
				readOnly ? "read-only" : "workspace-write",
				"-m",
				entry.model,
				task,
			],
		};
	}
	if (entry.tool === "pi") {
		const args = [
			"-p",
			"--no-session",
			"--offline",
			"-na",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
		];
		if (entry.provider) args.push("--provider", entry.provider);
		args.push("--model", entry.model);
		if (entry.thinking) args.push("--thinking", entry.thinking);
		if (readOnly) args.push("--tools", "read,grep,find,ls");
		args.push(`@${promptFile}`);
		return { cmd: process.env.AGENT_RUN_BIN_PI || "pi", args };
	}
	throw new Error(`Unknown runner tool: ${entry.tool}`);
}

/**
 * Classify a failed attempt's combined output: "quota" (rate limits, usage
 * caps, exhausted credits — worth retrying on a fallback) vs "error".
 */
export function classifyFailure(text) {
	return /rate.?limit|quota|usage limit|too many requests|\b429\b|insufficient balance|exhausted/i.test(
		String(text ?? ""),
	)
		? "quota"
		: "error";
}

function lastChars(s, n) {
	return String(s ?? "").slice(-n);
}

/** Extensions that mark a spawn target as a Node script (run via execPath). */
const JS_FILE_RE = /\.(?:js|cjs|mjs)$/i;

/**
 * npm cmd-shim target: a quoted or bare "%~dp0\<rel>.js" / "%dp0%\<rel>.js"
 * token naming the shim's real JS entry (npm writes both spellings into the
 * .cmd shims it drops into node_modules/.bin and the global bin dir).
 */
const CMD_SHIM_TARGET_RE = /"?%~?dp0%?[\\/]([^"\r\n]+?\.(?:js|cjs|mjs))"?/i;

/** Cap on how much of a .cmd/.bat shim is read for pattern matching. */
const SHIM_READ_CAP = 64 * 1024;

/**
 * Resolve `cmd` to an existing file: values containing a path separator are
 * used as-is, bare names are searched on every process.env.PATH entry (win32
 * additionally probes ".cmd", ".exe", ".bat", "" in that order — npm shims
 * live there, and the extensionless probe goes LAST because npm also drops
 * a POSIX sh-script sibling that CreateProcess cannot run). Returns null
 * when nothing matches.
 */
function resolveCommandFile(cmd) {
	if (/[\\/]/.test(cmd)) return fs.existsSync(cmd) ? cmd : null;
	const dirs = String(process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean);
	const exts =
		process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
	for (const dir of dirs)
		for (const ext of exts) {
			const p = path.join(dir, cmd + ext);
			if (fs.existsSync(p)) return p;
		}
	return null;
}

/**
 * Make one buildArgv command spawnable with shell:false on Windows, where
 * npm-global CLIs ("pi", "codex") are .cmd shims that child_process cannot
 * execute directly (EINVAL/ENOENT since Node 18.20). Resolution rules:
 *  - cmd ends .js/.cjs/.mjs → run it with process.execPath (cross-platform);
 *  - resolved .cmd/.bat → parse the npm cmd-shim for its "%~dp0\<rel>.js"
 *    target and run THAT with process.execPath;
 *  - anything else (.exe, extensionless, non-win32) spawns directly.
 * Never routes through cmd.exe — task text must not pass through a shell
 * (cmdShimSpawnSync in util.js is for $EDITOR only; its metachar-free
 * constraint does not hold for task text). Throws a descriptive Error on a
 * missing command or an unsupported shim (fail closed; runTask records the
 * throw as a spawn-kind attempt and moves on to the next chain entry).
 */
export function resolveSpawn(cmd, args = []) {
	const argv = [...(args ?? [])];
	if (JS_FILE_RE.test(cmd))
		return { cmd: process.execPath, args: [cmd, ...argv] };
	const resolved = resolveCommandFile(cmd);
	if (!resolved) throw new Error(`command not found: ${cmd}`);
	const ext = path.extname(resolved).toLowerCase();
	if (process.platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
		const text = fs.readFileSync(resolved, "utf8").slice(0, SHIM_READ_CAP);
		const m = CMD_SHIM_TARGET_RE.exec(text);
		if (!m)
			throw new Error(`unsupported .cmd shim (not an npm cmd-shim): ${resolved}`);
		return {
			cmd: process.execPath,
			args: [path.join(path.dirname(resolved), m[1]), ...argv],
		};
	}
	return { cmd: resolved, args: argv };
}

/**
 * Dispatch a task through the fallback chain. Each entry is spawned with an
 * argv array (shell:false); the first status-0 result wins. Failed attempts
 * are recorded ({ tool, model, kind, detail }) on the result. `spawnImpl` is
 * injectable for tests (default: child_process.spawnSync).
 */
export function runTask({
	task,
	readOnly = false,
	toolOverride,
	timeoutMs = 600000,
	cwd,
	spawnImpl,
} = {}) {
	const spawn = spawnImpl || spawnSync;
	const chain = resolveChain({ toolOverride });
	const attempts = [];
	for (const entry of chain) {
		let promptFile = null;
		try {
			if (entry.tool === "pi") {
				// The task text goes in a temp prompt file — never on argv.
				// mkdtempSync mints a 0700 unique directory (collision-proof, no
				// predictable path for a symlink-plant attack); crypto.randomBytes
				// adds an unguessable filename suffix. Matches the Windows-safe
				// pattern in src/consolidate.js:264.
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-"));
				promptFile = path.join(
					dir,
					`task-${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.md`,
				);
				fs.writeFileSync(promptFile, task, "utf8");
			}
			const { cmd, args } = buildArgv(entry, {
				task,
				promptFile,
				readOnly,
				cwd,
			});
			// Windows: npm-global CLIs are .cmd shims — resolve to something
			// spawnSync can execute without a shell. An injected spawnImpl keeps
			// the raw cmd/args so unit tests observe buildArgv verbatim.
			let resolved;
			try {
				resolved = spawnImpl ? { cmd, args } : resolveSpawn(cmd, args);
			} catch (e) {
				attempts.push({
					tool: entry.tool,
					model: entry.model,
					kind: "spawn",
					detail: lastChars(e.message, 400),
				});
				continue;
			}
			const r = spawn(resolved.cmd, resolved.args, {
				cwd,
				encoding: "utf8",
				timeout: timeoutMs,
				windowsHide: true,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (r && r.status === 0) {
				return {
					ok: true,
					tool: entry.tool,
					provider: entry.provider ?? null,
					model: entry.model,
					output: String(r.stdout ?? "").trim(),
					attempts,
				};
			}
			const stderr = String(r?.stderr ?? "");
			const stdout = String(r?.stdout ?? "");
			const errText = String(r?.error?.message ?? "");
			attempts.push({
				tool: entry.tool,
				model: entry.model,
				kind: classifyFailure(`${errText}\n${stderr}\n${stdout}`),
				detail: lastChars(stderr || stdout || errText, 400),
			});
		} finally {
			if (promptFile) {
				try {
					fs.rmSync(promptFile, { force: true });
				} catch {
					/* best-effort cleanup */
				}
			}
		}
	}
	return { ok: false, attempts };
}
