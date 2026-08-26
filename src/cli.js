#!/usr/bin/env node
// src/cli.js — agent-cli entry point. AI-first: --json everywhere, idempotent, no
// interactive prompts (safe for agents/CI). Pointer model: edit ~/.agents/AGENTS.md
// once; per-agent-cli files are stubs that redirect there.

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import path from "node:path";
// Must stay above ./util.js: picocolors (imported there) latches its
// color-support decision at import time, and force-enables color on win32 even
// for a piped stdout. This side-effect import settles NO_COLOR first.
import "./color.js";
import {
	c,
	log,
	pretty,
	MASTER_FILE,
	HOME_POINTER_FILE,
	AGENTS_DIR,
	exists,
	readFile,
	readIfExists,
	writeFile,
	resolveContained,
	parseEditorCommand,
	cmdShimSpawnSync,
} from "./util.js";
import { envelope, serializeEnvelope, EXIT } from "./envelope.js";
import { TARGETS, getTarget, targetsWithScope, pathFor } from "./targets.js";
import { linkShared, unlinkShared } from "./share.js";
import {
	loadConfig,
	saveConfig,
	enableGlobal,
	isGlobalEnabled,
	isProjectEnabled,
	effectiveProjectIds,
	hasExplicitProjectTargets,
	isConfigCorrupt,
} from "./config.js";
import {
	ensureMaster,
	readMaster,
	writeMaster,
	refreshBlocks,
	masterTilde,
	ensureMasterPointer,
} from "./store.js";
import { hasAgentCliBlock } from "./blocks.js";
import {
	targetPath,
	classify,
	linkTarget,
	unlinkTarget,
	POINTER_MARK,
	setExpectedCtx,
} from "./pointer.js";
import { detectInstalled } from "./detect.js";
import {
	listAgents,
	showAgent,
	scaffoldAgent,
	identityInventory,
	findUnresolvedModels,
	identityFilePath,
	GLOBAL_AGENTS_DIR,
	projectAgentsDir,
	validateAgent,
} from "./agents-lib.js";
import { ensureSkillStore, isSkillAvailable, runSkill } from "./skill.js";
import { registerTargetCommand } from "./commands/target.js";
import { registerInfoCommands } from "./commands/info.js";
import { registerInspectCommands } from "./commands/inspect.js";
import { registerProtocolCommands } from "./commands/protocol.js";
import { registerWhereCommand } from "./commands/where.js";
import { registerArchetypeCommands } from "./commands/archetype.js";
import { registerEditCommands } from "./commands/edit.js";
import {
	registerLinkCommands,
	registerStatusCommand,
} from "./commands/link.js";
import { registerMemoryOpsCommands } from "./commands/memory-ops.js";
import { registerMemoryStackCommands } from "./commands/memory-stack.js";
import { registerIdentityCommands } from "./commands/identity-cmds.js";
import { registerDelegationCommands } from "./commands/delegation.js";
import { registerKnowledgeCommands } from "./commands/knowledge.js";
import { registerModelsCommands } from "./commands/models.js";
import { registerConfigureCommands } from "./commands/configure.js";
import { registerToolingCommands } from "./commands/tooling.js";
import { registerSessionCommands } from "./commands/session-cmds.js";
import { registerReactiveCommands } from "./commands/reactive.js";
import { registerUpdateCommands } from "./commands/update-cmds.js";
import { registerSkillCommands } from "./commands/skill-cmds.js";
import { registerSessionCoreCommands } from "./commands/session-core.js";
import { registerBootstrapCommands } from "./commands/bootstrap.js";
import { registerEvaluateCommands } from "./commands/evaluate.js";
import { registerLedgerCommands } from "./commands/ledger.js";
import { registerTeamEvalCommands } from "./commands/team-eval.js";
import { registerRetroCommands } from "./commands/retro.js";
import { registerMemoryUpgradeCommands } from "./commands/memory-upgrade.js";
import { registerInstructionsCommand, suggestCommand } from "./commands/instructions.js";
import { registerPromptCommand } from "./commands/prompt.js";
// Static import (not dynamic): the preAction hook awaits this module on every
// command, and commands like `help`/`doctor` call process.exit() right after.
// A dynamic import() leaves the module-loader async handle closing at exit,
// which intermittently crashes Node on Windows with the libuv
// "UV_HANDLE_CLOSING" assertion. Resolving it at load time (before the event
// loop runs) removes that race entirely.
import { resolveUpdateNotice, updateCheckEnabled } from "./update-notice.js";

const PKG = createRequire(import.meta.url)("../package.json");
const VERSION = PKG.version;
const PKG_NAME = PKG.name;

// Silence Node's DEP0190 (spawn shell:true) deprecation — the editor command is
// internal/trusted. Correctness on pnpm POSIX-shim setups requires shell:true.
{
	const origEmit = process.emit;
	process.emit = (name, ...a) => {
		if (
			name === "warning" &&
			a[0]?.name === "DeprecationWarning" &&
			/shell option/i.test(a[0]?.message || "")
		) {
			return false;
		}
		return origEmit.apply(process, [name, ...a]);
	};
}

let JSON_MODE = false;
let JSON_COMPACT = false;
let QUIET = false;

// Normalize `--json=compact` → `--json --compact` so `--json` stays a plain
// boolean flag. (An optional-value flag like `--json [mode]` would swallow the
// next command token: `--json status` → json="status" and the subcommand is lost.)
if (process.argv.includes("--json=compact")) {
	process.argv = process.argv.flatMap((a) =>
		a === "--json=compact" ? ["--json", "--compact"] : [a],
	);
}

/** Route non-error log.* channels to no-ops for --quiet/--silent. */
function silenceInfoLogs() {
	for (const k of Object.keys(log)) {
		if (k === "error") continue;
		log[k] = () => {};
	}
}

/** Pending npm-update notice, set by the preAction hook (so emit() sees it
 *  synchronously) and cleared at the start of each command. When non-null
 *  and JSON_MODE is on, every emitted envelope picks it up as a top-level
 *  `updateNotice` field so the LLM driving the CLI can react. In human
 *  mode, the preAction hook prints it directly to stderr instead. */
let PENDING_UPDATE_NOTICE = null;

/** Serialize a command payload into the versioned envelope on stdout.
 *  A payload with explicit `ok:false` (e.g. update clear, restore, triage)
 *  is emitted as a failure envelope with a top-level `error`. */
function emit(obj) {
	if (!JSON_MODE) return obj;
	const { command, ...rest } = obj;
	const baseFields = { command, data: rest };
	if (PENDING_UPDATE_NOTICE) baseFields.updateNotice = PENDING_UPDATE_NOTICE;
	if (rest.ok === false) {
		console.log(
			serializeEnvelope(
				envelope({
					...baseFields,
					error: rest.error || rest.reason || `command '${command}' failed`,
				}),
				{ compact: JSON_COMPACT },
			),
		);
		return obj;
	}
	console.log(
		serializeEnvelope(envelope(baseFields), { compact: JSON_COMPACT }),
	);
	return obj;
}

function fail(message, details = {}) {
	if (JSON_MODE) {
		const { command, ...rest } = details;
		const baseFields = {
			command: command ?? "error",
			data: rest,
		};
		if (PENDING_UPDATE_NOTICE) baseFields.updateNotice = PENDING_UPDATE_NOTICE;
		console.log(
			serializeEnvelope(
				envelope({ ...baseFields, error: message }),
				{ compact: JSON_COMPACT },
			),
		);
	} else log.error(message);
	process.exit(EXIT.ERROR);
}

// Mark PENDING_UPDATE_NOTICE as used to satisfy no-unused-vars linters.
void PENDING_UPDATE_NOTICE;

function ctxPaths() {
	return { masterAbs: MASTER_FILE, masterTilde: masterTilde() };
}

// --- project-aware master resolution ---
// The global master lives at ~/.agents/AGENTS.md; a project master lives at
// [cwd]/.agents/AGENTS.md and is what project-scoped pointers must redirect to.
const SKILL_BEGIN = "<!-- BEGIN skill-cli -->";
const SKILL_END = "<!-- END skill-cli -->";

function projectMasterPath(cwd = process.cwd()) {
	return path.join(cwd, ".agents", "AGENTS.md");
}
function masterPaths(scope = "global", cwd = process.cwd()) {
	if (scope === "project") {
		const abs = projectMasterPath(cwd);
		return { masterAbs: abs, masterTilde: pretty(abs) };
	}
	return { masterAbs: MASTER_FILE, masterTilde: masterTilde() };
}

/** Scan argv for a global --json flag (survives commander parse errors). */
function argvWantsJson() {
	return process.argv.some((a) => a === "--json" || a.startsWith("--json="));
}

/** Remove the integrated skill-cli block from the master (used by `init --no-skill`).
 *  Returns true when a block was actually stripped. */
async function stripSkillBlockFromMaster() {
	const c = await readMaster();
	if (c == null || !c.includes(SKILL_BEGIN)) return false;
	const stripped =
		c
			.replace(new RegExp(`${SKILL_BEGIN}[\\s\\S]*?${SKILL_END}`), "")
			.replace(/\n{3,}/g, "\n\n")
			.replace(/\s+$/, "") + "\n";
	await writeMaster(stripped);
	return true;
}

/** Pre-mutation safety snapshot (best-effort). Returns the snapshot name.
 *  Callers pass a label for provenance; the label is informational only. */
async function preSnapshot(_label = "pre-mutation") {
	try {
		const { snapshot } = await import("./snapshot.js");
		const r = await snapshot();
		return r.name;
	} catch {
		return null;
	}
}

const program = new Command();
// Tree-walk the commander program for the machine-readable command surface
// (agent-cli manifest / schema and the protocol command).
function collectCommands(cmd = program, prefix = "") {
	const rows = [];
	for (const sub of cmd.commands) {
		const name = prefix ? `${prefix} ${sub.name()}` : sub.name();
		rows.push({
			name,
			description: sub.description(),
			options: (sub.options || []).map((o) => o.flags),
		});
		rows.push(...collectCommands(sub, name));
	}
	return rows;
}
// Route commander's own parse/usage errors through our JSON-aware error path
// instead of letting commander print plain text and process.exit() directly.
program.exitOverride();
// Suppress commander's own stderr output for parse/usage errors — our catch
// handler below prints a single, consistent error line (or JSON envelope).
program.configureOutput({
	writeErr: () => {},
	writeOut: (str) => process.stdout.write(str),
	outputError: (str, write) => write(str),
});
registerTargetCommand(program, {
	emit,
	fail,
	// Scope-aware: --project targets must redirect to the project master
	// ([cwd]/.agents/AGENTS.md), not the global ~/.agents/AGENTS.md (P0-2).
	masterPaths,
	isJson: () => JSON_MODE,
});
registerInfoCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	isJson: () => JSON_MODE,
	VERSION,
});
registerInspectCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	readFile,
	identityInventory,
	isJson: () => JSON_MODE,
	isConfigCorrupt,
	loadConfig,
	classify,
	getTarget,
	detectInstalled,
	EXIT,
});
registerProtocolCommands(program, {
	emit,
	fail,
	log,
	c,
	program,
	collectCommands,
	EXIT,
	isJson: () => JSON_MODE,
});
registerWhereCommand(program, {
	emit,
	log,
	c,
	pretty,
	TARGETS,
	pathFor,
	targetPath,
	masterPaths,
	isJson: () => JSON_MODE,
});
registerArchetypeCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	path,
	exists,
	writeFile,
	AGENTS_DIR,
	isJson: () => JSON_MODE,
});
registerEditCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	path,
	exists,
	writeFile,
	spawnSync,
	MASTER_FILE,
	projectMasterPath,
	identityFilePath,
	POINTER_MARK,
	getTarget,
	targetPath,
	masterPaths,
	isJson: () => JSON_MODE,
	parseEditorCommand,
	cmdShimSpawnSync,
});
registerLinkCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	TARGETS,
	targetsWithScope,
	loadConfig,
	effectiveProjectIds,
	masterPaths,
	setExpectedCtx,
	linkTarget,
	unlinkTarget,
	ensureMaster,
	ensureMasterPointer,
	isJson: () => JSON_MODE,
	linkShared,
	unlinkShared,
});
registerStatusCommand(program, {
	emit,
	log,
	c,
	pretty,
	VERSION,
	MASTER_FILE,
	TARGETS,
	loadConfig,
	readMaster,
	isSkillAvailable,
	detectInstalled,
	isGlobalEnabled,
	isProjectEnabled,
	classify,
	pathFor,
	hasAgentCliBlock,
	isConfigCorrupt,
	isJson: () => JSON_MODE,
});
registerMemoryOpsCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	EXIT,
	loadConfig,
	getTarget,
	linkTarget,
	ctxPaths,
	preSnapshot,
	isJson: () => JSON_MODE,
});
registerMemoryStackCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	EXIT,
	isJson: () => JSON_MODE,
});
registerMemoryUpgradeCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	isJson: () => JSON_MODE,
});
registerInstructionsCommand(program, {
	emit,
	log,
	c,
	pretty,
	isJson: () => JSON_MODE,
	VERSION,
});
registerPromptCommand(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	isJson: () => JSON_MODE,
	VERSION,
});
registerIdentityCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	exists,
	readFile,
	writeFile,
	identityFilePath,
	preSnapshot,
	isJson: () => JSON_MODE,
});
registerDelegationCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	EXIT,
	isJson: () => JSON_MODE,
	listAgents,
	showAgent,
	scaffoldAgent,
	validateAgent,
	GLOBAL_AGENTS_DIR,
	projectAgentsDir,
	readFile,
	spawnSync,
	path,
	parseEditorCommand,
	cmdShimSpawnSync,
	resolveContained,
});
registerKnowledgeCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	EXIT,
	isJson: () => JSON_MODE,
	readFile,
	preSnapshot,
});
registerModelsCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	isJson: () => JSON_MODE,
	readIfExists,
	writeFile,
	loadConfig,
	findUnresolvedModels,
	listAgents,
});
registerConfigureCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	isJson: () => JSON_MODE,
});
registerToolingCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	EXIT,
	isJson: () => JSON_MODE,
	loadConfig,
	saveConfig,
	ctxPaths,
	getTarget,
	linkTarget,
});
registerSessionCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	EXIT,
	isJson: () => JSON_MODE,
	loadConfig,
	saveConfig,
	readMaster,
	detectInstalled,
	getTarget,
	enableGlobal,
	effectiveProjectIds,
	hasExplicitProjectTargets,
	ensureSkillStore,
	findUnresolvedModels,
	classify,
	projectMasterPath,
	masterPaths,
	setExpectedCtx,
	exists,
	writeFile,
	path,
});
registerReactiveCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	EXIT,
	isJson: () => JSON_MODE,
	setJson: (v) => {
		JSON_MODE = v;
	},
	path,
});
registerUpdateCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	EXIT,
	isJson: () => JSON_MODE,
	loadConfig,
	saveConfig,
	ctxPaths,
	getTarget,
	linkTarget,
	refreshBlocks,
	resolveContained,
	exists,
	readFile,
	preSnapshot,
	AGENTS_DIR,
	VERSION,
	PKG_NAME,
});
registerSkillCommands(program, {
	emit,
	fail,
	log,
	c,
	isJson: () => JSON_MODE,
	ensureSkillStore,
	refreshBlocks,
	isSkillAvailable,
	runSkill,
	serializeEnvelope,
	envelope,
	JSON_COMPACT,
});
registerSessionCoreCommands(program, {
	emit,
	log,
	c,
	pretty,
	EXIT,
	isJson: () => JSON_MODE,
	loadConfig,
	saveConfig,
	readMaster,
	VERSION,
	PKG_NAME,
	detectInstalled,
});
registerBootstrapCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	isJson: () => JSON_MODE,
	TARGETS,
	loadConfig,
	saveConfig,
	detectInstalled,
	getTarget,
	enableGlobal,
	ensureMaster,
	ensureMasterPointer,
	ensureSkillStore,
	stripSkillBlockFromMaster,
	linkTarget,
	ctxPaths,
	exists,
	writeFile,
	path,
	AGENTS_DIR,
	MASTER_FILE,
	HOME_POINTER_FILE,
	VERSION,
});
registerEvaluateCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	isJson: () => JSON_MODE,
	path,
	AGENTS_DIR,
	resolveContained,
});
registerLedgerCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	isJson: () => JSON_MODE,
});
registerTeamEvalCommands(program, {
	emit,
	log,
	c,
	isJson: () => JSON_MODE,
});
registerRetroCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	isJson: () => JSON_MODE,
});
program
	.name("agent-cli")
	.description(
		"Manage AGENTS.md and point every coding agent at one canonical source (~/.agents/AGENTS.md). Bundles skill-cli.",
	)
	.version(VERSION, "-v, --version")
	.option("--json", "Emit machine-readable JSON (AI/CI friendly)")
	.option("--compact", "With --json: emit compact (single-line) JSON")
	.option("-q, --quiet", "Suppress informational output (errors still print)")
	.option("--silent", "Alias for --quiet")
	// Declared so commander accepts the conventional flag; the color decision
	// itself is made in ./color.js before picocolors loads (also: NO_COLOR=1).
	.option("--no-color", "Disable ANSI color (also: NO_COLOR=1)")
	.option(
		"--no-update-check",
		"skip the npm-update freshness check (also: AGENT_CLI_NO_UPDATE_CHECK=1)",
	)
	.option(
		"--update-check",
		"force a fresh npm registry check (bypass daily cache)",
	)
	.hook("preAction", async (cmd) => {
		const o = cmd.optsWithGlobals();
		JSON_MODE = !!o.json;
		JSON_COMPACT = !!o.compact;
		QUIET = !!o.quiet || !!o.silent;
		if (QUIET) silenceInfoLogs();
		setExpectedCtx(ctxPaths());
		// Reset any notice carried over from a prior invocation in this process.
		PENDING_UPDATE_NOTICE = null;
		// npm-update notice — non-blocking best-effort. Reads from the daily
		// cache in config.json; only hits the network when the cache is missing
		// or stale, capped by a 1.5s timeout. Opts out via --no-update-check,
		// --offline, AGENT_OFFLINE=1, or AGENT_CLI_NO_UPDATE_CHECK=1. JSON
		// consumers see it in the envelope's top-level updateNotice field;
		// humans get a one-line stderr print.
		try {
			if (!updateCheckEnabled()) return;
			const cfg = await loadConfig();
			const force = process.argv.includes("--update-check");
			const offline =
				process.argv.includes("--offline") ||
				process.argv.includes("--no-network") ||
				process.env.AGENT_OFFLINE === "1";
			const r = await resolveUpdateNotice(cfg, PKG_NAME, VERSION, {
				force,
				offline,
				timeoutMs: 1500,
			});
			if (!r.notice) return;
			if (JSON_MODE) {
				PENDING_UPDATE_NOTICE = {
					latest: r.latest,
					installed: VERSION,
					message: r.notice,
					reason: r.reason,
					checkedAt: r.checkedAt,
				};
			} else if (!QUIET) {
				process.stderr.write(c.yellow("! ") + r.notice + "\n");
			}
			// Persist any cache mutation so future runs don't re-fetch.
			try {
				await saveConfig(cfg);
			} catch {
				/* ignore */
			}
		} catch {
			/* swallow — update notice is advisory */
		}
	})
	// `agent-cli sync auto on`: after any successful (non-exiting) command, best-effort
	// auto-commit when auto-commit is enabled. process.exit() paths skip this.
	.hook("postAction", async () => {
		try {
			const sync = await import("./sync.js");
			const cfg = await loadConfig();
			if (sync.autoCommitEnabled(cfg)) await sync.maybeAutoSync(cfg);
		} catch {
			/* best-effort */
		}
	});

// ---------------------------------------------------------------------------
// agent-cli init
// ---------------------------------------------------------------------------
program
	.command("help [command]")
	.description("Show help for the CLI or a specific command.")
	.action((command) => {
		if (command) {
			const target = program.commands.find((c) => c.name() === command);
			if (!target) {
				const allNames = collectCommands().map((c) => c.name.split(" ")[0]);
				const suggestion = suggestCommand(command, allNames);
				fail(
					suggestion
						? `Unknown command: ${command} — ${suggestion}`
						: `Unknown command: ${command}`,
					{ command: "help", name: command, suggestion },
				);
			}
			target.help();
			process.exit(0); // unreachable if help() throws via exitOverride
		}
		program.help();
		process.exit(0); // unreachable if help() throws via exitOverride
	});

// Bare `agent-cli` — guided quick start (prose) or the manifest (JSON), exit 0.
program.action((opts, cmd) => {
	JSON_MODE = !!(opts.json || argvWantsJson());
	JSON_COMPACT = !!opts.compact;
	QUIET = !!(opts.quiet || opts.silent);
	if (QUIET) silenceInfoLogs();
	// commander drops unmatched operands from the root action's args; they stay
	// on the program's `.args` (e.g. `agent-cli frobnicate` → args=["frobnicate"]).
	const operands = (cmd && cmd.args) || [];
	if (operands.length) {
		// Unmatched first token → unknown command. Suggest closest matches so
		// the LLM (and the user) can self-correct instead of re-reading --help.
		const name = String(operands[0]);
		const allNames = collectCommands().map((c) => c.name.split(" ")[0]);
		const suggestion = suggestCommand(name, allNames);
		const baseError = `Unknown command: ${name}`;
		const errorWithHint = suggestion ? `${baseError}\n${suggestion}` : baseError;
		if (JSON_MODE)
			console.log(
				serializeEnvelope(
					envelope({
						command: "error",
						data: { name, suggestion },
						error: errorWithHint,
					}),
					{ compact: JSON_COMPACT },
				),
			);
		else
			log.error(
				suggestion
					? `${baseError} — ${suggestion}`
					: `${baseError} — run \`agent-cli --help\``,
			);
		process.exit(EXIT.ERROR);
	}
	if (JSON_MODE) {
		console.log(
			serializeEnvelope(
				envelope({
					command: "manifest",
					data: { commands: collectCommands(), exitCodes: EXIT },
				}),
				{ compact: JSON_COMPACT },
			),
		);
		return;
	}
	log.raw(
		`${c.bold("agent-cli")} ${c.gray("v" + VERSION)} — one canonical AGENTS.md at ~/.agents/AGENTS.md, mirrored to every coding agent.`,
	);
	log.raw("");
	log.raw(
		`  ${c.cyan("agent-cli init")}          bootstrap ~/.agents/AGENTS.md master + pointers + home pointer + brief hooks (idempotent)`,
	);
	log.raw(
		`  ${c.cyan("agent-cli brief")}         AI session brief — health, gaps, next action (each action is runnable via 'agent-cli run <id>')`,
	);
	log.raw(
		`  ${c.cyan("agent-cli doctor")}        diagnose master, pointers, skill-cli, staged updates, npm version`,
	);
	log.raw(
		`  ${c.cyan("agent-cli status")}        per-target pointer state and brief-hook health`,
	);
	log.raw(
		`  ${c.cyan("agent-cli models")}        list/set/resolve model aliases; MODELS.md is the source of truth`,
	);
	log.raw(
		`  ${c.cyan("agent-cli brief-hooks")}   install/uninstall/status SessionStart hooks (auto-runs 'agent-cli brief' per session)`,
	);
	log.raw("");
	log.dim(`Run ${c.cyan("agent-cli --help")} for the full command list.`);
});

// Let the root action see an unmatched operand instead of commander aborting
// first with "too many arguments. Expected 0 arguments but got 1: frobnicate"
// — a misleading arity error for what is really an unknown command. The root
// action (above) turns it into `Unknown command: <name>` + a suggestion.
// MUST stay here, after every subcommand is registered: commander copies
// `_allowExcessArguments` into each subcommand at `.command()` time, so
// setting it earlier would also silence the real "too many arguments for
// '<sub>'" errors (e.g. `agent-cli link claude`).
program.allowExcessArguments(true);

program.parseAsync(process.argv).catch((e) => {
	// Commander raises CommanderError for --help/--version and for parse/usage
	// errors (exitOverride). Route them through the JSON contract when requested.
	const isCmdError =
		e && typeof e.code === "string" && e.code.startsWith("commander.");
	// Help was intentionally requested (`agent-cli --help`, `agent-cli help`, or the
	// `help` subcommand) — that is success, not an error. Exit 0.
	if (
		isCmdError &&
		(e.code === "commander.helpDisplayed" || e.code === "commander.help")
	) {
		process.exit(0);
	}
	if (isCmdError && e.code === "commander.version") {
		process.exit(e.exitCode ?? 0);
	}
	if (isCmdError) {
		const json = JSON_MODE || argvWantsJson();
		if (json)
			console.log(
				serializeEnvelope(
					envelope({
						command: "error",
						data: { code: e.code },
						error: e.message,
					}),
					{ compact: JSON_COMPACT },
				),
			);
		else log.error(e.message);
		process.exit(e.exitCode || EXIT.ERROR);
	}
	if (JSON_MODE)
		console.log(
			serializeEnvelope(
				envelope({ command: "error", data: {}, error: e.message }),
				{ compact: JSON_COMPACT },
			),
		);
	else log.error(e.message);
	process.exit(EXIT.ERROR);
});
