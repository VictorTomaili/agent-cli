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
	.command("doctor")
	.description(
		"Diagnose master, pointers, skill-cli, staged updates, and npm version.",
	)
	.option("--force", "force a fresh npm version check (writes config.json)")
	.option("--refresh", "alias for --force")
	.option("--offline", "never hit the network; use the cached check only")
	.option("--no-network", "alias for --offline")
	.option("--plan", "include the structured action plan in the payload")
	.option("--fix-safe", "apply the safeToAutomate action prefix")
	.action(async (opts = {}) => {
		const cfg = await loadConfig();
		const issues = [];
		const checks = [];
		const masterContent = await readMaster();
		const masterOk = masterContent != null;
		checks.push({
			check: "config-not-corrupt",
			ok: !isConfigCorrupt(cfg),
			detail: isConfigCorrupt(cfg) ? "config.json is corrupt" : "ok",
		});
		if (isConfigCorrupt(cfg))
			issues.push("config.json is corrupt — repair or remove it before changing settings");
		checks.push({
			check: "master-exists",
			ok: masterOk,
			detail: pretty(MASTER_FILE),
		});
		if (!masterOk) issues.push("Master missing — run `agent init`.");
		checks.push({
			check: "agent-cli-block",
			ok: hasAgentCliBlock(masterContent || ""),
			detail: "managed block in master",
		});
		if (masterOk && !hasAgentCliBlock(masterContent || ""))
			issues.push(
				"agent-cli block missing — run `agent skill refresh` or `agent init`.",
			);

		for (const id of cfg.global) {
			const t = getTarget(id);
			if (!t || !t.global) continue;
			const cls = await classify(t, "global");
			const ok = cls.state === "pointer";
			checks.push({
				check: "pointer:" + id,
				ok,
				detail: cls.state + " " + pretty(cls.path),
			});
			if (!ok && cls.state !== "missing")
				issues.push(`${id} pointer ${cls.state} — run \`agent link\`.`);
		}
		const skillOk = isSkillAvailable();
		checks.push({
			check: "skill-available",
			ok: skillOk,
			detail: skillVersion().version ?? "none",
		});
		if (!skillOk)
			issues.push("skill-cli unavailable — run `agent skill setup`.");

		// project skill.config health (false-green guard — doctor must not report
		// all-clear when a broken project skill.config would break the skill gate).
		const sgMod = await import("./skills-gate.js");
		const projSkillConfig = sgMod.readProjectConfig(process.cwd());
		const skillConfigOk = !projSkillConfig || projSkillConfig.ok !== false;
		checks.push({
			check: "skill-config",
			ok: skillConfigOk,
			detail: projSkillConfig && projSkillConfig.ok === false ? "corrupt project skill.config" : "ok",
		});
		if (!skillConfigOk)
			issues.push("project skill.config is corrupt — repair or remove it");

		// #1 identity files filled?
		const inv = await identityInventory({
			scope: "global",
			cwd: process.cwd(),
		});
		for (const f of inv.files) {
			if (f.exists && f.filled === false) {
				checks.push({
					check: "identity-filled:" + f.kind,
					ok: false,
					detail: "unfilled template",
				});
				issues.push(
					`${f.kind} is an unfilled template — edit it: agent edit ${f.kind}`,
				);
			}
		}
		// F1: required files must EXIST (false-green guard — doctor must not report
		// healthy when the load manifest would show files as missing).
		const REQUIRED = new Set([
			"identity",
			"soul",
			"user",
			"lessons",
			"environments",
		]);
		const modelsMod = await import("./models.js");
		const modelsMdPath = modelsMod.MODELS_MD;
		const modelsMdExists = await exists(modelsMdPath);
		for (const f of inv.files) {
			if (!REQUIRED.has(f.kind)) continue;
			if (!f.exists) {
				checks.push({
					check: "file-exists:" + f.kind,
					ok: false,
					detail: "missing",
				});
				issues.push(
					`${f.kind} file missing (${pretty(f.path)}) — run \`agent init\` to seed it.`,
				);
			}
		}
		checks.push({
			check: "file-exists:models",
			ok: modelsMdExists,
			detail: modelsMdExists ? pretty(modelsMdPath) : "missing",
		});
		if (!modelsMdExists)
			issues.push(
				`MODELS.md missing (${pretty(modelsMdPath)}) — run \`agent init\` to seed it.`,
			);
		// #2 integration: personalities discoverable + none stranded in old pi path
		const subList = await listAgents({ includeProject: false });
		checks.push({
			check: "personalities-discoverable",
			ok: true,
			detail: `${subList.length} in ~/.agents/agents`,
		});
		// #2b unresolved model aliases → actionable setup guidance
		const unresolvedModels = await findUnresolvedModels();
		checks.push({
			check: "models-resolved",
			ok: unresolvedModels.length === 0,
			detail: unresolvedModels.length
				? unresolvedModels.map((u) => `${u.name} (${u.model})`).join(", ")
				: "all model aliases resolve",
		});
		if (unresolvedModels.length)
			issues.push(
				`unresolved model aliases: ${unresolvedModels
					.map((u) => `${u.name} uses '${u.model}' — run ${u.guidance}`)
					.join("; ")}`,
			);
		const oldPiAgents = path.join(os.homedir(), ".pi", "agent", "agents");
		let orphans = 0;
		try {
			const fspD = await import("node:fs/promises");
			orphans = (await fspD.readdir(oldPiAgents)).filter((n) =>
				n.endsWith(".md"),
			).length;
		} catch {
			/* dir absent */
		}
		if (orphans > 0) {
			checks.push({
				check: "no-orphan-personalities",
				ok: false,
				detail: `${orphans} in old ~/.pi/agent/agents`,
			});
			issues.push(
				`${orphans} personalities stranded in old path ~/.pi/agent/agents — move them to ~/.agents/agents`,
			);
		} else {
			checks.push({
				check: "no-orphan-personalities",
				ok: true,
				detail: "old path clean",
			});
		}
		// npm latest version (cached by default; --force/--refresh to hit network)
		const npm = await import("./npm-check.js");
		const offline =
			opts.offline ||
			opts.network === false ||
			process.env.AGENT_OFFLINE === "1";
		let upd;
		if ((opts.force || opts.refresh) && !offline) {
			upd = await npm.ensureUpdateCheck(cfg, PKG_NAME, VERSION, {
				force: true,
				offline,
			});
			if (upd.refreshed) await saveConfig(cfg);
		} else {
			upd = npm.readCachedUpdate(cfg, VERSION);
		}
		checks.push({
			check: "npm-update",
			ok: !upd.latest || upd.upToDate,
			detail: upd.latest
				? upd.upToDate
					? `latest ${upd.latest}`
					: `latest ${upd.latest} (installed ${VERSION})`
				: "unable to check",
		});
		if (upd.latest && !upd.upToDate)
			issues.push(
				`agent-cli ${upd.latest} is available (installed ${VERSION}).`,
			);
		// staged update payloads awaiting migration
		const seed = await import("./seed.js");
		const staged = await seed.listStagedUpdates({ home: AGENTS_DIR });
		checks.push({
			check: "staged-updates",
			ok: staged.length === 0,
			detail: staged.length ? `${staged.length} payload(s)` : "none",
		});
		if (staged.length)
			issues.push(
				`${staged.length} staged update payload(s) under ~/.agents/update-* — review with the user and migrate (see: agent update list).`,
			);

		let plan = null;
		let fix = null;
		if (opts.plan || opts.fixSafe) {
			const actMod = await import("./actions.js");
			const s = await actMod.collectState({ offline: true });
			plan = actMod.buildActions(s);
			if (opts.fixSafe) fix = actMod.applySafe(plan);
		}
		const out = {
			command: "doctor",
			issues,
			checks,
			...(plan ? { plan } : {}),
			...(fix ? { fix: { receipts: fix.receipts, applied: fix.applied, skipped: fix.skipped } } : {}),
		};
		emit(out);
		if (!JSON_MODE) {
			for (const ck of checks) {
				log.raw(
					`  ${ck.ok ? c.green("✓") : c.red("✗")} ${ck.check.padEnd(20)} ${c.gray(ck.detail)}`,
				);
			}
			if (issues.length) {
				log.raw("");
				for (const i of issues) log.warn(i);
			} else log.success("All checks passed.");
		}
		if (issues.length) process.exit(EXIT.WORK);
	});

// ---------------------------------------------------------------------------
// agent brief — AI session entrypoint (the `skill active` analogue)
// ---------------------------------------------------------------------------
program
	.command("brief")
	.description(
		"AI session brief: machine-readable state + suggested next actions.",
	)
	.option("--refresh", "force a fresh npm update check (writes config.json)")
	.option("--offline", "never hit the network; use the cached check only")
	.option("--no-network", "alias for --offline")
	.option(
		"--check",
		"exit 2 when suggested work exists, else 0 (CI/cron primitive)",
	)
	.option("--next", "emit only the highest-priority action")
	.option("--plan", "emit the full ordered action plan (default; no writes)")
	.option(
		"--apply-safe",
		"execute safeToAutomate actions, stop before user/destructive",
	)
	.option("--for <task>", "task-aware retrieval: attach relevant search hits (alias: --for-task)")
	.option(
		"--since <etag>",
		"return no actions when the state etag is unchanged (cache)",
	)
	.option("--oneline", "one-line status for shell prompts")
	.action(async (opts) => {
		const cfg = await loadConfig();
		const masterContent = await readMaster();
		const installed = await detectInstalled();
		const skill = skillVersion();
		const conMod = await import("./consolidate.js");
		const consG = conMod.assess({ scope: "global", cwd: process.cwd() });
		const consP = conMod.assess({ scope: "project", cwd: process.cwd() });
		const npm = await import("./npm-check.js");
		const offline =
			opts.offline ||
			opts.network === false ||
			process.env.AGENT_OFFLINE === "1";
		let upd;
		if (opts.refresh && !offline) {
			upd = await npm.ensureUpdateCheck(cfg, PKG_NAME, VERSION, {
				force: true,
				offline,
			});
			if (upd.refreshed) await saveConfig(cfg);
		} else {
			upd = npm.readCachedUpdate(cfg, VERSION);
		}
		const seed = await import("./seed.js");
		const stagedUpdates = await seed.listStagedUpdates({ home: AGENTS_DIR });
		const idMod = await import("./identity.js");
		const invG = await identityInventory({
			scope: "global",
			cwd: process.cwd(),
		});
		const projectBase = path.join(process.cwd(), ".agents");
		const invP =
			projectBase !== AGENTS_DIR
				? await identityInventory({
						scope: "project",
						cwd: process.cwd(),
					})
				: null;
		const modelsMod = await import("./models.js");
		const modelsMdPath = modelsMod.MODELS_MD;
		const modelsMdExists = await exists(modelsMdPath);
		const spectMod = await import("./spect.js");
		const spect = await spectMod.inspectSpect(process.cwd());
		const spectHeadline =
			spect.initialized || spect.partial
				? await spectMod.spectHeadline(process.cwd())
				: null;
		const { gapReport, archetypeNeeded, gapRecommended } =
			computeOnboarding(invG);
		const onboarding = {
			recommended: gapRecommended,
			archetypeNeeded,
			gaps: gapReport,
			...(archetypeNeeded ? idMod.onboardSuggest() : {}),
		};
		// F2: load manifest = global + project override + MODELS.md (precedence global → project).
		const sessionLoad = [];
		for (const gF of invG.files) {
			sessionLoad.push({
				kind: gF.kind,
				scope: "global",
				path: gF.path,
				exists: gF.exists,
				filled: gF.filled,
				gaps: gF.gaps,
			});
			if (invP) {
				const pF = invP.files.find((x) => x.kind === gF.kind);
				if (pF) {
					sessionLoad.push({
						kind: pF.kind,
						scope: "project",
						path: pF.path,
						exists: pF.exists,
						filled: pF.filled,
						gaps: pF.gaps,
					});
				}
			}
		}
		if (spect.initialized || spect.partial)
			for (const file of new Set([
				...(spect.load || []),
				...(spect.missingFiles || []),
			]))
				sessionLoad.push({
					kind: "spect",
					scope: "project",
					path: file,
					exists: !(spect.missingFiles || []).includes(file),
					filled: !(spect.missingFiles || []).includes(file),
					gaps: (spect.missingFiles || []).includes(file) ? ["missing"] : null,
				});
		// AX: surface the lesson index (filenames ARE the summaries) + inbox so the agent
		// actually loads memory at session start instead of only seeing a score. Also load the
		// LESSONS.md core DIRECTLY (critical-lesson pointer index) so it's never skipped.
		// Project lessons are included; project core takes precedence over global core.
		const { listLessons, coreFile } = await import("./lessons-lib.js");
		const lessonsIndex = (await listLessons({ includeProject: true }))
			.map((l) => ({
				path: l.path,
				scope: l.scope,
				occurrences: l.occurrences,
				marked: l.marked,
			}))
			.sort((a, b) => a.path.localeCompare(b.path));
		const inboxCount = (consG.metrics.inbox || 0) + (consP.metrics.inbox || 0);
		let coreContent = null;
		let coreScope = null;
		for (const scope of ["project", "global"]) {
			try {
				const md = await readFile(coreFile(scope, process.cwd()));
				const idx = md.indexOf("## Core");
				if (idx >= 0) {
					const cleaned = md
						.slice(idx + "## Core".length)
						.replace(/<!--[\s\S]*?-->/g, "")
						.trim();
					if (cleaned) {
						coreContent = cleaned;
						coreScope = scope;
						break;
					}
				}
			} catch {
				/* no core file */
			}
		}
		const unresolvedModels = await findUnresolvedModels();
		const pointerTargets = [];
		const drift = [];
		for (const id of cfg.global) {
			const t = getTarget(id);
			if (!t || !t.global) continue;
			const cls = await classify(t, "global");
			pointerTargets.push({
				id,
				scope: "global",
				state: cls.state,
				path: cls.path,
			});
			if (cls.state !== "pointer") drift.push(id);
		}
		// Structured executable actions (the session contract) + legacy strings.
		const actMod = await import("./actions.js");
		const actionsList = actMod.buildActions({
			masterContent,
			archetypeNeeded,
			pointerTargets,
			consG,
			consP,
			upd,
			stagedUpdates,
			inboxCount,
			unresolvedModels,
			liveCatalogAge: modelsMod.liveCatalogAgeDays(),
		});
		const suggested = actMod.suggestedStrings(actionsList);
		const etag = actMod.computeEtag({
			masterContent,
			drift,
			archetypeNeeded,
			unresolvedModels,
			consG,
			consP,
			stagedUpdates,
			inboxCount,
			upd,
		});
		// --for: task-aware retrieval (search over the brain). The option is
		// declared as '--for <task>' so commander exposes it as opts.for.
		let forTask = null;
		const taskQuery = opts.for || opts.forTask;
		if (taskQuery) {
			const searchMod = await import("./search.js");
			const sr = await searchMod.searchAll(taskQuery, { project: true });
			forTask = { query: taskQuery, hits: sr.results.slice(0, 5) };
		}
		// --apply-safe: run the safe prefix now, emit receipts, and exit.
		if (opts.applySafe) {
			const res = actMod.applySafe(actionsList);
			emit({
				command: "brief",
				applySafe: true,
				receipts: res.receipts,
				applied: res.applied,
				skipped: res.skipped,
				stoppedAt: res.stoppedAt,
			});
			if (!JSON_MODE)
				for (const r of res.receipts)
					log.raw(
						`  ${r.applied ? c.green("✓") : c.gray("·")} ${r.id}${r.skipped ? c.yellow(" (not safe)") : ""}`,
					);
			const attempted = res.receipts.filter((r) => !r.skipped);
			process.exit(attempted.some((r) => !r.applied) ? EXIT.ERROR : EXIT.OK);
		}

		const blockers = [];
		if (masterContent == null) blockers.push("master missing — run `agent init`");
		const warnings = [];
		if (archetypeNeeded) warnings.push("identity onboarding incomplete");
		if (unresolvedModels.length)
			warnings.push(`${unresolvedModels.length} unresolved model alias(es)`);
		if (consG.recommend || consP.recommend)
			warnings.push("lesson consolidation recommended");
		if (upd.latest && !upd.upToDate)
			warnings.push(`agent-cli ${upd.latest} available`);

		const out = {
			tool: "agent-cli",
			version: VERSION,
			schemaVersion: "1.1.0",
			health:
				masterContent == null ||
				drift.length > 0 ||
				archetypeNeeded ||
				unresolvedModels.length > 0
					? "degraded"
					: "ready",
			warnings,
			blockers,
			etag,
			actions: actionsList,
			...(forTask ? { forTask } : {}),
			master: {
				path: pretty(MASTER_FILE),
				absolute: MASTER_FILE,
				exists: masterContent != null,
				hasAgentCliBlock: hasAgentCliBlock(masterContent || ""),
			},
			enabledGlobal: cfg.global,
			installed,
			pointerTargets,
			drift,
			skill: {
				available: isSkillAvailable(),
				version: skill.version,
				source: skill.source,
			},
			suggestedActions: suggested,
			consolidation: {
				global: {
					score: consG.score,
					recommend: consG.recommend,
					reasons: consG.reasons,
					metrics: consG.metrics,
				},
				project: {
					score: consP.score,
					recommend: consP.recommend,
					reasons: consP.reasons,
					metrics: consP.metrics,
				},
			},
			update: {
				installedVersion: VERSION,
				latest: upd.latest,
				upToDate: upd.upToDate,
				checkedAt: upd.checkedAt,
				stagedUpdates,
			},
			onboarding,
			sessionStart: {
				load: sessionLoad,
			},
			lessons: {
				count: lessonsIndex.length,
				index: lessonsIndex,
				inbox: inboxCount,
				core: coreContent,
				coreScope,
			},
			modelAliases: {
				unresolved: unresolvedModels,
			},
			project: {
				spect,
				...(spectHeadline ? { spectHeadline } : {}),
			},
		};
		// --since: unchanged state → no actions (etag cache for cron/CI polling).
		if (opts.since && opts.since === etag) {
			out.actions = [];
			out.suggestedActions = [];
			out.unchanged = true;
		}
		// --next: highest-priority action only.
		if (opts.next) out.actions = out.actions.length ? [out.actions[0]] : [];
		if (opts.oneline) {
			const onelineText = `v${VERSION} ${out.health === "ready" ? "✓" : "!"} ${out.actions.length} action${out.actions.length === 1 ? "" : "s"}${out.drift.length ? ` drift:${out.drift.join(",")}` : ""}`;
			// Default: print the plain oneline text to stdout (so shell prompts
			// can use it via $(agent brief --oneline)). Under --json, emit the
			// JSON envelope (data.onelineText) and don't pollute stdout.
			if (JSON_MODE) {
				emit({
					command: "brief",
					oneline: true,
					onelineText,
					health: out.health,
					actions: out.actions.length,
					drift: out.drift.length,
				});
			} else {
				process.stdout.write(onelineText + "\n");
			}
			if (opts.check) process.exit(out.actions.length ? EXIT.WORK : EXIT.OK);
			return;
		}
	emit(out);
	if (!JSON_MODE) {
		if (archetypeNeeded) {
				log.warn("Onboarding needed — ask the user (one question):");
				log.raw(c.bold(onboarding.question));
				log.raw(
					`  ${c.gray("(" + onboarding.options.map((o) => o.key).join(" | ") + ")")}`,
				);
				log.dim(
					"Then: agent identity apply <choice> [--soul <v>]. Other missing fields: agent identity/soul/user set <field> <value>.",
				);
			} else if (gapRecommended) {
				const gapStr = Object.entries(gapReport)
					.map(([k, v]) => `${k}: ${v.join(", ")}`)
					.join("; ");
				log.warn(
					`Information gap: ${c.yellow(gapStr)} — fill these (one Run line per field):`,
				);
				for (const hint of actMod.gapFixHints(gapReport)) {
					log.raw(`  ${c.cyan("Run:")} ${hint}`);
				}
			}
			if (unresolvedModels.length) {
				log.warn(
					`Unresolved model alias${unresolvedModels.length > 1 ? "es" : ""}:`,
				);
				for (const u of unresolvedModels) {
					const scope = u.scope ? c.gray(`[${u.scope}]`) : "";
					log.raw(
						`  ${c.bold(u.name)} ${scope}: ${c.yellow(u.model)} — ${c.cyan(u.guidance)}`,
					);
				}
			}
			log.kv(
				"master",
				out.master.exists
					? c.green("✓") + " " + out.master.path
					: c.red("✗ missing"),
			);
			log.kv(
				"pointers",
				`${pointerTargets.filter((p) => p.state === "pointer").length}/${pointerTargets.length} ok`,
			);
			log.kv(
				"skill-cli",
				out.skill.available
					? c.green("✓") + " " + (out.skill.version ?? "")
					: c.red("✗"),
			);
			log.kv(
				"drift",
				drift.length ? c.yellow(drift.join(", ")) : c.green("none"),
			);
			log.kv(
				"consolidation",
				`score ${consG.score}${consG.recommend ? " ⚠" : ""} (global)${consP.recommend ? `, ${consP.score} ⚠ (project)` : ""}`,
			);
			log.kv(
				"update",
				upd.latest
					? upd.upToDate
						? c.green("up to date") + " " + c.gray("(" + upd.latest + ")")
						: c.yellow(upd.latest + " available")
					: c.gray("unknown"),
			);
			if (stagedUpdates.length)
				log.kv(
					"staged",
					c.yellow(`${stagedUpdates.length} payload(s) — agent update list`),
				);
			// AX: tell the agent exactly what to read now, and surface the lesson index.
			log.raw(c.bold("\nLoad at session start (global → project override):"));
			for (const f of out.sessionStart.load) {
				let tag;
				if (!f.exists) tag = c.gray("(missing)");
				else if (f.filled === false || (f.gaps && f.gaps.length))
					tag = c.yellow(`(gap: ${(f.gaps || []).join(", ") || "unfilled"})`);
				else tag = c.green("✓");
				const kindLabel = f.scope === "project" ? `${f.kind} (proj)` : f.kind;
				log.raw(`  ${kindLabel.padEnd(18)} ${pretty(f.path)}  ${tag}`);
			}
			if (spect.initialized) {
				log.raw(c.bold("\nSPECT project workflow:"));
				log.raw(
					`  ${pretty(spect.root)} — ${spect.counts.specs} specs, ${spect.counts.plans} plans, ${spect.counts.tasks} tasks`,
				);
			} else {
				log.dim(
					"\nSPECT: not initialized (run agent spect init when using spec-driven work)",
				);
			}
			if (coreContent) {
				log.raw(c.bold("\nCore lessons (always-on — LESSONS.md):"));
				for (const line of coreContent.split("\n"))
					if (line.trim()) log.raw(`  ${line}`);
			}
			if (lessonsIndex.length) {
				log.raw(
					c.bold("\nLessons (filenames = summaries; read only relevant):"),
				);
				for (const l of lessonsIndex)
					log.raw(
						`  ${c.gray("×" + l.occurrences)} ${l.path}${l.marked ? c.yellow(" ⚠marked") : ""}`,
					);
			}
			if (inboxCount)
				log.dim(
					`inbox: ${inboxCount} raw capture(s) — triage: agent lessons inbox`,
				);
			if (suggested.length) log.raw(c.bold("\nSuggested:"));
			for (const s of suggested) log.raw(`  ${c.cyan(s)}`);
			if (!suggested.length && !gapRecommended)
				log.success("Everything in sync.");
		}
		if (opts.check) process.exit(out.actions.length ? EXIT.WORK : EXIT.OK);
	});

// ---------------------------------------------------------------------------
// agent run / agent action verify — execute the session contract
// ---------------------------------------------------------------------------
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
