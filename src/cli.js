#!/usr/bin/env node
// src/cli.js — agent-cli entry point. AI-first: --json everywhere, idempotent, no
// interactive prompts (safe for agents/CI). Pointer model: edit ~/AGENTS.md
// once; per-agent files are stubs that redirect there.

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import path from "node:path";
import os from "node:os";
import {
	c,
	log,
	pretty,
	MASTER_FILE,
	POINTER_MASTER_FILE,
	CONFIG_FILE,
	AGENTS_DIR,
	exists,
	readFile,
	readIfExists,
	writeFile,
	resolveContained,
} from "./util.js";
import { envelope, serializeEnvelope, EXIT } from "./envelope.js";
import { TARGETS, getTarget, targetsWithScope, pathFor } from "./targets.js";
import {
	loadConfig,
	saveConfig,
	enableGlobal,
	isGlobalEnabled,
	isProjectEnabled,
	effectiveProjectIds,
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
	computeOnboarding,
	findUnresolvedModels,
	identityFilePath,
	GLOBAL_AGENTS_DIR,
	projectAgentsDir,
	validateAgent,
} from "./agents-lib.js";
import {
	ensureSkillStore,
	isSkillAvailable,
	skillVersion,
	runSkill,
} from "./skill.js";
import { registerTargetCommand } from "./commands/target.js";
import { registerInfoCommands } from "./commands/info.js";
import { registerInspectCommands } from "./commands/inspect.js";
import { registerProtocolCommands } from "./commands/protocol.js";
import { registerWhereCommand } from "./commands/where.js";
import { registerArchetypeCommands } from "./commands/archetype.js";
import { registerEditCommands } from "./commands/edit.js";
import { registerLinkCommands, registerStatusCommand } from "./commands/link.js";
import { registerMemoryOpsCommands } from "./commands/memory-ops.js";
import { registerMemoryStackCommands } from "./commands/memory-stack.js";
import { registerIdentityCommands } from "./commands/identity-cmds.js";
import { registerDelegationCommands } from "./commands/delegation.js";
import { registerKnowledgeCommands } from "./commands/knowledge.js";
import { registerToolingCommands } from "./commands/tooling.js";
import { registerSessionCommands } from "./commands/session-cmds.js";
import { registerReactiveCommands } from "./commands/reactive.js";
import { registerUpdateCommands } from "./commands/update-cmds.js";
import { registerSkillCommands } from "./commands/skill-cmds.js";
import { registerSessionCoreCommands } from "./commands/session-core.js";

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

/** Serialize a command payload into the versioned envelope on stdout.
 *  A payload with explicit `ok:false` (e.g. update clear, restore, triage)
 *  is emitted as a failure envelope with a top-level `error`. */
function emit(obj) {
	if (!JSON_MODE) return obj;
	const { command, ...rest } = obj;
	if (rest.ok === false) {
		console.log(
			serializeEnvelope(
				envelope({
					command,
					data: rest,
					error:
						rest.error || rest.reason || `command '${command}' failed`,
				}),
				{ compact: JSON_COMPACT },
			),
		);
		return obj;
	}
	console.log(
		serializeEnvelope(envelope({ command, data: rest }), {
			compact: JSON_COMPACT,
		}),
	);
	return obj;
}

function fail(message, details = {}) {
	if (JSON_MODE) {
		const { command, ...rest } = details;
		console.log(
			serializeEnvelope(
				envelope({
					command: command ?? "error",
					data: rest,
					error: message,
				}),
				{ compact: JSON_COMPACT },
			),
		);
	} else log.error(message);
	process.exit(EXIT.ERROR);
}

function ctxPaths() {
	return { masterAbs: MASTER_FILE, masterTilde: masterTilde() };
}

// --- project-aware master resolution (Finding 13) ---
// The global master lives at ~/AGENTS.md; a project master lives at
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
	const stripped = c
		.replace(new RegExp(`${SKILL_BEGIN}[\\s\\S]*?${SKILL_END}`), "")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/\s+$/, "") + "\n";
	await writeMaster(stripped);
	return true;
}

/** Pre-mutation safety snapshot (best-effort). Returns the snapshot name. */
async function preSnapshot(label) {
	try {
		const { snapshot } = await import("./snapshot.js");
		const r = snapshot();
		return r.name;
	} catch {
		return null;
	}
}

const program = new Command();
// Tree-walk the commander program for the machine-readable command surface
// (agent manifest / schema and the protocol command).
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
	// ([cwd]/.agents/AGENTS.md), not the global ~/AGENTS.md (P0-2).
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
	log,
	c,
	pretty,
	readFile,
	identityInventory,
	isJson: () => JSON_MODE,
});
registerProtocolCommands(program, {
	emit,
	fail,
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
});
registerLinkCommands(program, {
	emit,
	fail,
	log,
	c,
	TARGETS,
	targetsWithScope,
	loadConfig,
	effectiveProjectIds,
	masterPaths,
	setExpectedCtx,
	linkTarget,
	unlinkTarget,
	isJson: () => JSON_MODE,
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
	skillVersion,
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
});
registerKnowledgeCommands(program, {
	emit,
	fail,
	log,
	c,
	pretty,
	EXIT,
	isJson: () => JSON_MODE,
	readIfExists,
	writeFile,
	readFile,
	preSnapshot,
	loadConfig,
	findUnresolvedModels,
	listAgents,
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
	ensureSkillStore,
	findUnresolvedModels,
	classify,
	projectMasterPath,
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
	skillVersion,
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
	detectInstalled,
	getTarget,
	classify,
	isSkillAvailable,
	skillVersion,
	identityInventory,
	computeOnboarding,
	findUnresolvedModels,
	listAgents,
	hasAgentCliBlock,
	isConfigCorrupt,
	exists,
	readFile,
	path,
	os,
	AGENTS_DIR,
	MASTER_FILE,
	VERSION,
	PKG_NAME,
});
program
	.name("agent")
	.description(
		"Manage AGENTS.md and point every coding agent at one canonical source (~/AGENTS.md). Bundles skill-cli.",
	)
	.version(VERSION, "-v, --version")
	.option("--json", "Emit machine-readable JSON (AI/CI friendly)")
	.option("--compact", "With --json: emit compact (single-line) JSON")
	.option("-q, --quiet", "Suppress informational output (errors still print)")
	.option("--silent", "Alias for --quiet")
	.hook("preAction", (cmd) => {
		const o = cmd.optsWithGlobals();
		JSON_MODE = !!o.json;
		JSON_COMPACT = !!o.compact;
		QUIET = !!o.quiet || !!o.silent;
		if (QUIET) silenceInfoLogs();
		setExpectedCtx(ctxPaths());
	})
	// `agent sync auto on`: after any successful (non-exiting) command, best-effort
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
// agent init
// ---------------------------------------------------------------------------
program
	.command("init")
	.description(
		"Bootstrap ~/AGENTS.md master, deploy pointer stubs, deploy the self-pointer at ~/.agents/AGENTS.md, install SessionStart brief hooks, and set up skill-cli. Idempotent — re-runs repair any missing parts.",
	)
	.option("--no-skill", "Skip skill-cli setup")
	.option(
		"--yes",
		"Confirm any non-interactive defaults (no-op; agent-cli never prompts)",
	)
	.option(
		"--force",
		"Overwrite native content in ~/.agents/AGENTS.md (destructive) and re-write all missing parts",
	)
	.action(async (opts) => {
		const result = { command: "init", steps: {} };

		// 1. master + managed blocks
		const master = await ensureMaster();
		result.steps.master = master;
		if (master.skipped) {
			fail(
				`Cannot initialize: ${master.skipped}. Preserve the existing master and repair it before retrying.`,
				{ command: "init", steps: result.steps },
			);
		}

		// 2. detect + enable installed global targets
		const cfg = await loadConfig();
		const installed = await detectInstalled();
		for (const id of installed) {
			const t = getTarget(id);
			if (t && t.global) enableGlobal(cfg, id);
		}
		result.steps.detected = installed;

		// 3. skill-cli store + block (block already ensured by ensureMaster)
		if (opts.skill !== false && cfg.skillManaged) {
			result.steps.skillStore = await ensureSkillStore();
		} else if (opts.skill === false) {
			// --no-skill: suppress the skill-cli block that ensureMaster injected,
			// not just the store setup.
			result.steps.skillBlockRemoved = await stripSkillBlockFromMaster();
		}

		// 4. seed defaults: first install writes them into ~/.agents; a version bump
		//    stages new defaults into ~/.agents/update-<version>/ for review.
		//    Existing user files are never overwritten.
		const seed = await import("./seed.js");
		const seedPlan = seed.planSeedAction(cfg.seedVersion, VERSION);
		const seedEntries = await seed.listSeedFiles();
		const currentSeedFiles = seedEntries.map((f) => f.rel).sort();
		if (seedPlan.action === "install") {
			result.steps.seeds = await seed.installSeeds({ home: AGENTS_DIR });
		} else if (seedPlan.action === "stage") {
			result.steps.seeds = await seed.stageSeeds({
				home: AGENTS_DIR,
				version: VERSION,
				previousFiles: cfg.seedFiles || [],
			});
		}
		cfg.seedFiles = currentSeedFiles;
		cfg.seedVersion = VERSION;

		await saveConfig(cfg);

		// 4b. seed the full identity/memory file set (NON-DESTRUCTIVE) + empty model document.
		//     Model mappings are agent-owned; init never invents provider choices.
		//     required set so brief/doctor don't report missing files.
		const arc = await import("./archetypes.js");
		const models = await import("./models.js");
		const home = AGENTS_DIR;
		const identityFiles = [
			["IDENTITY.md", arc.identityContent(arc.DEFAULT_IDENTITY)],
			["SOUL.md", arc.soulContent(arc.DEFAULT_SOUL)],
			["USER.md", arc.userContent()],
			["LESSONS.md", arc.lessonsContent()],
			["ENVIRONMENTS.md", arc.environmentsContent()],
		];
		const idCreated = [];
		const idSkipped = [];
		for (const [name, content] of identityFiles) {
			const fp = path.join(home, name);
			if (await exists(fp)) {
				idSkipped.push(name);
				continue;
			}
			await writeFile(fp, content);
			idCreated.push(name);
		}
		const modelsMdPath = models.MODELS_MD;
		let modelsMdCreated = false;
		if (!(await exists(modelsMdPath))) {
			models.writeModelsMd();
			modelsMdCreated = true;
		}
		result.steps.identityFiles = { created: idCreated, skipped: idSkipped };
		result.steps.models = {
			modelsMdCreated,
		};

		// 5. deploy self-pointer stub (idempotent; re-creates ~/.agents/AGENTS.md
		//    if missing or stale so agent-cli is the only writer of that path).
		const mTildeForPointer = ctxPaths().masterTilde;
		// After a migration the old ~/.agents/AGENTS.md holds the adopted master
		// content — it must become the self-pointer stub unconditionally.
		const forcePointer = !!opts.force || master.action === "migrated";
		const masterPointer = await ensureMasterPointer({
			masterAbs: MASTER_FILE,
			masterTilde: mTildeForPointer,
			force: forcePointer,
		});
		result.steps.masterPointer = masterPointer;

		// 6. deploy per-target pointer stubs (non-destructive; auto-convert the seed source)
		const { masterAbs, masterTilde: mTilde } = ctxPaths();
		const seedId = master.seed ? getTargetByFile(master.seed) : null;
		const deploy = [];
		for (const id of cfg.global) {
			const t = getTarget(id);
			if (!t) continue;
			const seedForce = seedId === id; // seed content already lives in master
			const force = seedForce || !!opts.force; // --force on init promotes seed+re-init overwrite
			const r = await linkTarget(t, "global", {
				masterAbs,
				masterTilde: mTilde,
				force,
			});
			deploy.push({ id, name: t.name, ...r });
		}
		result.steps.deploy = deploy;
		result.config = { global: cfg.global, project: cfg.project };

		// 7. auto-install SessionStart brief hooks for enabled targets (best-effort).
		try {
			const hooks = await import("./hooks.js");
			const enabledIds = new Set(cfg.global);
			const hookCapable = hooks
				.targetsWithHooks()
				.filter((t) => enabledIds.has(t.id));
			const hookResults = [];
			for (const t of hookCapable) {
				hookResults.push(await hooks.installHook(t, { force: !!opts.force }));
			}
			result.steps.hooks = {
				count: hookResults.length,
				installed: hookResults.filter((r) => r.installed).length,
				skipped: hookResults.filter((r) => r.skipped).length,
				blocked: hookResults.filter((r) => r.blocked).length,
			};
		} catch (e) {
			result.steps.hooks = { error: e.message };
		}

		// 8. auto-capture environment info (OS, shell, home, ssh aliases).
		//    Non-destructive: fills empty ENVIRONMENTS.md fields only.
		try {
			const envMod = await import("./env-capture.js");
			const envResult = await envMod.captureAndApply({ cwd: process.cwd() });
			result.steps.envCapture = {
				filled: envResult.filled || 0,
				detected: envResult.detected || {},
				sshAliases: (envResult.sshAliases || []).length,
			};
		} catch (e) {
			result.steps.envCapture = { error: e.message };
		}

		// 9. auto-pick model aliases from the bundled catalog so personas
		//    are immediately usable without manual model assignment.
		try {
			const hooks = await import("./agents-lib.js");
			const unresolved = await hooks.findUnresolvedModels();
			if (unresolved.length > 0) {
				const applied = [];
				// Group by alias like models suggest does.
				const byAlias = new Map();
				for (const u of unresolved) {
					const arr = byAlias.get(u.model) || [];
					arr.push(u);
					byAlias.set(u.model, arr);
				}
				for (const [alias, personas] of byAlias) {
					const hint = String(alias).replace(/-model$/, "").toLowerCase();
					let category = models.CATEGORIES.includes(hint) ? hint : null;
					if (!category) category = "smart"; // fallback
					const picked = models.pickForCategory(category);
					if (picked) {
						models.setAlias(alias, {
							model: `${picked.provider}/${picked.id}`,
							category,
							thinking: picked.thinking ? "on" : undefined,
						});
						applied.push({ alias, model: `${picked.provider}/${picked.id}`, personas: personas.length });
					}
				}
				if (applied.length > 0) {
					models.writeModelsMd();
					result.steps.autoModels = { applied: applied.length, aliases: applied };
				}
			}
		} catch (e) {
			result.steps.autoModels = { error: e.message };
		}

		emit(result);

		if (!JSON_MODE) {
		const linked = deploy.filter((d) => d.linked).length;
		const blocked = deploy.filter((d) => d.blocked);
	log.info(
		`Pointers: ${c.green(linked + " linked")}, ${cfg.global.length} global targets enabled`,
	);
	if (cfg.global.length === 0) {
		const installed = await detectInstalled();
		const installable = installed.filter((id) => {
			const t = TARGETS.find((x) => x.id === id);
			return t && t.global;
		});
		if (installable.length) {
			log.dim(
				`Detected ${installable.length} installable target(s): ${installable.join(", ")}. Enable with: agent target enable ${installable.slice(0, 3).join(" ")}${installable.length > 3 ? " …" : ""}`,
			);
		} else {
			log.dim(
				"No targets detected yet. Install a supported agent (claude/codex/gemini/pi/...) and run 'agent init' again, or 'agent target enable <id>' to enable manually.",
			);
		}
			log.success(`Self-pointer stub written: ${c.cyan(pretty(POINTER_MASTER_FILE))}`);
		} else if (masterPointer.action === "updated") {
			log.info(`Self-pointer stub refreshed: ${c.cyan(pretty(POINTER_MASTER_FILE))}`);
		} else if (masterPointer.skipped === "native-content") {
			log.warn(
				`Self-pointer stub at ${c.cyan(pretty(POINTER_MASTER_FILE))} has native content — run ${c.cyan("agent init --force")} to replace it.`,
			);
		}
		if (blocked.length) {
			for (const b of blocked) {
				log.warn(
					`${b.name}: native content — run ${c.cyan("agent pull " + b.id)} then ${c.cyan("agent link --force")}`,
				);
			}
		}
		log.dim(
			`Next: run ${c.cyan("agent brief")}, then read every file under "Load at session start". Edit the master: ${c.cyan("agent edit")}.`,
		);

		}
	});

function getTargetByFile(homeRel) {
	// homeRel like '.pi/agent/AGENTS.md' → match a target whose global ends with that
	for (const t of TARGETS) {
		if (
			t.global &&
			(t.global === homeRel ||
				t.global.endsWith("/" + homeRel) ||
				homeRel.endsWith(t.global))
		) {
			return t.id;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// agent link / unlink — moved to src/commands/link.js (HIGH-3)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// agent brief-hooks (SessionStart auto-brief for supported agents)
//
// Named `brief-hooks` (not `hooks`) because `agent hooks` is already the
// git-hooks command; commander requires unique command names. The two share
// the same noun in user-facing help text but operate on entirely different
// files.
// ---------------------------------------------------------------------------
program
	.command("brief-hooks <action>")
	.description(
		"Manage native SessionStart hooks for supported agents. Action: install | uninstall | status. Each installs a hook that calls `agent brief --oneline` at session start.",
	)
	.option(
		"-t, --target <ids...>",
		"Restrict to a subset of hook-capable target ids (default: all enabled)",
	)
	.option("--force", "Overwrite native (non-agent-cli) hook entries (destructive)")
	.action(async (action, opts) => {
		const hooks = await import("./hooks.js");
		const cfg = await loadConfig();
		const enabledIds = new Set(cfg.global);
		const known = hooks.targetsWithHooks().map((t) => t.id);
		let ids = opts.target || known;
		// When the user didn't pass --target, restrict to ENABLED targets.
		if (!opts.target) ids = ids.filter((id) => enabledIds.has(id));
		const targets = ids
			.map((id) => hooks.getTarget(id) || getTarget(id))
			.filter(Boolean);
		const unknown = ids.filter((id) => !targets.find((t) => t.id === id));
		if (unknown.length) {
			fail(
				`Unknown target id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Hook-capable ids: ${known.join(", ")}.`,
				{ command: "brief-hooks", action, target: unknown },
			);
		}
		const out = { command: "brief-hooks", action, results: [] };
		const force = !!opts.force;
		if (action === "install") {
			for (const t of targets) {
				const r = await hooks.installHook(t, { force });
				out.results.push({ id: t.id, name: t.name, ...r });
			}
		} else if (action === "uninstall") {
			for (const t of targets) {
				const r = await hooks.uninstallHook(t);
				out.results.push({ id: t.id, name: t.name, ...r });
			}
		} else if (action === "status") {
			for (const t of targets) {
				const r = await hooks.statusHook(t);
				out.results.push(r);
			}
		} else {
			fail(`Unknown brief-hooks action: ${action}. Use install | uninstall | status.`, {
				command: "brief-hooks",
				action,
			});
		}
		out.count = out.results.length;
		emit(out);
		if (!JSON_MODE) {
			if (action === "status") {
				for (const r of out.results) {
					const mark = r.installed ? c.green("✓") : c.gray("·");
					log.raw(`  ${mark} ${r.id.padEnd(9)} ${r.state.padEnd(14)} ${c.gray(r.prettyPath || "")}`);
				}
			} else {
				const installed = out.results.filter((r) => r.installed).length;
				const unlinked = out.results.filter((r) => r.unlinked).length;
				const skipped = out.results.filter((r) => r.skipped).length;
				const blocked = out.results.filter((r) => r.blocked).length;
				if (action === "install") {
					log.success(`${installed} installed, ${skipped} skipped, ${blocked} blocked (use --force to overwrite)`);
				} else if (action === "uninstall") {
					log.success(`${unlinked} removed, ${skipped} skipped`);
				}
			}
		}
	});
// ---------------------------------------------------------------------------
// agent status / targets / target enable|disable
// ---------------------------------------------------------------------------// ---------------------------------------------------------------------------

program
	.command("help [command]")
	.description("Show help for the CLI or a specific command.")
	.action((command) => {
		if (command) {
			const target = program.commands.find((c) => c.name() === command);
			if (!target)
				fail(`Unknown command: ${command}`, { command: "help", name: command });
			target.help();
			process.exit(0); // unreachable if help() throws via exitOverride
		}
		program.help();
		process.exit(0); // unreachable if help() throws via exitOverride
	});

// Bare `agent` — guided quick start (prose) or the manifest (JSON), exit 0.
program.action((opts, cmd) => {
	JSON_MODE = !!(opts.json || argvWantsJson());
	JSON_COMPACT = !!opts.compact;
	QUIET = !!(opts.quiet || opts.silent);
	if (QUIET) silenceInfoLogs();
	// commander drops unmatched operands from the root action's args; they stay
	// on the program's `.args` (e.g. `agent frobnicate` → args=["frobnicate"]).
	const operands = (cmd && cmd.args) || [];
	if (operands.length) {
		// Unmatched first token → unknown command.
		const name = String(operands[0]);
		if (JSON_MODE)
			console.log(
				serializeEnvelope(
					envelope({
						command: "error",
						data: { name },
						error: `Unknown command: ${name}`,
					}),
					{ compact: JSON_COMPACT },
				),
			);
		else log.error(`Unknown command: ${name} — run \`agent --help\``);
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
		`${c.bold("agent-cli")} ${c.gray("v" + VERSION)} — one canonical AGENTS.md at ~/AGENTS.md, mirrored to every coding agent.`,
	);
	log.raw("");
	log.raw(`  ${c.cyan("agent init")}          bootstrap ~/AGENTS.md + pointers + self-pointer + brief hooks (idempotent)`);
	log.raw(`  ${c.cyan("agent brief")}         AI session brief — health, gaps, next action (each action is runnable via 'agent run <id>')`);
	log.raw(`  ${c.cyan("agent doctor")}        diagnose master, pointers, skill-cli, staged updates, npm version`);
	log.raw(`  ${c.cyan("agent status")}        per-target pointer state and brief-hook health`);
	log.raw(`  ${c.cyan("agent models")}        list/set/resolve model aliases; MODELS.md is the source of truth`);
	log.raw(`  ${c.cyan("agent brief-hooks")}   install/uninstall/status SessionStart hooks (auto-runs 'agent brief' per session)`);
	log.raw("");
	log.dim(`Run ${c.cyan("agent --help")} for the full command list.`);
});

program.parseAsync(process.argv).catch((e) => {
	// Commander raises CommanderError for --help/--version and for parse/usage
	// errors (exitOverride). Route them through the JSON contract when requested.
	const isCmdError =
		e && typeof e.code === "string" && e.code.startsWith("commander.");
	// Help was intentionally requested (`agent --help`, `agent help`, or the
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
