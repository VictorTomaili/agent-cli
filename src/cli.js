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

function selectedTargets(scope, ids) {
	const pool = targetsWithScope(scope);
	if (ids && ids.length) {
		const set = new Set(ids);
		return pool.filter((t) => set.has(t.id));
	}
	return pool;
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
	ctxPaths,
	isJson: () => JSON_MODE,
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
		const masterPointer = await ensureMasterPointer({
			masterAbs: MASTER_FILE,
			masterTilde: mTildeForPointer,
			force: !!opts.force,
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
// agent link / unlink
// ---------------------------------------------------------------------------
program
	.command("link")
	.description(
		"(Re)write pointer stubs to enabled agents. Idempotent. Edit the master anytime — no re-link needed.",
	)
	.option("-g, --global", "Home (~) scope only")
	.option("-p, --project", "Current project (./) scope only")
	.option("-t, --target <ids...>", "Restrict to target ids")
	.option("--force", "Overwrite native (non-pointer) content (destructive)")
	.option("--overwrite", "alias for --force")
	.action(async (opts) => {
		const cfg = await loadConfig();
		if (opts.global && opts.project)
			fail("Use either -g/--global or -p/--project, not both", { command: "link" });
		if (opts.target) {
			const known = new Set(TARGETS.map((t) => t.id));
			const unknown = opts.target.filter((id) => !known.has(id));
			if (unknown.length)
				fail(
					`Unknown target id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Known ids: ${[...known].sort().join(", ")}`,
					{ command: "link", target: unknown },
				);
		}
		const scopes = [];
		if (opts.global) scopes.push("global");
		if (opts.project) scopes.push("project");
		if (scopes.length === 0) scopes.push("global");
		const out = { command: "link", scopes, results: [] };
		for (const scope of scopes) {
			let ids = opts.target;
			if (!ids)
				ids = scope === "global" ? cfg.global : effectiveProjectIds(cfg);
			const targets = selectedTargets(scope, ids);
			// Project pointers must redirect to the project master, not the global one.
			const { masterAbs, masterTilde } = masterPaths(scope);
			setExpectedCtx({ masterAbs, masterTilde });
			for (const t of targets) {
				const r = await linkTarget(t, scope, {
					masterAbs,
					masterTilde,
					force: !!opts.force || !!opts.overwrite,
				});
				out.results.push({ id: t.id, name: t.name, scope, ...r });
			}
		}
		out.changed = out.results.some((r) => r.linked);
		out.nothingToDo = out.results.every((r) => !r.linked);
		emit(out);
		if (!JSON_MODE) {
			const linked = out.results.filter((r) => r.linked).length;
			const ok = out.results.filter((r) => r.unchanged).length;
			const blocked = out.results.filter((r) => r.blocked);
			log.success(`${linked} linked, ${ok} up-to-date`);
			if (blocked.length)
				for (const b of blocked)
					log.warn(`${b.name}: native content — pull first or use --overwrite`);
		}
	});

program
	.command("unlink")
	.description("Remove pointer stubs (only deletes files that are pointers).")
	.option("-g, --global")
	.option("-p, --project")
	.option("-t, --target <ids...>")
	.action(async (opts) => {
		const cfg = await loadConfig();
		if (opts.global && opts.project)
			fail("Use either -g/--global or -p/--project, not both", { command: "unlink" });
		if (opts.target) {
			const known = new Set(TARGETS.map((t) => t.id));
			const unknown = opts.target.filter((id) => !known.has(id));
			if (unknown.length)
				fail(
					`Unknown target id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Known ids: ${[...known].sort().join(", ")}`,
					{ command: "unlink", target: unknown },
				);
		}
		const scopes = [];
		if (opts.global) scopes.push("global");
		if (opts.project) scopes.push("project");
		if (scopes.length === 0) scopes.push("global");
		const out = { command: "unlink", scopes, results: [] };
		for (const scope of scopes) {
			let ids = opts.target;
			if (!ids)
				ids = scope === "global" ? cfg.global : effectiveProjectIds(cfg);
			const targets = selectedTargets(scope, ids);
			// unlinkTarget classifies via expectedCtx() — keep it in sync with scope.
			const { masterAbs, masterTilde } = masterPaths(scope);
			setExpectedCtx({ masterAbs, masterTilde });
			for (const t of targets) {
				const r = await unlinkTarget(t, scope);
				out.results.push({ id: t.id, name: t.name, scope, ...r });
			}
		}
		out.changed = out.results.some((r) => r.unlinked);
		out.nothingToDo = out.results.every((r) => !r.unlinked);
		emit(out);
		if (!JSON_MODE) {
			const n = out.results.filter((r) => r.unlinked).length;
			log.success(`${n} pointer stubs removed`);
		}
	});

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
// ---------------------------------------------------------------------------
program
	.command("status")
	.description(
		"Show master state, per-target pointer health, and skill-cli state. Use --all for the full catalog.",
	)
	.option(
		"--all",
		"include every known target; default shows installed, enabled, or unhealthy targets",
	)
	.action(async (opts) => {
		const showAll = !!opts.all;
		const cfg = await loadConfig();
		const masterContent = await readMaster();
		const skill = skillVersion();
		const targets = [];
		for (const t of TARGETS) {
			const installed = (await detectInstalled()).includes(t.id);
			const gEnabled = isGlobalEnabled(cfg, t.id);
			const gcls = t.global ? await classify(t, "global") : null;
			targets.push({
				id: t.id,
				name: t.name,
				installed,
				globalEnabled: gEnabled,
				projectEnabled: isProjectEnabled(cfg, t.id),
				global: gcls ? { path: gcls.path, state: gcls.state } : null,
				project: t.project ? pathFor(t, "project") : null,
			});
		}
		const visibleTargets = showAll
			? targets
			: targets.filter(
					(t) =>
						t.installed ||
						t.globalEnabled ||
						t.projectEnabled ||
						(t.global && t.global.state !== "pointer"),
				);
		const out = {
			command: "status",
			master: {
				path: MASTER_FILE,
				exists: masterContent != null,
				hasAgentCliBlock: hasAgentCliBlock(masterContent || ""),
				size: masterContent ? masterContent.length : 0,
			},
			config: {
				global: cfg.global,
				project: cfg.project,
				version: cfg.version,
			},
			skill: skill,
			targets: visibleTargets,
			targetCount: targets.length,
			all: showAll,
			targetsSummary: {
				pointer: visibleTargets.filter(
					(t) => t.global?.state === "pointer",
				).length,
				missing: visibleTargets.filter(
					(t) => t.global?.state === "missing",
				).length,
				stale: visibleTargets.filter(
					(t) => t.global?.state === "pointer-stale",
				).length,
				native: visibleTargets.filter(
					(t) => t.global?.state === "native",
				).length,
			},
		};
		emit(out);
		if (!JSON_MODE) {
			log.raw(`${c.bold("agent-cli")} ${c.gray("v" + VERSION)}`);
			log.kv(
				"master",
				c.cyan(pretty(MASTER_FILE)) +
					(out.master.exists ? c.green(" ✓") : c.red(" ✗ missing")),
			);
			log.kv(
				"skill-cli",
				`${skill.version ?? "none"} ${c.gray("(" + skill.source + ")")}`,
			);
			log.raw(c.bold("\nTargets:"));
			for (const t of visibleTargets) {
				const state = t.global?.state;
				const tag =
					state === "pointer"
						? c.green("●")
						: state === "native"
							? c.yellow("●")
							: state === "missing"
								? c.gray("○")
								: state === "pointer-stale"
									? c.yellow("○")
									: c.gray("○");
				const label =
					state === "pointer"
						? c.green("pointer")
						: state === "native"
							? c.yellow("native")
							: state === "missing"
								? c.gray("absent")
								: state === "pointer-stale"
									? c.yellow("stale")
									: c.gray("—");
				const en = t.globalEnabled ? c.green("on") : c.gray("off");
				log.raw(
					`  ${tag} ${c.bold(t.id.padEnd(9))} ${t.name.padEnd(30)} ${en} ${label.padEnd(8)} ${c.gray(t.global?.path ? pretty(t.global.path) : "(no global)")}`,
				);
			}
			const s = out.targetsSummary;
			log.dim(
				s.pointer + s.missing + s.stale + s.native === 0
					? "no targets"
					: `${s.pointer} pointer · ${s.missing} absent · ${s.stale} stale (need re-link) · ${s.native} native (user content)`,
			);
		}
	});

program
	.command("targets")
	.description("List all known agent targets.")
	.action(async () => {
		const installed = new Set(await detectInstalled());
		const cfg = await loadConfig();
		const rows = TARGETS.map((t) => ({
			id: t.id,
			name: t.name,
			installed: installed.has(t.id),
			globalEnabled: isGlobalEnabled(cfg, t.id),
			global: t.global,
			project: t.project,
			docs: t.docs,
		}));
		emit({ command: "targets", count: rows.length, targets: rows });
		if (!JSON_MODE) {
			for (const t of rows) {
				const mark = t.installed ? c.green("✓") : c.gray(" ");
				const en = t.globalEnabled ? c.green("on") : c.gray("off");
				log.raw(
					`  ${mark} ${c.bold(t.id.padEnd(9))} ${t.name.padEnd(34)} ${en} ${c.gray(t.global ? "~/" + t.global : "(project only)")}`,
				);
			}
			log.dim(`${rows.length} targets — ${installed.size} detected installed`);
		}
	});

// ---------------------------------------------------------------------------
// agent edit / pull / where
// ---------------------------------------------------------------------------
program
	.command("edit [kind]")
	.description(
		"Open a unified home file in $EDITOR. kind: agents (default) | soul | identity | user | lessons | environments | models",
	)
	.option("--print-path", "Just print the resolved path and exit (creates no file)")
	.option(
		"-p, --project",
		"Edit the project-local copy (master resolves to [cwd]/.agents/AGENTS.md)",
	)
	.action(async (kind, opts) => {
		const scope = opts.project ? "project" : "global";
		let target = scope === "project" ? projectMasterPath() : MASTER_FILE;
		if (kind === "models") {
			const modelsMod = await import("./models.js");
			target = modelsMod.MODELS_MD;
			if (!opts.printPath && !(await exists(target))) modelsMod.writeModelsMd();
		} else if (kind && kind !== "agents") {
			target = identityFilePath(kind, scope);
			if (!target) {
				fail(
					`Unknown kind: ${kind}. Use: agents|soul|identity|user|lessons|environments|models`,
				);
			}
			// --print-path only computes the path — it must not create the file.
			if (!opts.printPath && !(await exists(target))) {
				const arc = await import("./archetypes.js");
				let tpl = `# ${kind.toUpperCase()}.md\n\n`;
				if (kind === "identity") tpl = arc.identityContent("general-purpose");
				else if (kind === "soul") tpl = arc.soulContent("pragmatist");
				else if (kind === "user") tpl = arc.userContent();
				await writeFile(target, tpl);
			}
		}
		if (opts.printPath) {
			// Exactly one JSON value on stdout in JSON mode; no path mixed in.
			if (JSON_MODE)
				emit({
					command: "edit",
					kind: kind || "agents",
					path: target,
					printPath: true,
				});
			else process.stdout.write(target + "\n");
			return;
		}
		emit({ command: "edit", kind: kind || "agents", path: target });
		const editor =
			process.env.VISUAL ||
			process.env.EDITOR ||
			(process.platform === "win32" ? "notepad" : "vi");
		const r = spawnSync(editor, [target], { stdio: "inherit", shell: true });
		// Editor failures must surface as a non-zero exit.
		if (r.error || r.status !== 0)
			process.exit(r.status != null ? r.status : 1);
	});

program
	.command("agents [action] [name] [rest...]")
	.description(
		"Manage reusable sub-agent personalities: list | show | new | validate | path | roster | edit | rename | remove | export | import | delegate",
	)
	.option("-p, --project", "project-local scope (for new)")
	.option("--name <name>", "(import) override the personality name")
	.option("--task <text>", "(delegate) task text for the delegation prompt")
	.action(async (action, name, rest, opts) => {
		action = action || "list";
		const cwd = process.cwd();
		if (action === "list") {
			const list = await listAgents({ includeProject: true, cwd });
			emit({ command: "agents", action, count: list.length, agents: list });
			if (!JSON_MODE) {
				if (!list.length)
					log.warn(
						"No personalities yet — create one: agent agents new <name>",
					);
				for (const a of list)
					log.raw(
						`${a.scope === "project" ? c.cyan("[proj]") : c.gray("[glob]")} ${c.bold(a.name.padEnd(16))} ${a.description}`,
					);
			}
			return;
		}
		if (action === "show") {
			if (!name) {
				fail("Usage: agent agents show <name>");
			}
			const a = await showAgent(name, { cwd });
			if (!a) {
				fail(`No agent named '${name}'`);
			}
			const fsp = (await import("node:fs/promises")).default;
			const content = await fsp.readFile(a.path, "utf8");
			if (JSON_MODE) emit({ command: "agents", action, agent: a, content });
			else process.stdout.write(content);
			return;
		}
		if (action === "new") {
			if (!name) {
				fail("Usage: agent agents new <name>");
			}
			const r = await scaffoldAgent(name, {
				scope: opts.project ? "project" : "global",
				cwd,
			});
			emit({ command: "agents", action, name, ...r });
			if (!JSON_MODE)
				log.success(`${r.created ? "Created" : "Exists"}: ${pretty(r.path)}`);
			return;
		}
		if (action === "path") {
			const out = { global: GLOBAL_AGENTS_DIR, project: projectAgentsDir(cwd) };
			emit({ command: "agents", action, ...out });
			if (!JSON_MODE) {
				log.kv("global", pretty(out.global));
				log.kv("project", pretty(out.project));
			}
			return;
		}
		if (action === "validate") {
			const list = await listAgents({ includeProject: true, cwd });
			let targets;
			let missing = null;
			if (name) {
				targets = list.filter((a) => a.name === name);
				if (!targets.length) {
					missing = name;
					targets = [];
				}
			} else {
				targets = list;
			}
			const results = [];
			for (const a of targets) results.push(await validateAgent(a.path));
			const valid = results.length > 0 && results.every((r) => r.valid);
			const out = {
				command: "agents",
				action: "validate",
				valid,
				count: results.length,
				results,
			};
			if (missing) out.missing = missing;
			emit(out);
			if (!JSON_MODE) {
				if (missing) log.error(`No agent named '${missing}'`);
				for (const r of results) {
					const issueText = r.issues.length
						? c.gray(r.issues.join("; "))
						: c.green("ok");
					const warningText = r.warnings?.length
						? c.yellow(" — " + r.warnings.join("; "))
						: "";
					log.raw(
						`  ${r.valid ? c.green("✓") : c.red("✗")} ${c.bold(r.name)} ${issueText}${warningText}`,
					);
				}
			}
			// Machine-actionable failure: invalid or missing personalities exit non-zero.
			if (!valid) process.exit(1);
			return;
		}
		if (action === "roster") {
			const agentsList = await listAgents({ includeProject: true, cwd });
			const modelsMod = await import("./models.js");
			const aliases = modelsMod.getAliases();
			const rows = agentsList.map((a) => ({
				...a,
				resolvedModel: a.model ? (aliases[a.model]?.model ?? null) : null,
				aliasResolved: a.model ? Boolean(aliases[a.model]) : true,
			}));
			emit({ command: "agents", action: "roster", count: rows.length, agents: rows });
			if (!JSON_MODE)
				for (const r of rows)
					log.raw(
						`  ${c.bold(r.name.padEnd(16))} ${r.model ?? c.gray("—")} → ${r.resolvedModel ?? c.yellow("UNRESOLVED")} ${c.gray("(" + r.scope + ")")}`,
					);
			return;
		}
		if (action === "edit") {
			if (!name) fail("Usage: agent agents edit <name>");
			const a = await showAgent(name, { cwd });
			if (!a) fail(`No agent named '${name}'`);
			emit({ command: "agents", action: "edit", name, path: a.path });
			const editor =
				process.env.VISUAL ||
				process.env.EDITOR ||
				(process.platform === "win32" ? "notepad" : "vi");
			const r = spawnSync(editor, [a.path], { stdio: "inherit", shell: true });
			if (r.error || r.status !== 0) process.exit(r.status != null ? r.status : 1);
			return;
		}
		if (action === "rename") {
			const [newName] = rest || [];
			if (!name || !newName) fail("Usage: agent agents rename <old> <new>");
			const a = await showAgent(name, { cwd });
			if (!a) fail(`No agent named '${name}'`);
			const content = await (await import("./util.js")).readFile(a.path);
			const updated = content.replace(
				/^name:\s*.*$/m,
				`name: ${newName}`,
			);
			const fspMod = await import("node:fs/promises");
			const newPath = path.join(path.dirname(a.path), `${newName}.md`);
			await fspMod.writeFile(newPath, updated, "utf8");
			if (newPath !== a.path) await fspMod.rm(a.path, { force: true });
			emit({ command: "agents", action: "rename", from: name, to: newName, path: newPath });
			if (!JSON_MODE) log.success(`Renamed '${name}' → '${newName}' (${pretty(newPath)})`);
			return;
		}
		if (action === "remove") {
			if (!name) fail("Usage: agent agents remove <name>");
			const a = await showAgent(name, { cwd });
			if (!a) fail(`No agent named '${name}'`);
			const fspMod = await import("node:fs/promises");
			await fspMod.rm(a.path, { force: true });
			emit({ command: "agents", action: "remove", name, path: a.path });
			if (!JSON_MODE) log.success(`Removed ${pretty(a.path)}`);
			return;
		}
		if (action === "export") {
			if (!name) fail("Usage: agent agents export <name>");
			const a = await showAgent(name, { cwd });
			if (!a) fail(`No agent named '${name}'`);
			const fspMod = await import("node:fs/promises");
			const content = await fspMod.readFile(a.path, "utf8");
			if (JSON_MODE) emit({ command: "agents", action: "export", name, path: a.path, content });
			else process.stdout.write(content);
			return;
		}
		if (action === "import") {
			if (!name) fail("Usage: agent agents import <path.md> [--name <new>]");
			const fspMod = await import("node:fs/promises");
			const content = await fspMod.readFile(name, "utf8");
			let finalName = opts.name || name;
			const m = /^name:\s*(\S+)/m.exec(content);
			if (m && !opts.name) finalName = m[1];
			const targetDir = projectAgentsDir(cwd);
			await (await import("./util.js")).ensureDir(targetDir);
			const target = path.join(targetDir, `${finalName}.md`);
			await fspMod.writeFile(target, content, "utf8");
			emit({ command: "agents", action: "import", name: finalName, path: target });
			if (!JSON_MODE) log.success(`Imported '${finalName}' → ${pretty(target)}`);
			return;
		}
		if (action === "delegate") {
			if (!name) fail("Usage: agent agents delegate prepare <name> --task <text>");
			const a = await showAgent(name, { cwd });
			if (!a) fail(`No agent named '${name}'`);
			const fspMod = await import("node:fs/promises");
			const content = await fspMod.readFile(a.path, "utf8");
			const task = opts.task || "(task not provided)";
			const prompt = [
				`You are delegating to the "${name}" sub-agent.`,
				`Description: ${a.description}`,
				a.model ? `Model alias: ${a.model}` : null,
				"",
				"## Task",
				task,
				"",
				"## Personality (embed for the sub-agent)",
				content,
			]
				.filter(Boolean)
				.join("\n");
			emit({ command: "agents", action: "delegate", name, task, prompt });
			if (!JSON_MODE) process.stdout.write(prompt + "\n");
			return;
		}
		fail(`Unknown action: ${action}. Use list|show|new|validate|path|roster|edit|rename|remove|export|import|delegate`);
	});

program
	.command("identity [action] [rest...]")
	.description(
		"Identity archetypes: list | apply <id> [--soul <v>] | set <section> <value...>. -p project.",
	)
	.option("-p, --project", "project scope")
	.option("--soul <variant>", "also apply this soul variant")
	.option(
		"--fallback",
		"apply the default archetype for an unknown id (both modes)",
	)
	.action(async (action, rest, opts) => {
		const id = await import("./identity.js");
		action = action || "list";
		const scope = opts.project ? "project" : "global";
		const cwd = process.cwd();
		if (action === "list") {
			emit({
				command: "identity",
				action,
				identities: id.listIdentities(),
				souls: id.listSouls(),
			});
			if (!JSON_MODE) {
				log.raw(c.bold("Identities:"));
				for (const i of id.listIdentities())
					log.raw(`  ${c.bold(i.key.padEnd(18))} ${i.label}`);
				log.raw(c.bold("Souls:"));
				for (const s of id.listSouls())
					log.raw(`  ${c.bold(s.key.padEnd(18))} ${s.label}`);
			}
			return;
		}
		if (action === "apply") {
			const key = rest[0];
			if (!key) {
				fail("Usage: agent identity apply <id>");
			}
			const known = id.listIdentities().some((i) => i.key === key);
			const resolved = known ? null : "general-purpose";
			if (!known && !opts.fallback) {
				fail(
					`Unknown identity '${key}' (would resolve to default 'general-purpose'). Pass --fallback to apply it. Use: agent identity list`,
					{ command: "identity", action, key },
				);
			}
			const pre = await preSnapshot("identity-apply");
			const r = await id.applyIdentity(key, { scope, cwd });
			let soul = null;
			if (opts.soul) {
				const sr = await id.applySoul(opts.soul, { scope, cwd });
				soul = sr.soul;
			}
			emit({
				command: "identity",
				action,
				...r,
				soul,
				...(pre ? { preSnapshot: pre } : {}),
				...(known ? {} : { fallback: true, resolved }),
			});
			if (!JSON_MODE)
				log.success(
					`Identity '${key}'${soul ? ` + soul '${soul}'` : ""} → ${pretty(r.file)}`,
				);
			return;
		}
		if (action === "set") {
			const [section, ...val] = rest;
			if (!section) {
				fail("Usage: agent identity set <section> <value...>");
			}
			const f = await id.setSection(
				id.idFile(scope, cwd),
				section,
				val.join(" "),
			);
			emit({ command: "identity", action, file: f });
			if (!JSON_MODE) log.success(`Updated ${pretty(f)}`);
			return;
		}
		fail(`Unknown action: ${action}. Use list|apply|set`);
	});

program
	.command("soul [action] [rest...]")
	.description(
		"Soul variants: list | apply <variant> | set <section> <value...>. -p project.",
	)
	.option("-p, --project", "project scope")
	.option(
		"--fallback",
		"apply the default variant for an unknown id (both modes)",
	)
	.action(async (action, rest, opts) => {
		const id = await import("./identity.js");
		action = action || "list";
		const scope = opts.project ? "project" : "global";
		const cwd = process.cwd();
		if (action === "list") {
			emit({ command: "soul", action, souls: id.listSouls() });
			if (!JSON_MODE)
				for (const s of id.listSouls())
					log.raw(`  ${c.bold(s.key.padEnd(14))} ${s.label}`);
			return;
		}
		if (action === "apply") {
			const key = rest[0];
			if (!key) {
				fail("Usage: agent soul apply <variant>");
			}
			const known = id.listSouls().some((s) => s.key === key);
			const resolved = known ? null : "pragmatist";
			if (!known && !opts.fallback) {
				fail(
					`Unknown soul '${key}' (would resolve to default 'pragmatist'). Pass --fallback to apply it. Use: agent soul list`,
					{ command: "soul", action, key },
				);
			}
			const pre = await preSnapshot("soul-apply");
			const r = await id.applySoul(key, { scope, cwd });
			emit({
				command: "soul",
				action,
				...r,
				...(pre ? { preSnapshot: pre } : {}),
				...(known ? {} : { fallback: true, resolved }),
			});
			if (!JSON_MODE) log.success(`Soul '${key}' → ${pretty(r.file)}`);
			return;
		}
		if (action === "set") {
			const [section, ...val] = rest;
			if (!section) {
				fail("Usage: agent soul set <section> <value...>");
			}
			const f = await id.setSection(
				id.soulFile(scope, cwd),
				section,
				val.join(" "),
			);
			emit({ command: "soul", action, file: f });
			if (!JSON_MODE) log.success(`Updated ${pretty(f)}`);
			return;
		}
		fail(`Unknown action: ${action}. Use list|apply|set`);
	});

program
	.command("user [action] [rest...]")
	.description(
		"USER.md: apply (write template; --force replaces an existing file) | set <field> <value...>. -p project.",
	)
	.option("-p, --project", "project scope")
	.option("--force", "overwrite an existing non-empty USER.md")
	.option("--replace", "alias for --force")
	.action(async (action, rest, opts) => {
		const id = await import("./identity.js");
		const arc = await import("./archetypes.js");
		action = action || "apply";
		const scope = opts.project ? "project" : "global";
		const cwd = process.cwd();
		const file = identityFilePath("user", scope, cwd);
		const replace = opts.force || opts.replace;
		if (action === "apply") {
			if (!replace && (await exists(file))) {
				const existing = await readFile(file);
				if (existing && existing.trim()) {
					fail(
						`USER.md already exists (${pretty(file)}). Pass --force to replace it.`,
					);
				}
			}
			await writeFile(file, arc.userContent());
			emit({ command: "user", action, file });
			if (!JSON_MODE) log.success(`USER.md template → ${pretty(file)}`);
			return;
		}
		if (action === "set") {
			const [section, ...val] = rest;
			if (!section) {
				fail("Usage: agent user set <field> <value...>");
			}
			const f = await id.setSection(file, section, val.join(" "));
			emit({ command: "user", action, file: f });
			if (!JSON_MODE) log.success(`Updated ${pretty(f)}`);
			return;
		}
		fail(`Unknown action: ${action}. Use apply|set`);
	});

program
	.command("onboard [action]")
	.description(
		"Identity onboarding: suggest (the one question + options for the agent to ask the user).",
	)
	.action(async (action) => {
		const id = await import("./identity.js");
		action = action || "suggest";
		if (action === "suggest") {
			const s = id.onboardSuggest();
			emit({ command: "onboard", ...s });
			if (!JSON_MODE) {
				log.raw(c.bold(s.question));
				log.dim(
					`Default: ${s.default}. Ask the user, then: agent identity apply <choice>`,
				);
			}
			return;
		}
		fail(`Unknown action: ${action}. Use suggest`);
	});

program
	.command("models [action] [rest...]")
	.description(
		"Model aliases (global ~/.agents/MODELS.md; project scope is not supported): list | set <alias> <provider/model> [--category c] [--thinking lvl] [--fallback <provider/model>...] | resolve <alias> | write | suggest [--apply] | research [--refresh] | lint | usage | test <alias>. Bundled curated catalog + auto-pick per category.",
	)
	.option("--category <c>", "category for set")
	.option("--thinking <lvl>", "thinking level for set")
	.option(
		"--fallback <models...>",
		"ordered fallback provider/model values for API/rate/usage failures",
	)
	.option("--apply", "(suggest) write the auto-picked model for each unresolved alias")
	.option("--refresh", "(research) rewrite the catalog section in MODELS.md with the bundled baseline")
	.action(async (action, rest, opts) => {
		const m = await import("./models.js");
		action = action || "list";
		if (action === "list") {
			emit({
				command: "models",
				action,
				aliases: m.getAliases(),
				categories: m.CATEGORIES,
			});
			if (!JSON_MODE)
				for (const [name, v] of Object.entries(m.getAliases()))
					log.raw(
						`  ${c.bold(name.padEnd(14))} ${c.gray(v.category)} ${v.model} ${v.thinking ? c.gray("@" + v.thinking) : ""}`,
					);
			return;
		}
		if (action === "set") {
			const [alias, model] = rest;
			if (!alias || !model) {
				fail("Usage: agent models set <alias> <provider/model>");
			}
			const r = m.setAlias(alias, {
				model,
				category: opts.category,
				thinking: opts.thinking,
				fallbacks: opts.fallback,
			});
			// Keep MODELS.md in sync with the alias configuration.
			m.writeModelsMd();
			emit({
				command: "models",
				action,
				alias,
				...r,
				modelsMd: m.MODELS_MD,
			});
			if (!JSON_MODE)
				log.success(
					`Alias '${alias}' → ${r.model}${r.thinking ? " @" + r.thinking : ""}`,
				);
			return;
		}
		if (action === "resolve") {
			const alias = rest[0];
			const r = alias ? m.getAlias(alias) : null;
			if (!r)
				fail(`No such model alias: '${alias}'`, {
					command: "models",
					action,
					alias,
				});
			emit({ command: "models", action, alias, resolved: r });
			if (!JSON_MODE)
				log.raw(
					`${alias} → ${r.model}${r.thinking ? " @" + r.thinking : ""}`,
				);
			return;
		}
		if (action === "write") {
			const f = m.writeModelsMd();
			emit({ command: "models", action, file: f });
			if (!JSON_MODE) log.success(`Wrote ${pretty(f)}`);
			return;
		}
		if (action === "research") {
			// 'research' is the agent-facing entry point: the agent (or human) can
			// run this to refresh MODELS.md's curated catalog section after a web
			// investigation. Without --refresh, this is a dry run that reports
			// what would change.
			const f = await readIfExists(m.MODELS_MD);
			const before = f || "";
			const want = m.catalogMarkdown();
			const hasCatalog = before.includes("## Curated model catalog");
			if (!hasCatalog || opts.refresh) {
				const out = m.writeModelsMd({ includeCatalog: true });
				emit({ command: "models", action: "research", refreshed: true, file: out });
				if (!JSON_MODE)
					log.success(`Refreshed catalog in ${pretty(out)} (${m.CATALOG.length} entries).`);
			} else {
				emit({
					command: "models",
					action: "research",
					refreshed: false,
					count: m.CATALOG.length,
					diff: "catalog section already present; pass --refresh to overwrite",
				});
				if (!JSON_MODE)
					log.info(
						`Catalog section already present (${m.CATALOG.length} entries). Pass --refresh to overwrite, or edit the markdown directly to reflect new research.`,
					);
			}
			return;
		}
		if (action === "suggest") {
			const unresolved = await findUnresolvedModels();
			const cfg = await loadConfig();
			const preferredProviders = cfg.providers || [];
			const agents = await listAgents({ includeProject: true });
			const personaByName = new Map(agents.map((a) => [a.id, a]));
			// Group personas that share the same alias (e.g. all 6 reviewers
			// share 'review-model'); one pick serves them all.
			const byAlias = new Map();
			for (const u of unresolved) {
				const arr = byAlias.get(u.model) || [];
				arr.push(u);
				byAlias.set(u.model, arr);
			}
			const rows = [];
			const shared = [];
			for (const [alias, personas] of byAlias) {
				// Derive a category from the alias name (strip "-model" suffix)
				// or fall back to the persona's configured category.
				const hint = String(alias).replace(/-model$/, "").toLowerCase();
				let category = m.CATEGORIES.includes(hint) ? hint : null;
				if (!category) {
					for (const p of personas) {
						const cfgForPersona = m.getAlias(p.name);
						if (cfgForPersona?.category) {
							category = cfgForPersona.category;
							break;
						}
					}
				}
				const picked = category ? m.pickForCategory(category, { preferredProviders }) : null;
				// Personas whose alias name doesn't match a category get a category
				// hint from the alias shape ("review-model" → try to infer review
				// or smart category by walking the alias name). If still no match,
				// fall back to "smart" so at least one model is auto-pickable.
				const fallbackCategory = !category ? "smart" : null;
				const finalPick =
					picked ||
					(fallbackCategory
						? m.pickForCategory(fallbackCategory, { preferredProviders })
						: null);
				const row = {
					alias,
					category: category || fallbackCategory,
					pick: finalPick
						? {
								id: finalPick.id,
								provider: finalPick.provider,
								thinking: finalPick.thinking,
								notes: finalPick.notes,
							}
						: null,
					personas: personas.map((p) => ({
						name: p.name,
						scope: p.scope,
					})),
				};
				row.guidance = finalPick
					? `agent models set ${alias} ${finalPick.provider}/${finalPick.id}${finalPick.thinking ? " --thinking on" : ""}  (applies to ${personas.length} persona${personas.length === 1 ? "" : "s"})`
					: `agent models set ${alias} <provider/model>  (${personas.length} persona${personas.length === 1 ? "" : "s"} share this alias)`;
				rows.push(row);
				if (personas.length > 1) shared.push(alias);
			}
			emit({ command: "models", action: "suggest", count: rows.length, unresolved: rows, shared });
			if (!JSON_MODE) {
				if (!rows.length) log.success("All model aliases resolve.");
				else {
					for (const r of rows) {
						const personaList =
							r.personas.length > 1
								? c.gray(` (${r.personas.length} personas: ${r.personas.map((p) => p.name).join(", ")})`)
								: "";
						if (r.pick) {
							log.raw(
								`  ${c.bold(r.alias.padEnd(28))} ${c.yellow(r.alias)} → ${c.green(r.pick.provider + "/" + r.pick.id)} ${r.pick.thinking ? c.gray("(thinking)") : ""}${personaList}`,
							);
						} else {
							log.raw(
								`  ${c.bold(r.alias.padEnd(28))} ${c.yellow(r.alias)} — ${c.cyan(r.guidance)}${personaList}`,
							);
						}
					}
					const applyable = rows.filter((r) => r.pick).length;
					if (applyable > 0) {
						log.dim(
							`${applyable} alias${applyable === 1 ? "" : "es"} auto-pickable from the bundled catalog. Apply with: agent models suggest --apply`,
						);
					} else {
						log.dim("No catalog match — assign manually: agent models set <alias> <provider/model>.");
					}
				}
			}
			if (opts.apply) {
				const applied = [];
				for (const r of rows) {
					if (!r.pick) continue;
					m.setAlias(r.alias, {
						model: `${r.pick.provider}/${r.pick.id}`,
						category: r.category,
						thinking: r.pick.thinking ? "on" : undefined,
					});
					applied.push({
						alias: r.alias,
						model: `${r.pick.provider}/${r.pick.id}`,
						personas: r.personas.map((p) => p.name),
					});
				}
				m.writeModelsMd();
				if (!JSON_MODE) {
					if (applied.length)
						log.success(
							`Applied ${applied.length} alias${applied.length === 1 ? "" : "es"}:`,
						);
					for (const a of applied) {
						const personas = a.personas.length > 1 ? c.gray(` (${a.personas.length} personas)`) : "";
						log.raw(`  ${c.green("✓")} ${a.alias} = ${a.model}${personas}`);
					}
				}
			}
			return;
		}
		if (action === "lint") {
			const unresolved = await findUnresolvedModels();
			const aliases = m.getAliases();
			const agents = await listAgents({ includeProject: true });
			const used = new Set(agents.filter((a) => a.model).map((a) => a.model));
			const unused = Object.keys(aliases).filter((a) => !used.has(a));
			emit({
				command: "models",
				action: "lint",
				unresolved,
				unused,
				counts: { aliases: Object.keys(aliases).length, unresolved: unresolved.length, unused: unused.length },
			});
			if (!JSON_MODE) {
				for (const u of unresolved) log.warn(`unresolved: ${u.name} → ${u.model} (${u.guidance})`);
				if (unused.length) log.dim(`unused aliases: ${unused.join(", ")}`);
				if (!unresolved.length && !unused.length) log.success("Aliases clean.");
			}
			return;
		}
		if (action === "usage") {
			const aliases = m.getAliases();
			const agents = await listAgents({ includeProject: true });
			const reverse = {};
			for (const a of agents) {
				if (!a.model) continue;
				(reverse[a.model] ||= []).push(a.name);
			}
			const rows = Object.entries(aliases).map(([alias, v]) => ({
				alias,
				model: v.model,
				usedBy: reverse[alias] || [],
			}));
			emit({ command: "models", action: "usage", aliases: rows });
			if (!JSON_MODE)
				for (const r of rows)
					log.raw(`  ${c.bold(r.alias.padEnd(14))} ${r.model} ${c.gray("by: " + (r.usedBy.join(", ") || "—"))}`);
			return;
		}
		if (action === "test") {
			const alias = rest[0];
			if (!alias) fail("Usage: agent models test <alias>");
			const r = m.getAlias(alias);
			if (!r) fail(`No such alias: ${alias}`);
			emit({ command: "models", action: "test", alias, ...r, valid: true });
			if (!JSON_MODE)
				log.success(`Alias '${alias}' → ${r.model}${r.thinking ? " @" + r.thinking : ""}`);
			return;
		}
		fail(`Unknown action: ${action}. Use list|set|resolve|write|suggest|lint|usage|test`);
	});

program
	.command("files")
	.description("Show the unified identity/memory file inventory (~/.agents).")
	.option("-p, --project", "project-local")
	.action(async (opts) => {
		const inv = await identityInventory({
			scope: opts.project ? "project" : "global",
			cwd: process.cwd(),
		});
		emit({ command: "files", ...inv });
		if (!JSON_MODE) {
			log.kv("base", pretty(inv.base));
			for (const f of inv.files) {
				const mark = !f.exists
					? c.gray("✗")
					: f.filled === false
						? c.yellow("⚠")
						: c.green("✓");
				const tag = f.filled === false ? c.yellow(" (unfilled)") : "";
				log.raw(
					`  ${mark} ${f.kind.padEnd(13)} ${pretty(f.path)}${f.size != null ? c.gray(" (" + f.size + "B)") : ""}${tag}`,
				);
			}
			log.raw(
				`  ${c.gray("agents/  ")} ${pretty(inv.agentsDir)} ${c.gray("(" + inv.agentsCount + " personalities)")}`,
			);
		}
	});

program
	.command("lessons [action] [name]")
	.description(
		"Lessons (agent-driven): list | add <topic/descriptive-name> [--body TEXT] | show <name> | inbox | triage. -p for project.",
	)
	.option("-p, --project", "project scope")
	.option("-b, --body <text>", "lesson body (for add)")
	.option("--file <n>", "inbox index to file (triage; legacy alias of --index)")
	.option("--index <n>", "inbox index to file (triage)")
	.option("--delete <n>", "inbox index to delete (triage)")
	.option("--plan", "(triage) map each inbox capture to a candidate lesson topic")
	.option("--clear", "delete ALL inbox captures (with the inbox action)")
	.option("--kind <k>", "(search) kind filter: lessons|identity|spect|all")
	.option("--inbox", "(capture) write a raw inbox capture for later triage")
	.action(async (action, name, opts) => {
		const {
			listLessons,
			addLesson,
			inboxLessons,
			resolveLessonFile,
			fileInboxItem,
			deleteInboxItem,
			clearInbox,
			addInboxCapture,
		} = await import("./lessons-lib.js");
		action = action || "list";
		const scope = opts.project ? "project" : "global";
		const cwd = process.cwd();
		if (action === "list") {
			const items = await listLessons({ includeProject: true, cwd });
			emit({ command: "lessons", action, count: items.length, lessons: items });
			if (!JSON_MODE) {
				if (!items.length)
					log.warn(
						"No lessons yet. Create one: agent lessons add <topic/descriptive-name>",
					);
				for (const it of items)
					log.raw(
						`${it.scope === "project" ? c.cyan("[proj]") : c.gray("[glob]")} ${c.bold(it.path)}  ${c.gray("×" + it.occurrences)}${it.marked ? c.yellow(" ⚠marked") : ""}`,
					);
			}
			return;
		}
		if (action === "add") {
			if (!name) {
				fail("Usage: agent lessons add <topic/descriptive-name>");
			}
			if (opts.inbox) {
				const r = await addInboxCapture(name, { body: opts.body, scope, cwd });
				emit({ command: "lessons", action, inbox: true, ...r });
				if (!JSON_MODE)
					log.success(`Captured to inbox → ${pretty(r.file)} (triage: agent lessons triage --plan)`);
				return;
			}
			const r = await addLesson(name, { body: opts.body, scope, cwd });
			emit({ command: "lessons", action, ...r });
			if (!JSON_MODE)
				log.success(
					`${r.created ? "Created" : "Updated (×" + r.occurrences + ")"}: ${pretty(r.file)}`,
				);
			return;
		}
		if (action === "show") {
			if (!name) {
				fail("Usage: agent lessons show <topic/descriptive-name>");
			}
			const { exists: ex, readFile: rf } = await import("./util.js");
			const fp = await resolveLessonFile(name, { scope, cwd });
			if (!fp) {
				fail("Lesson path must stay inside the lessons directory");
			}
			if (!(await ex(fp))) {
				fail(`Not found: ${pretty(fp)}`);
			}
			const content = await rf(fp);
			if (JSON_MODE) emit({ command: "lessons", action, path: fp, content });
			else process.stdout.write(content);
			return;
		}
		if (action === "inbox") {
			if (opts.clear) {
				const r = await clearInbox({ includeProject: true, cwd });
				emit({ command: "lessons", action: "inbox", op: "clear", ...r });
				if (!JSON_MODE) log.success(`Cleared ${r.deleted} inbox capture(s)`);
				return;
			}
			const items = await inboxLessons({ includeProject: true, cwd });
			emit({ command: "lessons", action, count: items.length, inbox: items });
			if (!JSON_MODE) {
				if (!items.length) log.info("Inbox empty.");
				for (const it of items)
					log.raw(
						`  ${it.scope === "project" ? c.cyan("[proj]") : c.gray("[glob]")} ${pretty(it.file)}`,
					);
			}
			return;
		}
		if (action === "triage") {
			if (opts.plan) {
				const items = await inboxLessons({ includeProject: true, cwd });
				const plans = [];
				for (let i = 0; i < items.length; i++) {
					const content = await (async () => {
						try {
							return await readFile(items[i].file);
						} catch {
							return "";
						}
					})();
					// candidate topic from `- Capture: <topic>` or the first body line.
					// Skip the YAML frontmatter block (between the leading `---` markers)
					// so fields like `sourceSession:` are never picked as the topic.
					const capture = /^-\s*Capture:\s*(.+)$/m.exec(content);
					const lines = content.split(/\r?\n/).map((l) => l.trim());
					let inFm = false;
					let fmCount = 0;
					const first = lines.find((l) => {
						if (l.startsWith("---")) {
							inFm = !inFm;
							fmCount++;
							return false;
						}
						return !inFm && l && !l.startsWith("#") && !l.startsWith("-") && !l.startsWith("---");
					});
					const topic = (capture ? capture[1] : first || items[i].name.replace(/\.md$/, "")).trim();
					plans.push({
						index: i,
						scope: items[i].scope,
						file: items[i].file,
						candidate: topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
						topic,
					});
				}
				emit({ command: "lessons", action: "triage", op: "plan", plans });
				if (!JSON_MODE) {
					if (!plans.length) log.info("Inbox empty.");
					for (const p of plans)
						log.raw(
							`  [${p.index}] ${pretty(p.file)} → ${c.cyan(p.candidate)}${c.gray("  (" + p.topic + ")")}`,
						);
					log.dim("File one: agent lessons triage --index <i> <topic>");
				}
				return;
			}
			const fileIndex = opts.index != null ? opts.index : opts.file;
			if (fileIndex != null) {
				if (!name) {
					fail("Usage: agent lessons triage --index <i> <topic/name>");
				}
				const r = await fileInboxItem(parseInt(fileIndex, 10), name, { cwd });
				emit({ command: "lessons", action: "triage", op: "file", ...r });
				if (!r.ok) {
					if (!JSON_MODE) log.error(r.reason);
					process.exit(1);
				}
				if (!JSON_MODE)
					log.success(`Filed inbox #${fileIndex} → ${pretty(r.filedTo)}`);
				return;
			}
			if (opts.delete != null) {
				const r = await deleteInboxItem(parseInt(opts.delete, 10), { cwd });
				emit({ command: "lessons", action: "triage", op: "delete", ...r });
				if (!r.ok) {
					if (!JSON_MODE) log.error(r.reason);
					process.exit(1);
				}
				if (!JSON_MODE) log.success(`Deleted inbox #${opts.delete}`);
				return;
			}
			const items = await inboxLessons({ includeProject: true, cwd });
			emit({
				command: "lessons",
				action: "triage",
				count: items.length,
				inbox: items,
			});
			if (!JSON_MODE) {
				if (!items.length) log.info("Inbox empty.");
				items.forEach((it, i) =>
					log.raw(
						`  [${i}] ${it.scope === "project" ? c.cyan("[proj]") : c.gray("[glob]")} ${pretty(it.file)}`,
					),
				);
				log.dim(
					"File one: agent lessons triage --file <i> <topic/name> · delete: agent lessons triage --delete <i>",
				);
			}
			return;
		}
		if (action === "search") {
			if (!name) fail("Usage: agent lessons search <query>");
			const search = await import("./search.js");
			const r = await search.searchLessons(name, {
				includeProject: true,
				cwd,
			});
			emit({ command: "lessons", action: "search", ...r });
			if (!JSON_MODE) {
				if (!r.results.length) log.info("No lesson matches.");
				for (const hit of r.results)
					log.raw(
						`  ${c.bold(String(hit.score).padStart(3))} [${hit.scope}] ${pretty(hit.path)} ×${hit.occurrences}${hit.marked ? c.yellow(" ⚠marked") : ""}`,
					);
			}
			return;
		}
		if (action === "capture") {
			if (!name) fail("Usage: agent lessons capture <topic> [--inbox|--direct]");
			const memMod = await import("./memory.js");
			const info = memMod.gitInfo(cwd);
			if (opts.inbox) {
				const r = await addInboxCapture(name, {
					body: opts.body,
					scope,
					cwd,
					repo: info.repo,
					branch: info.branch,
				});
				emit({ command: "lessons", action: "capture", mode: "inbox", ...r });
				if (!JSON_MODE) log.success(`Captured to inbox → ${pretty(r.file)}`);
				return;
			}
			const r = await addLesson(name, { body: opts.body, scope, cwd });
			emit({ command: "lessons", action: "capture", mode: "direct", ...r });
			if (!JSON_MODE) log.success(`Captured → ${pretty(r.file)}`);
			return;
		}
		fail(
			`Unknown action: ${action}. Use list|add|show|inbox|triage|search|capture`,
		);
	});

program
	.command("consolidate")
	.description(
		"Consolidate lessons, or --check the score. Promotes recurring → core, prunes single-occurrence-unrepeated (grace).",
	)
	.option("-p, --project", "project scope")
	.option(
		"--check",
		"compute the consolidation score; don't write (agent decides)",
	)
	.option("--dry-run", "preview without writing")
	.option("--threshold <n>", "occurrences required to promote to core")
	.option("--plan", "list planned per-file actions with reasons (no writes)")
	.option("--apply <plan-id>", "apply one planned action by id")
	.action(async (opts) => {
		const con = await import("./consolidate.js");
		const scope = opts.project ? "project" : "global";
		const cwd = process.cwd();
		if (opts.plan || opts.apply) {
			const plan = con.planConsolidation({ scope, cwd });
			if (opts.apply) {
				const r = con.applyPlanAction(scope, cwd, opts.apply);
				emit({ command: "consolidate", action: "apply", planId: opts.apply, ...r });
				if (!JSON_MODE) {
					if (!r.ok) {
						log.error(r.reason);
						process.exit(EXIT.ERROR);
					}
					log.success(`Applied ${opts.apply} (${r.applied.action}) → ${pretty(r.applied.path)}`);
				}
				if (!r.ok) process.exit(EXIT.ERROR);
				return;
			}
			emit({ command: "consolidate", action: "plan", ...plan });
			if (!JSON_MODE) {
				if (plan.nothingToDo) log.info("Nothing to consolidate.");
				for (const a of plan.actions)
					log.raw(
						`  ${a.id.padEnd(10)} ${a.action.padEnd(8)} ${a.rel} ${c.gray("(" + a.reason + ")")}`,
					);
			}
			return;
		}
		if (opts.check) {
			const a = con.assess({ scope, cwd });
			emit({ command: "consolidate", check: true, ...a });
			if (!JSON_MODE) {
				log.raw(
					`${c.bold("consolidate")} ${c.gray("(" + a.scope + ")")} — score ${c.bold(String(a.score))}/100 ${a.recommend ? c.yellow("⚠ recommend") : c.green("ok")}`,
				);
				log.kv("threshold", a.threshold);
				if (a.reasons.length) {
					log.raw(c.bold("Reasons:"));
					for (const r of a.reasons) log.raw(`  • ${r}`);
				}
				log.kv(
					"metrics",
					`lessons ${a.metrics.lessons}, tokens ${a.metrics.tokens}, marked ${a.metrics.marked}, promotable ${a.metrics.promotable}, inbox ${a.metrics.inbox}, age ${a.metrics.ageDays ?? "—"}d`,
				);
			}
			return;
		}
		const pre = !opts.dryRun && !opts.check ? await preSnapshot("consolidate") : null;
		const r = con.consolidate({
			scope,
			cwd,
			dryRun: !!opts.dryRun,
			promoteThreshold: opts.threshold
				? parseInt(opts.threshold, 10)
				: undefined,
		});
	// "nothing to do" is a healthy no-op, not a failure (cron-safe).
	// Three cases: r.stats is missing (no lessons dir, healthy); r.stats is
	// present and zero (consolidate ran with nothing to do); r.stats present
	// and nonzero (real work).
	if (r.ok) {
		if (r.stats) {
			r.nothingToDo =
				r.nothingToDo == null &&
				r.stats.promoted === 0 &&
				r.stats.deleted === 0 &&
				r.stats.marked === 0;
		} else {
			r.nothingToDo = true;
		}
	}
	emit({
		command: "consolidate",
		...r,
		...(pre ? { preSnapshot: pre } : {}),
	});
	if (!r.ok) {
		if (JSON_MODE) process.exit(EXIT.ERROR);
		fail(r.reason);
	}
	if (!JSON_MODE) {
		if (r.nothingToDo) {
			log.info(r.reason || "Nothing to consolidate.");
		} else {
			const s = r.stats;
			log.success(
				`Consolidated (${r.dryRun ? "dry-run" : "applied"}, ${r.scope}): promoted ${c.green(s.promoted)}, pruned ${c.red(s.deleted)}, marked ${c.yellow(s.marked)}, kept ${s.kept}, core ${s.core}`,
			);
		}
	}
	});

program
	.command("pull <id>")
	.description("Adopt a target file's native content as the new master body.")
	.option("-g, --global")
	.option("-p, --project")
	.action(async (id, opts) => {
		const t = getTarget(id);
		if (!t) {
			fail(`Unknown target: ${id}`);
		}
		const scope = opts.project ? "project" : "global";
		const p = targetPath(t, scope);
		if (!p) {
			fail(`${id} has no ${scope} path`);
		}
		if (!(await exists(p))) {
			fail(`Not found: ${p}`);
		}
		const fs = await import("node:fs/promises");
		const content = await fs.readFile(p, "utf8");
		if (content.includes(POINTER_MARK)) {
			fail(`${p} is already a pointer (no native content to pull).`);
		}
		const { ensureBlocks } = await import("./blocks.js");
		await writeMaster(ensureBlocks(content));
		emit({ command: "pull", id, scope, path: p, ok: true });
		if (!JSON_MODE)
			log.success(`Adopted ${pretty(p)} → ${pretty(MASTER_FILE)}`);
	});

program
	.command("where")
	.description("Print resolved paths for targets.")
	.option("-g, --global")
	.option("-p, --project")
	.action(async (opts) => {
		const scope = opts.project ? "project" : "global";
		const rows = TARGETS.filter((t) => pathFor(t, scope)).map((t) => ({
			id: t.id,
			name: t.name,
			path: targetPath(t, scope),
		}));
		const { masterAbs, masterTilde: mTilde } = masterPaths(scope);
		emit({
			command: "where",
			scope,
			master: masterAbs,
			masterTilde: mTilde,
			targets: rows,
		});
		if (!JSON_MODE) {
			log.kv("master", c.cyan(pretty(masterAbs)));
			for (const r of rows) log.raw(`  ${r.id.padEnd(9)} ${pretty(r.path)}`);
		}
	});

// ---------------------------------------------------------------------------
// agent update — shipped-default update payloads + npm latest version
// ---------------------------------------------------------------------------
program
	.command("update [action] [version]")
	.description(
		"Shipped-default updates: list staged payloads + npm latest version (default), stage seeds, diff <version> [--file <rel>], or clear <version>.",
	)
	.option("--force", "force a fresh npm version check (writes config.json)")
	.option("--offline", "never hit the network; use the cached check only")
	.option("--no-network", "alias for --offline")
	.option(
		"--file <rel>",
		"restrict diff to one staged file (relative, e.g. agents/scout.md)",
	)
	.action(async (action, version, opts) => {
		const seed = await import("./seed.js");
		const npm = await import("./npm-check.js");
		const cfg = await loadConfig();
		action = action || "list";
		if (action === "stage") {
			const r = await seed.stageSeeds({ home: AGENTS_DIR, version: VERSION });
			// Never mark seeding as done before `agent init` has installed the defaults:
			// planSeedAction(prev=null) must still return "install" for the first run.
			if (cfg.seedVersion != null) {
				cfg.seedVersion = VERSION;
				await saveConfig(cfg);
			}
			emit({ command: "update", action, ...r });
			if (!JSON_MODE)
				log.success(`Staged ${r.staged.length} seeds → ${pretty(r.path)}`);
			return;
		}
		if (action === "list") {
			const offline =
				opts.offline ||
				opts.network === false ||
				process.env.AGENT_OFFLINE === "1";
			let upd;
			if (opts.force && !offline) {
				upd = await npm.ensureUpdateCheck(cfg, PKG_NAME, VERSION, {
					force: true,
					offline,
				});
				if (upd.refreshed) await saveConfig(cfg);
			} else {
				upd = npm.readCachedUpdate(cfg, VERSION);
			}
			const staged = await seed.listStagedUpdates({ home: AGENTS_DIR });
			emit({
				command: "update",
				action: "list",
				installedVersion: VERSION,
				latest: upd.latest,
				upToDate: upd.upToDate,
				checkedAt: upd.checkedAt,
				cached: upd.cached,
				seedVersion: cfg.seedVersion,
				staged,
			});
			if (!JSON_MODE) {
				log.kv("installed", c.bold(VERSION));
				log.kv(
					"latest",
					upd.latest
						? upd.upToDate
							? c.green(upd.latest + " (up to date)")
							: c.yellow(upd.latest + " (update available)")
						: c.gray("unknown"),
				);
				log.kv("seeded at", cfg.seedVersion || c.gray("not yet"));
				if (staged.length) {
					log.raw(c.bold("Staged updates (awaiting your migration):"));
					for (const s of staged) {
						log.raw(
							`  ${c.cyan(s.version)} ${pretty(s.path)} ${c.gray("(" + s.files.length + " files)")}`,
						);
						for (const f of s.files) log.dim("    " + f);
					}
					log.dim(
						"Review & migrate each file with the user's consent; never clobber their edits.",
					);
				} else log.kv("staged", c.green("none"));
			}
			return;
		}
		if (action === "clear") {
			if (!version) fail("Usage: agent update clear <version>");
			const r = await seed.clearStaged(version, { home: AGENTS_DIR });
			emit({ command: "update", action: "clear", ...r });
			if (!r.ok) {
				if (!JSON_MODE) log.error(`Not found: update-${version}`);
				process.exit(1);
			}
			if (!JSON_MODE) log.success(`Removed ${pretty(r.path)}`);
			return;
		}
		if (action === "diff") {
			if (!version) fail("Usage: agent update diff <version> [--file <rel>]");
			const stagedList = await seed.listStagedUpdates({ home: AGENTS_DIR });
			const payload = stagedList.find((s) => s.version === version);
			if (!payload) fail(`No staged update for ${version}`);
			const requested = opts.file ? opts.file.replace(/\\/g, "/") : null;
			if (requested && !payload.files.includes(requested))
				fail(`File is not part of staged update: ${opts.file}`);
			const rels = requested ? [requested] : payload.files;
			const diffs = [];
			for (const rel of rels) {
				const stagedContent = await seed.readStagedFile(version, rel, {
					home: AGENTS_DIR,
				});
				const livePath = resolveContained(AGENTS_DIR, rel);
				if (!livePath) fail(`Invalid staged file path: ${rel}`);
				let liveContent = null;
				if (await exists(livePath)) liveContent = await readFile(livePath);
				diffs.push({
					rel,
					livePath,
					liveExists: liveContent != null,
					diff: seed.diffLines(liveContent ?? "", stagedContent ?? ""),
				});
			}
			emit({ command: "update", action: "diff", version, diffs });
			if (!JSON_MODE)
				for (const d of diffs) {
					log.raw(
						c.bold(`${d.rel}  ${d.liveExists ? "" : c.gray("(live missing)")}`),
					);
					const hasChanges = d.diff
						.split("\n")
						.some((line) => line.startsWith("+") || line.startsWith("-"));
					if (!hasChanges) {
						log.dim("  No differences.");
						continue;
					}
					for (const line of d.diff.split("\n")) {
						let colored;
						if (line.startsWith("+")) colored = c.green(line);
						else if (line.startsWith("-")) colored = c.red(line);
						else colored = c.gray(line);
						process.stdout.write(colored + "\n");
					}
				}
			return;
		}
		if (action === "apply") {
			if (!version) fail("Usage: agent update apply <version>");
			const pre = await preSnapshot("update-apply");
			const r = await seed.applyStaged(version, { home: AGENTS_DIR });
			emit({
				command: "update",
				action: "apply",
				...r,
				...(pre ? { preSnapshot: pre } : {}),
			});
			if (!JSON_MODE) {
				if (!r.ok) {
					log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				log.success(`Applied ${r.applied.length} file(s) from update-${version}`);
				if (r.backedUp.length)
					log.dim(`Backed up: ${r.backedUp.join(", ")}`);
				if (r.skipped.length)
					for (const s of r.skipped)
						log.warn(`Skipped ${s.rel}: ${s.reason}`);
			}
			if (!r.ok) process.exit(EXIT.ERROR);
			return;
		}
		fail(`Unknown action: ${action}. Use list|diff|stage|clear|apply <version>`);
	});

program
	.command("upgrade")
	.description(
		"Apply all staged seed updates, then re-link pointers and refresh skill blocks.",
	)
	.action(async () => {
		const seed = await import("./seed.js");
		const staged = await seed.listStagedUpdates({ home: AGENTS_DIR });
		const applied = [];
		const failed = [];
		for (const s of staged) {
			const r = await seed.applyStaged(s.version, { home: AGENTS_DIR });
			if (r.ok) applied.push({ version: s.version, ...r });
			else failed.push({ version: s.version, reason: r.reason });
		}
		// re-link + refresh skill blocks after applying seeds
		const cfg = await loadConfig();
		const { masterAbs, masterTilde } = ctxPaths();
		let relinked = 0;
		for (const id of cfg.global) {
			const t = getTarget(id);
			if (!t) continue;
			const lr = await linkTarget(t, "global", { masterAbs, masterTilde });
			if (lr.linked || lr.unchanged) relinked++;
		}
		const blocks = await refreshBlocks();
		emit({
			command: "upgrade",
			applied,
			failed,
			relinked,
			blocksRefreshed: blocks.changed,
		});
		if (!JSON_MODE) {
			for (const a of applied)
				log.success(`update-${a.version}: applied ${a.applied.length}, skipped ${a.skipped.length}`);
			for (const f of failed) log.warn(`update-${f.version}: ${f.reason}`);
			log.kv("relinked", relinked);
			log.kv("skill blocks", blocks.changed ? "refreshed" : "current");
		}
	});

// ---------------------------------------------------------------------------
// agent spect — project-local specification-driven development
// ---------------------------------------------------------------------------
program
	.command("spect [action] [rest...]")
	.description(
		"SPECT workflow (.spect): init|status|task list|done|open, validate, report, next, close, trace.",
	)
	.option("--spec <id>", "restrict report/task-list to one spec id")
	.action(async (action, rest, opts) => {
		const spect = await import("./spect.js");
		const cwd = process.cwd();
		action = action || "status";
		if (action === "init") {
			const result = await spect.initSpect(cwd);
			emit({ command: "spect", action, ...result });
			if (!JSON_MODE) {
				log.success(`SPECT initialized in ${pretty(result.root)}`);
				if (result.created.length)
					log.info(`Created: ${result.created.join(", ")}`);
				if (result.skipped.length)
					log.dim(`Preserved: ${result.skipped.join(", ")}`);
				log.dim(
					`Next: copy .spect/templates/spec.md into .spect/specs/ and define acceptance criteria before implementation.`,
				);
			}
			return;
		}
		if (action === "status") {
			const result = await spect.inspectSpect(cwd);
			emit({ command: "spect", action, ...result });
			if (!JSON_MODE)
				log.kv(
					"project",
					result.initialized
						? `${pretty(result.root)} (${result.counts.specs} specs, ${result.counts.plans} plans, ${result.counts.tasks} tasks)`
						: "not initialized — run agent spect init",
				);
			return;
		}
		if (action === "task") {
			const sub = rest[0];
			const id = rest[1];
			if (sub === "list" || !sub) {
				const tasks = await spect.parseTasks(cwd);
				const filtered = opts.spec
					? tasks.filter((t) => t.reqs.includes(opts.spec))
					: tasks;
				emit({
					command: "spect",
					action: "task",
					op: "list",
					taskCount: filtered.length,
					open: filtered.filter((t) => !t.done).length,
					tasks: filtered,
				});
				if (!JSON_MODE) {
					if (!filtered.length) log.info("No tasks.");
					for (const t of filtered)
						log.raw(
							`  ${t.done ? c.green("[x]") : c.gray("[ ]")} ${c.bold(t.id.padEnd(9))} ${t.reqs.length ? c.gray("[" + t.reqs.join(", ") + "] ") : ""}${t.title}`,
					);
					log.dim(
						`${filtered.filter((t) => !t.done).length} open — mark: agent spect task done|open <TASK-xxx>`,
					);
				}
				return;
			}
			if (sub === "done" || sub === "open") {
				if (!id) fail("Usage: agent spect task done|open <TASK-xxx>");
				const r = await spect.setTaskStatus(cwd, id, sub === "done");
				emit({ command: "spect", action: "task", op: sub, ...r });
				if (!r.ok) {
					if (!JSON_MODE) log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				if (!JSON_MODE)
					log.success(`${id} → ${sub === "done" ? "done" : "open"} (${pretty(r.file)})`);
				return;
			}
			fail(`Unknown task op: ${sub}. Use list|done|open`);
		}
		if (action === "validate") {
			const r = await spect.validateSpect(cwd);
			emit({ command: "spect", action, ...r });
			if (!JSON_MODE) {
				if (r.ok) log.success("SPECT cross-references are consistent.");
				else
					for (const i of r.issues)
						log.warn(`${i.type}: ${i.req} (${i.task || i.spec || ""})`);
			}
			if (!r.ok) process.exit(EXIT.WORK);
			return;
		}
		if (action === "report") {
			const r = await spect.reportSpect(cwd, { spec: opts.spec });
			emit({ command: "spect", action, ...r });
			if (!JSON_MODE) {
				if (!r.ok) {
					log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				log.raw(c.bold(`REQ coverage (${r.spec}):`));
				for (const q of r.reqs)
					log.raw(
						`  ${c.green(q.status === "done" ? "✓" : "○")} ${q.req.padEnd(9)} ${q.status.padEnd(12)} ${q.criterion}`,
					);
				log.dim(`${r.summary.done}/${r.summary.total} done`);
			}
			return;
		}
		if (action === "next") {
			const r = await spect.nextTask(cwd);
			emit({ command: "spect", action, ...r });
			if (!JSON_MODE) {
				if (r.nothingToDo) log.success("All tasks complete.");
				else {
					log.raw(c.bold(`Next: ${r.task.id} — ${r.task.title}`));
					log.kv("file", pretty(r.task.file));
					for (const a of r.acceptance)
						log.raw(`  ${c.cyan(a.req)} ${a.criterion ?? "(no criterion)"}`);
				}
			}
			return;
		}
		if (action === "close") {
			const id = rest[0];
			if (!id) fail("Usage: agent spect close <TASK-xxx>");
			const r = await spect.closeTask(cwd, id);
			emit({ command: "spect", action, ...r });
			if (!r.ok) {
				if (!JSON_MODE) log.error(r.reason);
				process.exit(EXIT.ERROR);
			}
			if (!JSON_MODE) {
				log.success(`Closed ${id} — ${pretty(r.file)}`);
				log.dim(r.lesson.suggestion);
				log.dim(r.snapshotSuggestion);
			}
			return;
		}
		if (action === "trace") {
			const specId = rest[0];
			if (!specId) fail("Usage: agent spect trace <SPEC-id>");
			const r = await spect.traceSpect(specId, cwd);
			emit({ command: "spect", action, ...r });
			if (!r.ok) {
				if (!JSON_MODE) log.error(r.reason);
				process.exit(EXIT.ERROR);
			}
			if (!JSON_MODE) {
				for (const q of r.reqs)
					log.raw(
						`  ${q.implemented ? c.green("✓") : c.gray("○")} ${q.id.padEnd(9)} ${q.tasks.map((t) => t.id).join(", ") || c.gray("(no task)")} ${q.verified ? c.green("verified") : c.yellow("unverified")}`,
					);
				if (r.issues.length) for (const i of r.issues) log.warn(`${i.type}: ${i.req}`);
			}
			return;
		}
		fail(
			`Unknown action: ${action}. Use init|status|task|validate|report|next|close|trace`,
		);
	});

program
	.command("search <query>")
	.description(
		"Search lessons, identity files, and SPECT docs by relevance.",
	)
	.option("--kind <k>", "lessons|identity|spect|all (default all)")
	.option("--project", "include the project scope")
	.option("--limit <n>", "max results")
	.action(async (query, opts) => {
		const search = await import("./search.js");
		const r = await search.searchAll(query, {
			kind: opts.kind || "all",
			project: !!opts.project,
			limit: opts.limit ? parseInt(opts.limit, 10) : 10,
		});
		emit({ command: "search", ...r });
		if (!JSON_MODE) {
			if (!r.results.length) log.info("No matches.");
			for (const hit of r.results) {
				log.raw(
					`  ${c.bold(String(hit.score).padStart(3))} ${pretty(hit.path)} ${c.gray("[" + hit.kind + "]")}`,
				);
				if (hit.excerpt) log.dim(hit.excerpt);
			}
		}
	});

// ---------------------------------------------------------------------------
// agent sync — git-backed brain portability
// ---------------------------------------------------------------------------
program
	.command("sync <action> [arg]")
	.description(
		"Git-backed brain sync: init|push|pull|status|log|diff|rollback|auto. Secrets are never synced.",
	)
	.option("--remote <url>", "(init) set the git remote")
	.option("--take <side>", "(pull) conflict resolution: local|remote")
	.option("--message <text>", "(push) commit message")
	.option("--commit <hash>", "(diff|rollback) commit to inspect/restore")
	.option("--limit <n>", "(log) max entries")
	.option("--on", "(auto) enable auto-commit after mutations")
	.option("--off", "(auto) disable auto-commit")
	.action(async (action, arg, opts) => {
		const sync = await import("./sync.js");
		const cfg = await loadConfig();
		let r;
		switch (action) {
			case "init":
				r = await sync.syncInit({ remote: opts.remote });
				cfg.sync = {
					remote: r.remote ?? cfg.sync?.remote ?? null,
					autoCommit: !!cfg.sync?.autoCommit,
					excluded: null,
					lastPull: cfg.sync?.lastPull ?? null,
				};
				await saveConfig(cfg);
				break;
			case "push":
				r = await sync.syncPush({ message: opts.message });
				break;
			case "pull":
				r = await sync.syncPull({ take: opts.take });
				if (r.ok) {
					cfg.sync = { ...(cfg.sync || {}), lastPull: new Date().toISOString() };
					await saveConfig(cfg);
				}
				break;
			case "status":
				r = await sync.syncStatus();
				break;
			case "log":
				r = await sync.syncLog({ limit: opts.limit ? parseInt(opts.limit, 10) : 20 });
				break;
			case "diff":
				r = await sync.syncDiff({ commit: opts.commit });
				break;
			case "rollback":
				r = await sync.syncRollback({ commit: opts.commit || arg });
				break;
			case "auto":
				{
					const posOn = arg === "on" || arg === "1";
					const posOff = arg === "off" || arg === "0";
					if (opts.on === undefined && opts.off === undefined && !posOn && !posOff) {
						r = { ok: true, enabled: sync.autoCommitEnabled(cfg) };
						break;
					}
					const on = posOn || !!opts.on;
					sync.setAutoCommit(cfg, on);
					await saveConfig(cfg);
					r = { ok: true, enabled: on };
				}
				break;
			default:
				fail(
					`Unknown sync action: ${action}. Use init|push|pull|status|log|diff|rollback|auto`,
					{ command: "sync", action },
				);
		}
		// Re-link pointers after a pull/rollback so stubs match the restored master.
		if (r && r.relink) {
			const { masterAbs, masterTilde } = ctxPaths();
			let relinked = 0;
			for (const id of cfg.global) {
				const t = getTarget(id);
				if (!t) continue;
				const lr = await linkTarget(t, "global", { masterAbs, masterTilde });
				if (lr.linked || lr.unchanged) relinked++;
			}
			r.relinked = relinked;
		}
		emit({ command: "sync", action, ...r });
		if (!JSON_MODE) {
			if (!r.ok && r.reason) log.error(r.reason);
			else if (action === "push")
				log.success(
					r.changed
						? `Pushed ${r.commit}${r.pushed ? " → remote" : " (local only)"} (${r.files.length} files)`
						: "Nothing to push.",
				);
			else if (action === "pull")
				log.success(
					`Pulled${r.conflict ? ` (resolved: ${r.resolved ?? "manual"})` : ""} — ${r.relinked ?? 0} pointers re-linked.`,
				);
			else if (action === "status")
				log.raw(
					`branch ${r.branch} @ ${r.head} ahead ${r.ahead} behind ${r.behind} dirty ${r.dirtyFiles.length}`,
				);
			else if (action === "log")
				for (const e of r.entries) log.raw(`  ${c.gray(e.hash)} ${e.date} ${e.message}`);
			else if (action === "diff" && r.summary) log.raw(r.summary);
			else if (action === "auto") log.success(`auto-commit ${r.enabled ? "on" : "off"}`);
			else if (action === "init") log.success(`Sync repo ready at ${pretty(r.dir)}`);
			else if (action === "rollback") log.success(`Restored ${r.commit} — re-linked pointers.`);
		}
		if (r && !r.ok && !r.nothingToDo) process.exit(EXIT.ERROR);
	});

// ---------------------------------------------------------------------------
// agent secret — machine-local encrypted store (never synced)
// ---------------------------------------------------------------------------
program
	.command("secret <action> [name] [value...]")
	.description(
		"Machine-local encrypted secrets: set|get|list|rm|env. Never synced or surfaced.",
	)
	.option("-p, --project", "project scope")
	.action(async (action, name, value, opts) => {
		const sec = await import("./secrets.js");
		const scope = opts.project ? "project" : "global";
		if (action === "set") {
			if (!name || !value.length) fail("Usage: agent secret set <name> <value>");
			const r = sec.setSecret(name, value.join(" "), { scope });
			emit({ command: "secret", action, ...r });
			if (!JSON_MODE) log.success(`Secret '${name}' stored (${scope}).`);
			return;
		}
		if (action === "get") {
			if (!name) fail("Usage: agent secret get <name>");
			try {
				const v = sec.getSecret(name, { scope });
				emit({ command: "secret", action, name, value: v });
				if (!JSON_MODE) process.stdout.write(v + "\n");
			} catch (e) {
				fail(e.message, { command: "secret", action, name });
			}
			return;
		}
		if (action === "list") {
			const names = sec.listSecretNames({ scope });
			emit({ command: "secret", action, scope, names, count: names.length });
			if (!JSON_MODE) {
				if (!names.length) log.info("No secrets.");
				for (const n of names) log.raw(`  ${n}`);
			}
			return;
		}
		if (action === "rm") {
			if (!name) fail("Usage: agent secret rm <name>");
			const r = sec.rmSecret(name, { scope });
			emit({ command: "secret", action, ...r });
			if (!JSON_MODE)
				log.success(r.existed ? `Removed '${name}'.` : `No such secret '${name}'.`);
			return;
		}
		if (action === "env") {
			const env = sec.secretEnv({ scope });
			emit({ command: "secret", action, scope, env, count: env.length });
			if (!JSON_MODE) for (const l of env) process.stdout.write(l + "\n");
			return;
		}
		fail(
			`Unknown secret action: ${action}. Use set|get|list|rm|env`,
			{ command: "secret", action },
		);
	});

// ---------------------------------------------------------------------------
// agent env capture — fill ENVIRONMENTS.md from detected machine facts
// ---------------------------------------------------------------------------
program
	.command("env <action> [rest...]")
	.description("Environment: capture (detect + fill ENVIRONMENTS.md) | set <Field> <value>.")
	.option("-p, --project", "project scope")
	.action(async (action, rest, opts) => {
		if (action === "set") {
			const field = rest?.[0];
			const value = (rest?.slice(1) || []).join(" ");
			if (!field || !value) fail("Usage: agent env set <Field> <value>");
			const envc = await import("./env-capture.js");
			const r = await envc.setEnvironmentField(field, value, {
				scope: opts.project ? "project" : "global",
				cwd: process.cwd(),
			});
			emit({ command: "env", action: "set", ...r });
			if (!JSON_MODE) {
				if (!r.ok) {
					log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				log.success(`ENVIRONMENTS.md: ${r.field}: ${r.value}`);
			}
			if (!r.ok) process.exit(EXIT.ERROR);
			return;
		}
		if (action !== "capture")
			fail(`Unknown env action: ${action}. Use capture|set`, { command: "env", action });
		const envc = await import("./env-capture.js");
		const r = await envc.captureAndApply({
			scope: opts.project ? "project" : "global",
			cwd: process.cwd(),
		});
		emit({ command: "env", action: "capture", ...r });
		if (!JSON_MODE) {
			if (!r.ok) {
				log.error(r.reason);
				process.exit(EXIT.ERROR);
			}
			log.success(
				`ENVIRONMENTS.md: filled ${r.filled} field(s) → ${pretty(r.file)}`,
			);
			if (r.sshAliases.length) log.kv("ssh aliases", r.sshAliases.join(", "));
		}
		if (!r.ok) process.exit(EXIT.ERROR);
	});

// ---------------------------------------------------------------------------
// agent memory / backups / session — the memory loop
// ---------------------------------------------------------------------------
program
	.command("memory <action>")
	.description(
		"Memory loop: check (honor consolidate.prompt) | maintain (snapshot→triage→consolidate).",
	)
	.option("--apply", "(check) run consolidate when prompt=auto and recommended")
	.option("-p, --project", "project scope")
	.action(async (action, opts) => {
		const memMod = await import("./memory.js");
		const scope = opts.project ? "project" : "global";
		if (action === "check") {
			const r = await memMod.memoryCheck({ scope });
			if (opts.apply && r.action === "consolidate") {
				const conMod = await import("./consolidate.js");
				const applied = conMod.consolidate({ scope });
				r.applied = applied.ok ? applied.stats : null;
			}
			emit({ command: "memory", action: "check", ...r });
			if (!JSON_MODE)
				log.raw(
					`prompt=${r.prompt} → action=${r.action} (score ${r.consolidate.score}, recommend ${r.consolidate.recommend})`,
				);
			return;
		}
		if (action === "maintain") {
			const r = await memMod.memoryMaintain({ scope: opts.project ? "project" : "all" });
			emit({ command: "memory", action: "maintain", ...r });
			if (!JSON_MODE)
				log.success(
					`Snapshot ${r.snapshot} · ${r.inbox} inbox · ${r.consolidated.length} scope(s) consolidated.`,
				);
			return;
		}
		fail(`Unknown memory action: ${action}. Use check|maintain`, { command: "memory", action });
	});

program
	.command("backups <action> [name]")
	.description("Consolidation backup history: list | diff <name>.")
	.option("-p, --project", "project scope")
	.action(async (action, name, opts) => {
		const memMod = await import("./memory.js");
		const scope = opts.project ? "project" : "global";
		if (action === "list") {
			const r = memMod.backupsList({ scope });
			emit({ command: "backups", action: "list", ...r });
			if (!JSON_MODE) {
				if (!r.backups.length) log.info("No consolidation backups.");
				for (const b of r.backups)
					log.raw(`  ${c.gray(b.name.padEnd(40))} ${b.mtime} ${c.gray(b.size + "B")}`);
			}
			return;
		}
		if (action === "diff") {
			if (!name) fail("Usage: agent backups diff <name>");
			const r = memMod.backupsDiff(name, { scope });
			emit({ command: "backups", action: "diff", ...r });
			if (!JSON_MODE) {
				if (!r.ok) {
					log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				for (const line of r.diff.split("\n")) {
					const colored = line.startsWith("+")
						? c.green(line)
						: line.startsWith("-")
							? c.red(line)
							: c.gray(line);
					process.stdout.write(colored + "\n");
				}
			}
			return;
		}
		fail(`Unknown backups action: ${action}. Use list|diff`, { command: "backups", action });
	});

program
	.command("session <action> [task...]")
	.description(
		"Session lifecycle: start [task] | end | report (lesson candidate).",
	)
	.action(async (action, task) => {
		const sess = await import("./session.js");
		if (action === "start") {
			const r = await sess.sessionStart({ task: task ? task.join(" ") : null, cwd: process.cwd() });
			emit({ command: "session", action, ...r });
			if (!JSON_MODE) log.success(`Session started (${r.session.startedAt}).`);
			return;
		}
		if (action === "end") {
			const r = await sess.sessionEnd();
			emit({ command: "session", action, ...r });
			if (!JSON_MODE) {
				if (!r.ok) {
					log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				log.success(`Session ended (${Math.round(r.durationMs / 1000)}s).`);
			}
			if (!r.ok) process.exit(EXIT.ERROR);
			return;
		}
		if (action === "report") {
			const r = await sess.sessionReport();
			emit({ command: "session", action, ...r });
			if (!JSON_MODE) {
				if (!r.ok) {
					log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				log.raw(`task: ${r.session.task ?? "(none)"}`);
				log.dim(r.lesson.suggestion);
			}
			if (!r.ok) process.exit(EXIT.ERROR);
			return;
		}
		fail(`Unknown session action: ${action}. Use start|end|report`, { command: "session", action });
	});

// ---------------------------------------------------------------------------
// agent handoff / whoami — delegation artifacts + identity summary
// ---------------------------------------------------------------------------
program
	.command("handoff <action> [id]")
	.description(
		"Delegation artifacts: create --to <name> --task <text> | list | show <id> | accept <id> | close <id> [--lesson <topic>]",
	)
	.option("--to <name>", "(create) target agent")
	.option("--task <text>", "(create) task text")
	.option("--context <text>", "(create) context")
	.option("--lesson <topic>", "(close) file a lesson on close")
	.action(async (action, id, opts) => {
		const h = await import("./handoff.js");
		if (action === "create") {
			const r = await h.createHandoff({
				to: opts.to,
				task: opts.task,
				context: opts.context,
				cwd: process.cwd(),
			});
			emit({ command: "handoff", action, ...r });
			if (!JSON_MODE) {
				if (!r.ok) {
					log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				log.success(`Handoff ${r.id} → ${r.to}: ${pretty(r.file)}`);
			}
			if (!r.ok) process.exit(EXIT.ERROR);
			return;
		}
		if (action === "list") {
			const list = await h.listHandoffs();
			emit({ command: "handoff", action, count: list.length, handoffs: list });
			if (!JSON_MODE) {
				if (!list.length) log.info("No handoffs.");
				for (const x of list)
					log.raw(`  ${c.bold(x.id.padEnd(20))} ${x.status.padEnd(9)} → ${x.to} ${c.gray(x.task)}`);
			}
			return;
		}
		if (action === "show") {
			if (!id) fail("Usage: agent handoff show <id>");
			const r = await h.showHandoff(id);
			emit({ command: "handoff", action, ...r });
			if (!JSON_MODE) {
				if (!r.ok) {
					log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				process.stdout.write(r.content + "\n");
			}
			if (!r.ok) process.exit(EXIT.ERROR);
			return;
		}
		if (action === "accept" || action === "close") {
			if (!id) fail(`Usage: agent handoff ${action} <id>`);
			const r =
				action === "accept"
					? await h.acceptHandoff(id)
					: await h.closeHandoff(id, { lesson: opts.lesson, cwd: process.cwd() });
			emit({ command: "handoff", action, ...r });
			if (!JSON_MODE) {
				if (!r.ok) {
					log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				log.success(`${id} → ${r.status}`);
				if (r.lesson?.file) log.dim(`Lesson: ${pretty(r.lesson.file)}`);
			}
			if (!r.ok) process.exit(EXIT.ERROR);
			return;
		}
		fail(
			`Unknown handoff action: ${action}. Use create|list|show|accept|close`,
			{ command: "handoff", action },
		);
	});

program
	.command("whoami")
	.description(
		"One-line identity summary: <AGENT_NAME>, soul variant, and any field gaps.",
	)
	.action(async () => {
		const inv = await identityInventory({ scope: "global", cwd: process.cwd() });
		const gaps = {};
		for (const f of inv.files) if (f.gaps && f.gaps.length) gaps[f.kind] = f.gaps;
		const identityFile = inv.files.find((f) => f.kind === "identity");
		let who = null;
		if (identityFile?.exists) {
			const content = await readFile(identityFile.path);
			const m = /<AGENT_NAME>([^<]*)<\/AGENT_NAME>/.exec(content);
			who = m && m[1].trim() ? m[1].trim() : null;
		}
		const soulFile = inv.files.find((f) => f.kind === "soul");
		let soulVariant = null;
		if (soulFile?.exists) {
			const content = await readFile(soulFile.path);
			const m = /\(Soul variant: ([^)]+)\)/.exec(content);
			soulVariant = m ? m[1].trim() : null;
		}
		emit({ command: "whoami", identity: who, soul: soulVariant, gaps });
		if (!JSON_MODE) {
			log.raw(`  ${c.bold(who || "(name unset)")}${soulVariant ? c.gray(" · " + soulVariant) : ""}`);
			if (Object.keys(gaps).length) log.warn(`Gaps: ${JSON.stringify(gaps)}`);
			else log.success("Identity complete.");
		}
	});

// ---------------------------------------------------------------------------
// agent skill — integrated skill manager
// ---------------------------------------------------------------------------
program
	.command("skill [args...]")
	.description(
		"Integrated skill manager: setup|refresh|status|active|gate, or pass commands such as list, show, cat, install, enable, disable, update, remove.",
	)
	.allowUnknownOption(true) // skill sub-commands accept their own flags (e.g. gate --task)
	.action(async (args) => {
		const sub = args[0];
		if (sub === "setup") {
			const store = await ensureSkillStore();
			const blocks = await refreshBlocks();
			emit({ command: "skill", sub: "setup", store, blocks });
			if (!JSON_MODE)
				log.success(
					`skill-cli store ready; blocks ${blocks.changed ? "refreshed" : "current"}`,
				);
			return;
		}
		if (sub === "refresh") {
			const blocks = await refreshBlocks();
			emit({ command: "skill", sub: "refresh", blocks });
			if (!JSON_MODE)
				log.success(
					`skill-cli block ${
						blocks.changed
							? c.green("refreshed in master")
							: "already current" +
								(blocks.reason ? c.gray(" (" + blocks.reason + ")") : "")
					}`,
				);
			return;
		}
		if (sub === "status") {
			const v = skillVersion();
			emit({
				command: "skill",
				sub: "status",
				available: isSkillAvailable(),
				backend: "integrated",
				...v,
				source: v.source,
				version: v.version,
				integrated: isSkillAvailable(),
			});
			if (!JSON_MODE) {
				log.kv("available", isSkillAvailable() ? c.green("yes") : c.red("no"));
				log.kv("version", v.version ?? "none");
				log.kv("source", v.source);
				log.kv("backend", "integrated");
			}
			return;
		}
		if (sub === "active") {
			const sg = await import("./skills-gate.js");
			const effective = sg.effectiveSkills(process.cwd());
			const installed = sg.listSkills();
			const active = installed.filter((s) => effective.includes(s.name));
			emit({
				command: "skill",
				sub: "active",
				active: active.map((s) => ({
					name: s.name,
					description: s.description,
					activation: s.activation,
					triggers: s.triggers,
				})),
				effective,
			});
			if (!JSON_MODE)
				for (const s of active)
					log.raw(
						`  ${c.bold(s.name.padEnd(18))} ${s.description} ${c.gray("[" + s.activation.mode + "]")}`,
					);
			return;
		}
		if (sub === "gate") {
			const sg = await import("./skills-gate.js");
			const op = args[1];
			if (op === "ack") {
				const flags = args.slice(2);
				const readFlag = (flag) => {
					const i = flags.indexOf(flag);
					return i >= 0 ? flags[i + 1] : null;
				};
				const enable = (readFlag("--enable") || "").split(",").filter(Boolean);
				const disable = (readFlag("--disable") || "").split(",").filter(Boolean);
				const session = flags.includes("--session");
				const remember = flags.includes("--remember");
				const r = sg.gateAck({
					enable,
					disable,
					session,
					remember,
					cwd: process.cwd(),
				});
				emit({ command: "skill", sub: "gate", op: "ack", ...r });
				if (!JSON_MODE) log.success(`Gate ack ${r.decisionId}`);
				return;
			}
			if (op === "status") {
				const r = sg.gateStatus(process.cwd());
				emit({ command: "skill", sub: "gate", op: "status", ...r });
				if (!JSON_MODE)
					log.raw(`effective: ${r.effective.join(", ") || "(none)"}`);
				return;
			}
			const task = op === "--task" ? args[2] : null;
			if (!task)
				fail(
					"Usage: agent skill gate --task <text> | gate ack --enable a --disable b [--session|--remember] | gate status",
				);
			const r = sg.gateForTask(task, process.cwd());
			emit({ command: "skill", sub: "gate", ...r });
			if (!JSON_MODE) {
				log.kv("autoLoad", r.autoLoad.join(", ") || "(none)");
				log.kv("ask", r.ask.join(", ") || "(none)");
				log.kv("manual", r.manual.join(", ") || "(none)");
				for (const q of r.questions)
					log.warn(`? ${q.name}: ${q.question}`);
			}
			return;
		}
		// passthrough
		if (JSON_MODE) {
			// JSON mode: capture the skill output and wrap it in the envelope so
			// stdout stays one parseable value. The child's stderr/code are DATA,
			// not the envelope error — the child's exit code is forwarded below.
			const r = runSkill(args);
			console.log(
				serializeEnvelope(
					envelope({
						command: "skill",
						data: {
							passthrough: true,
							args,
							output: r.stdout,
							error: r.stderr,
							code: r.code,
							ok: r.ok,
						},
					}),
					{ compact: JSON_COMPACT },
				),
			);
			process.exit(typeof r.code === "number" ? r.code : r.ok ? 0 : 1);
		}
		const r = runSkill(args, { stdio: "inherit" });
		process.exit(typeof r.code === "number" ? r.code : r.ok ? 0 : 1);
	});

// ---------------------------------------------------------------------------
// agent doctor
// ---------------------------------------------------------------------------
program
	.command("snapshot [action] [args...]")
	.description(
		"Snapshot the brain; or: snapshot diff <a> <b>; --retain <n> prunes old snapshots.",
	)
	.option("--retain <n>", "keep at most n snapshots (prune older)")
	.action(async (action, args, opts) => {
		const {
			snapshot: snap,
			diffSnapshots,
			pruneSnapshots,
		} = await import("./snapshot.js");
		if (action === "diff") {
			const [a, b] = args || [];
			if (!a || !b) fail("Usage: agent snapshot diff <a> <b>");
			const r = diffSnapshots(a, b);
			emit({ command: "snapshot", action: "diff", ...r });
			if (!JSON_MODE) {
				if (!r.ok) {
					log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				log.kv("changed", r.changed.length);
				log.kv("added", r.added.length);
				log.kv("removed", r.removed.length);
				for (const f of r.changed) log.raw(`  ~ ${f}`);
			}
			if (!r.ok) process.exit(EXIT.ERROR);
			return;
		}
		const r = snap();
		let pruned = [];
		if (opts.retain) pruned = pruneSnapshots(parseInt(opts.retain, 10)).pruned;
		emit({
			command: "snapshot",
			...r,
			...(pruned.length ? { pruned } : {}),
		});
		if (!JSON_MODE) {
			log.success(`Snapshot ${r.name}: ${r.files} files → ${pretty(r.path)}`);
			if (pruned.length) log.dim(`Pruned ${pruned.length} old snapshot(s)`);
		}
	});

program
	.command("snapshots")
	.description("List brain snapshots.")
	.action(async () => {
		const { listSnapshots } = await import("./snapshot.js");
		const list = listSnapshots();
		emit({ command: "snapshots", count: list.length, snapshots: list });
		if (!JSON_MODE) {
			if (!list.length) log.info("No snapshots.");
			for (const n of list) log.raw(`  ${n}`);
		}
	});

program
	.command("restore [name]")
	.description(
		"Restore the brain from a snapshot (latest non-pre-restore if no name). --diff previews.",
	)
	.option("--relink", "re-link pointer stubs after restoring")
	.option("--diff", "preview file-level differences without restoring")
	.action(async (name, opts) => {
		const { restore, listSnapshots, snapshotDiff } = await import("./snapshot.js");
		const latest = () =>
			listSnapshots().find((n) => !n.startsWith("pre-restore-")) || null;
		if (opts.diff) {
			const target = name || latest();
			if (!target) fail("No snapshot to diff.");
			const r = snapshotDiff(target);
			emit({ command: "restore", diff: true, name: target, ...r });
			if (!JSON_MODE) {
				if (!r.ok) {
					log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				for (const f of r.changed) log.raw(`  ~ ${f}`);
				for (const f of r.added) log.raw(`  + ${f}`);
				for (const f of r.removed) log.raw(`  - ${f}`);
			}
			if (!r.ok) process.exit(EXIT.ERROR);
			return;
		}
		const list = listSnapshots();
		const target = name || list.find((n) => !n.startsWith("pre-restore-")) || list[0];
		if (!target) fail("No snapshot to restore.");
		const pre = await preSnapshot("restore");
		const r = restore(target);
		let relinked = 0;
		if (r.ok && opts.relink) {
			const cfg = await loadConfig();
			const { masterAbs, masterTilde } = ctxPaths();
			for (const id of cfg.global) {
				const t = getTarget(id);
				if (!t) continue;
				const lr = await linkTarget(t, "global", { masterAbs, masterTilde });
				if (lr.linked || lr.unchanged) relinked++;
			}
		}
		emit({
			command: "restore",
			...r,
			...(relinked ? { relinked } : {}),
			...(pre ? { preSnapshot: pre } : {}),
		});
		if (!r.ok) {
			if (!JSON_MODE) log.error(r.reason);
			process.exit(EXIT.ERROR);
		}
		if (!JSON_MODE) {
			log.success(
				`Restored ${r.name} (pre-restore backup: ${pretty(r.preRestoreBackup)})`,
			);
			if (relinked) log.dim(`${relinked} pointer(s) re-linked.`);
		}
	});

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
	.option("--for <task>", "task-aware retrieval: attach relevant search hits")
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
		sessionLoad.push({
			kind: "models",
			scope: "global",
			path: modelsMdPath,
			exists: modelsMdExists,
			filled: null,
			gaps: null,
		});
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
		// --for: task-aware retrieval (search over the brain).
		let forTask = null;
		if (opts.forTask) {
			const searchMod = await import("./search.js");
			const sr = await searchMod.searchAll(opts.forTask, { project: true });
			forTask = { query: opts.forTask, hits: sr.results.slice(0, 5) };
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
	.command("run [ids...]")
	.description(
		"Execute brief actions by id (agent run link:claude …); --safe limits to safeToAutomate.",
	)
	.option("--safe", "only run safeToAutomate actions")
	.action(async (ids, opts) => {
		const actMod = await import("./actions.js");
		const s = await actMod.collectState();
		const all = actMod.buildActions(s);
		const byId = new Map(all.map((a) => [a.id, a]));
		const selected = ids.length ? ids.map((id) => byId.get(id)).filter(Boolean) : all;
		if (ids.length && selected.length !== ids.length) {
			const missing = ids.filter((id) => !byId.has(id));
			fail(`Unknown action id${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`, {
				command: "run",
				missing,
			});
		}
		const toRun = opts.safe ? selected.filter((a) => a.safeToAutomate) : selected;
		const res = actMod.applySafe(toRun);
		emit({
			command: "run",
			ids: toRun.map((a) => a.id),
			receipts: res.receipts,
			applied: res.applied,
			skipped: res.skipped,
		});
		if (!JSON_MODE)
			for (const r of res.receipts)
				log.raw(
					`  ${r.applied ? c.green("✓") : c.gray("·")} ${r.id}${r.stderr ? c.yellow(" — " + r.stderr) : ""}`,
				);
		// no-op (nothing attempted) and full success both exit 0; a failed action exits 1.
		const attempted = res.receipts.filter((r) => !r.skipped);
		process.exit(attempted.some((r) => !r.applied) ? EXIT.ERROR : EXIT.OK);
	});

program
	.command("action <sub> [id]")
	.description("Action feedback loop: verify <id> (run its verification command).")
	.action(async (sub, id) => {
		if (sub !== "verify") fail(`Unknown action sub: ${sub}. Use verify`, { command: "action", sub });
		if (!id) fail("Usage: agent action verify <action-id>");
		const actMod = await import("./actions.js");
		const s = await actMod.collectState();
		const action = actMod.buildActions(s).find((a) => a.id === id);
		if (!action) fail(`Unknown action id: ${id}`, { command: "action", sub, id });
		const r = actMod.verifyAction(action);
		emit({
			command: "action",
			sub: "verify",
			id,
			verified: r.verified,
			reason: r.reason,
			code: r.code,
			output: r.output,
		});
		if (!JSON_MODE)
			log.raw(
				`${r.verified == null ? "No verification command." : r.verified ? "✓ verified" : "✗ not verified"} ${id}`,
			);
		process.exit(r.verified === false ? EXIT.ERROR : EXIT.OK);
	});

// ---------------------------------------------------------------------------
// agent config / version / completion — ergonomics
// ---------------------------------------------------------------------------
program
	.command("config")
	.description("Print the config path + effective settings (config.json).")
	.action(async () => {
		const cfg = await loadConfig();
		emit({ command: "config", path: CONFIG_FILE, config: cfg });
		if (!JSON_MODE) {
			log.kv("path", pretty(CONFIG_FILE));
			log.kv("global", cfg.global.join(", ") || "(none)");
			log.kv("seedVersion", cfg.seedVersion ?? "(none)");
			log.kv("skillManaged", String(cfg.skillManaged));
			log.kv("sync", cfg.sync ? "configured" : "(none)");
		}
	});

program
	.command("version")
	.description("Print the installed agent-cli version.")
	.action(async () => {
		emit({ command: "version", version: VERSION });
		if (!JSON_MODE) log.raw(VERSION);
	});

program
	.command("completion <shell>")
	.description("Print a shell completion script (bash|zsh|fish|powershell).")
	.action(async (shell) => {
		const names = [...new Set(collectCommands().map((c) => c.name.split(" ")[0]))].sort();
		const words = names.join(" ");
		let script = null;
		if (shell === "bash")
			script = `_agent() { COMPREPLY=( $(compgen -W "${words}" -- "\${COMP_WORDS[1]}") ); }\ncomplete -F _agent agent\n`;
		else if (shell === "zsh")
			script = `#compdef agent\n_arguments '1:command:(${words})'\n`;
		else if (shell === "fish")
			script = `complete -c agent -f -a "${words}"\n`;
		else if (shell === "powershell")
			script = `Register-ArgumentCompleter -Native -CommandName agent -ScriptBlock { param($w,$c,$p) "${words}".Split(" ") | Where-Object { $_ -like "$c*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) } }\n`;
		if (!script)
			fail(`Unsupported shell: ${shell}. Use bash|zsh|fish|powershell`, {
				command: "completion",
				shell,
			});
		emit({ command: "completion", shell, script });
		if (!JSON_MODE) process.stdout.write(script);
	});

program
	.command("setup")
	.description(
		"One-pass setup: init, detect targets, suggest models, snapshot, and readiness.",
	)
	.action(async () => {
		const steps = {};
		const cfg = await loadConfig();
		// 1. master
		const master = await readMaster();
		if (master == null) {
			const init = await (async () => {
				// reuse the init command's action via direct orchestration below
				const { ensureMaster } = await import("./store.js");
				const m = await ensureMaster();
				if (m.skipped) return { skipped: m.skipped };
				const installed = await detectInstalled();
				for (const id of installed) {
					const t = getTarget(id);
					if (t && t.global) enableGlobal(cfg, id);
				}
				await saveConfig(cfg);
				return { master: m.action, targets: installed };
			})();
			steps.init = init;
		} else {
			steps.init = { existing: true };
		}
		// 2. skill store
		steps.skill = await ensureSkillStore();
		// 3. models suggest
		const unresolved = await findUnresolvedModels();
		steps.models = { unresolved: unresolved.map((u) => u.name), count: unresolved.length };
		// 4. snapshot
		const { snapshot: snap } = await import("./snapshot.js");
		steps.snapshot = snap().name;
		// 5. readiness
		const doctorMod = await import("./actions.js");
		const s = await doctorMod.collectState({ offline: true });
		steps.readiness = {
			health: s.masterContent == null ? "degraded" : s.drift.length || s.archetypeNeeded ? "degraded" : "ready",
			actions: doctorMod.buildActions(s).length,
		};
		emit({ command: "setup", steps });
		if (!JSON_MODE) {
			log.success(`Setup complete — ${steps.readiness.health}, ${steps.readiness.actions} action(s) pending.`);
			log.kv("models", `${steps.models.count} unresolved`);
			log.dim(`Next: agent brief --check · agent models suggest · agent brief --apply-safe`);
		}
	});

// ---------------------------------------------------------------------------
// Composite commands: day-start / session-start / stats / archetype / template
// / project / models lint|usage|test
// ---------------------------------------------------------------------------
program
	.command("day-start")
	.description("Session-start composite: effective skills + brief actions in one pass.")
	.option("--offline", "never hit the network")
	.option("--check", "exit 2 when actions exist")
	.action(async (opts) => {
		const sg = await import("./skills-gate.js");
		const actMod = await import("./actions.js");
		const s = await actMod.collectState({ offline: !!opts.offline });
		const actions = actMod.buildActions(s);
		const effectiveSkills = sg.effectiveSkills(process.cwd());
		const health =
			s.masterContent == null || s.drift.length || s.archetypeNeeded
				? "degraded"
				: "ready";
		emit({
			command: "day-start",
			health,
			actions,
			suggestedActions: actMod.suggestedStrings(actions),
			effectiveSkills,
			sessionLoad: s.sessionLoad,
		});
		if (!JSON_MODE) {
			log.raw(
				`${c.bold("day-start")} — ${c.gray(health)} · ${actions.length} action(s) · ${effectiveSkills.length} active skill(s)`,
			);
			for (const a of actions) log.raw(`  ${a.id}${a.safeToAutomate ? c.green(" ✓safe") : ""}`);
		}
		if (opts.check) process.exit(actions.length ? EXIT.WORK : EXIT.OK);
	});

program
	.command("session-start [task...]")
	.description("Start a session and emit the brief actions (session + day-start).")
	.option("--offline", "never hit the network")
	.action(async (task, opts) => {
		const sess = await import("./session.js");
		const sr = await sess.sessionStart({
			task: task ? task.join(" ") : null,
			cwd: process.cwd(),
		});
		const actMod = await import("./actions.js");
		const s = await actMod.collectState({ offline: !!opts.offline });
		const actions = actMod.buildActions(s);
		emit({
			command: "session-start",
			session: sr.session,
			actions,
			suggestedActions: actMod.suggestedStrings(actions),
		});
		if (!JSON_MODE)
			log.success(`Session started — ${actions.length} action(s) pending.`);
	});

program
	.command("stats")
	.description("Local, privacy-safe usage stats: snapshots, backups, lessons, config age.")
	.action(async () => {
		const { listSnapshots } = await import("./snapshot.js");
		const memMod = await import("./memory.js");
		const { listLessons } = await import("./lessons-lib.js");
		const sessMod = await import("./session.js");
		const cfg = await loadConfig();
		const snaps = listSnapshots();
		const backups = memMod.backupsList().backups;
		const lessons = await listLessons({ includeProject: true });
		const session = sessMod.readSession();
		emit({
			command: "stats",
			snapshots: snaps.length,
			backups: backups.length,
			lessons: lessons.length,
			updatedAt: cfg.updatedAt,
			session: session ? { startedAt: session.startedAt, task: session.task } : null,
		});
		if (!JSON_MODE) {
			log.kv("snapshots", snaps.length);
			log.kv("backups", backups.length);
			log.kv("lessons", lessons.length);
			log.kv("config updated", cfg.updatedAt ?? "(never)");
		}
	});

program
	.command("archetype <action> [arg]")
	.description("Identity/soul archetypes: list | export <id> | import <file>.")
	.option("-p, --project", "project scope (for import)")
	.action(async (action, arg, opts) => {
		const arc = await import("./archetypes.js");
		const idMod = await import("./identity.js");
		if (action === "list") {
			emit({
				command: "archetype",
				action,
				identities: idMod.listIdentities(),
				souls: idMod.listSouls(),
			});
			if (!JSON_MODE) {
				for (const i of idMod.listIdentities())
					log.raw(`  ${c.bold("identity")} ${i.key.padEnd(18)} ${i.label}`);
				for (const s of idMod.listSouls())
					log.raw(`  ${c.bold("soul")}     ${s.key.padEnd(18)} ${s.label}`);
			}
			return;
		}
		if (action === "export") {
			if (!arg) fail("Usage: agent archetype export <identity|soul-id>");
			const isSoul = idMod.listSouls().some((s) => s.key === arg);
			const content = isSoul ? arc.soulContent(arg) : arc.identityContent(arg);
			emit({ command: "archetype", action, kind: isSoul ? "soul" : "identity", id: arg, content });
			if (!JSON_MODE) process.stdout.write(content + "\n");
			return;
		}
		if (action === "import") {
			if (!arg) fail("Usage: agent archetype import <file>");
			const fsp = await import("node:fs/promises");
			let content;
			try {
				content = await fsp.readFile(arg, "utf8");
			} catch {
				fail(`Not found: ${arg}`);
			}
			if (!/^# IDENTITY\.md/m.test(content))
				fail(`Not a valid identity archetype file: ${arg}`);
			const scope = opts.project ? "project" : "global";
			const file = idMod.idFile(scope);
			await writeFile(file, content);
			emit({ command: "archetype", action, name: arg, file });
			if (!JSON_MODE) log.success(`Imported archetype → ${pretty(file)}`);
			return;
		}
		fail(`Unknown archetype action: ${action}. Use list|export|import`, {
			command: "archetype",
			action,
		});
	});

program
	.command("template install <source>")
	.description("Install a personality bundle (agents/*.md) from a local dir or git URL.")
	.action(async (source) => {
		const fsp = await import("node:fs/promises");
		const { spawnSync } = await import("node:child_process");
		const os = await import("node:os");
		let bundleDir = null;
		let tmp = null;
		if (await exists(path.resolve(source))) {
			bundleDir = path.resolve(source);
		} else {
			tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-template-"));
			const r = spawnSync("git", ["clone", "--depth", "1", source, path.join(tmp, "bundle")], {
				encoding: "utf8",
			});
			if (!r.ok || r.status !== 0)
				fail(`template fetch failed: ${(r.stderr || "").slice(0, 300)}`);
			bundleDir = path.join(tmp, "bundle");
		}
		const candidates = [path.join(bundleDir, "agents"), bundleDir];
		const installed = [];
		for (const dir of candidates) {
			let entries = [];
			try {
				entries = await fsp.readdir(dir);
			} catch {
				continue;
			}
			for (const e of entries) {
				if (!e.endsWith(".md")) continue;
				const content = await fsp.readFile(path.join(dir, e), "utf8");
				const m = /^name:\s*(\S+)/m.exec(content);
				const name = (m ? m[1] : e.replace(/\.md$/, "")).replace(/[^A-Za-z0-9._-]/g, "");
				const target = path.join(AGENTS_DIR, "agents", `${name}.md`);
				await writeFile(target, content);
				installed.push(name);
			}
		}
		if (tmp) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
		emit({ command: "template", action: "install", source, installed });
		if (!JSON_MODE) {
			if (!installed.length) log.info("No agents/*.md found in the bundle.");
			for (const n of installed) log.success(`Installed ${n}`);
		}
	});

program
	.command("project <action>")
	.description(
		"Project tooling: detect (fingerprint) | init (scaffold project .agents) | doctor (pointer health vs global).",
	)
	.option("-p, --project", "scope (default project)")
	.action(async (action) => {
		const cwd = process.cwd();
		const fsp = await import("node:fs/promises");
		if (action === "detect") {
			const out = { name: path.basename(cwd), git: false, packageManager: null, files: {} };
			try {
				await fsp.access(path.join(cwd, ".git"));
				out.git = true;
			} catch {}
			for (const [k, f] of [
				["package.json", "npm"],
				["pyproject.toml", "poetry"],
				["go.mod", "go"],
				["Cargo.toml", "cargo"],
				["Gemfile", "bundler"],
				["pom.xml", "maven"],
			]) {
				try {
					await fsp.access(path.join(cwd, f));
					out.packageManager = out.packageManager ?? k === "package.json" ? "npm" : k;
					out.files[f] = true;
				} catch {}
			}
			emit({ command: "project", action, ...out });
			if (!JSON_MODE) {
				log.kv("name", out.name);
				log.kv("git", out.git ? "yes" : "no");
				log.kv("packageManager", out.packageManager ?? "(none)");
			}
			return;
		}
		if (action === "init") {
			const { ensureMaster } = await import("./store.js");
			// project master at [cwd]/.agents/AGENTS.md
			const masterPath = projectMasterPath(cwd);
			const created = [];
			const arc = await import("./archetypes.js");
			const files = [
				["AGENTS.md", "# Project agent\n\n> Managed by agent-cli (project scope).\n"],
				["IDENTITY.md", arc.identityContent(arc.DEFAULT_IDENTITY)],
				["SOUL.md", arc.soulContent(arc.DEFAULT_SOUL)],
				["USER.md", arc.userContent()],
				["LESSONS.md", arc.lessonsContent()],
				["ENVIRONMENTS.md", arc.environmentsContent()],
			];
			for (const [name, content] of files) {
				const fp = path.join(path.dirname(masterPath), name);
				if (await exists(fp)) continue;
				await writeFile(fp, content);
				created.push(name);
			}
			emit({ command: "project", action, master: masterPath, created });
			if (!JSON_MODE) {
				log.success(`Project .agents scaffolded at ${pretty(path.dirname(masterPath))}`);
				if (created.length) log.dim(`Created: ${created.join(", ")}`);
			}
			return;
		}
		if (action === "doctor") {
			const issues = [];
			const checks = [];
			const masterPath = projectMasterPath(cwd);
			const masterOk = await exists(masterPath);
			checks.push({ check: "project-master-exists", ok: masterOk, detail: pretty(masterPath) });
			if (!masterOk) issues.push("project master missing — run agent project init");
			const cfg = await loadConfig();
			const projIds = effectiveProjectIds(cfg);
			for (const id of projIds) {
				const t = getTarget(id);
				if (!t || !t.project) continue;
				const cls = await classify(t, "project");
				checks.push({ check: `pointer:${id}`, ok: cls.state === "pointer", detail: cls.state + " " + pretty(cls.path) });
				if (cls.state !== "pointer") issues.push(`${id} project pointer ${cls.state} — run agent link -p`);
			}
			emit({ command: "project", action: "doctor", issues, checks });
			if (!JSON_MODE)
				for (const c of checks)
					log.raw(`  ${c.ok ? c.green("✓") : c.red("✗")} ${c.check.padEnd(24)} ${c.gray(c.detail)}`);
			if (issues.length) process.exit(EXIT.WORK);
			return;
		}
		fail(`Unknown project action: ${action}. Use detect|init|doctor`, {
			command: "project",
			action,
		});
	});

// ---------------------------------------------------------------------------
// agent manifest / schema — machine-readable command surface + contract
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// agent serve / watch / hooks / automation — reactive & scheduled automation
// ---------------------------------------------------------------------------
program
	.command("serve")
	.description("Run the MCP server over stdio (MCP tools: brief, doctor, search, snapshot, status, spect).")
	.option("--mcp", "explicit: serve MCP (default)")
	.action(async (opts) => {
		const serve = await import("./serve.js");
		// MCP speaks raw JSON-RPC — never emit the envelope here.
		JSON_MODE = false;
		await serve.serve();
	});

program
	.command("watch")
	.description("Watch agent state (~/.agents, .agents, skill.config, .spect) and print change events.")
	.option("--interval <ms>", "poll interval ms (default 1000)")
	.action(async (opts) => {
		const auto = await import("./automation.js");
		const interval = Math.max(200, parseInt(opts.interval || "1000", 10) || 1000);
		const targets = auto.watchTargets(process.cwd());
		let last = auto.fingerprintAll(targets);
		if (!JSON_MODE) {
			log.raw(c.bold("watch") + c.gray(" — " + targets.map((t) => t.type).join(", ") + ` (poll ${interval}ms). Ctrl+C to stop.`));
		}
		// eslint-disable-next-line no-constant-condition
		while (true) {
			await new Promise((r) => setTimeout(r, interval));
			const now = auto.fingerprintAll(targets);
			const events = auto.diffFingerprints(last, now);
			last = now;
			for (const e of events) {
				if (JSON_MODE) process.stdout.write(JSON.stringify({ type: e.type, path: e.path }) + "\n");
				else log.raw(`  ${c.cyan(e.type.padEnd(7))} ${pretty(e.path)}`);
			}
		}
	});

program
	.command("hooks <action>")
	.description("Manage git hooks: install | remove | list. Hooks re-point agent files after merge/checkout.")
	.option("--git", "git hooks (default)")
	.option("--with-automation", "also run `automation run --event post-merge`")
	.action(async (action, opts) => {
		const auto = await import("./automation.js");
		if (action === "install") {
			let installed;
			try {
				installed = auto.installGitHooks({ withAutomation: !!opts.withAutomation });
			} catch (e) {
				fail(e.message, { command: "hooks", action });
			}
			emit({ command: "hooks", action, installed });
			if (!JSON_MODE) {
				log.success(`Installed git hooks: ${installed.join(", ")}`);
				log.dim("They run `agent link` after every merge/checkout.");
			}
			return;
		}
		if (action === "remove") {
			const removed = auto.removeGitHooks();
			emit({ command: "hooks", action, removed });
			if (!JSON_MODE) log.success(`Removed ${removed} agent-managed git hook(s).`);
			return;
		}
		if (action === "list") {
			const fsp = await import("node:fs");
			const autoMod = await import("./automation.js");
			const hooksDir = autoMod.gitHookPath(process.cwd());
			const present = ["post-merge", "post-checkout"].filter((h) => fsp.existsSync(path.join(hooksDir, h)));
			const managed = present.filter((h) => {
				const c = fsp.readFileSync(path.join(hooksDir, h), "utf8");
				return c.includes("Managed by agent-cli");
			});
			emit({ command: "hooks", action, present, managed });
			if (!JSON_MODE) {
				if (!present.length) log.info("No git hooks installed.");
				else for (const h of present) log.raw(`  ${managed.includes(h) ? c.green("✓") : c.gray("·")} ${h}`);
			}
			return;
		}
		fail(`Unknown hooks action: ${action}. Use install|remove|list`, { command: "hooks", action });
	});

program
	.command("automation <action> [name]")
	.description(
		"Reactive/scheduled jobs: add | list | remove | run. Jobs live in ~/.agents/automation.json.",
	)
	.option("--event <e>", "event name (session-start, day-start, sync, memory, snapshot, post-merge, post-checkout)")
	.option("--command <c>", "shell command to run when the event fires")
	.option("--cwd <dir>", "working directory for the command (default: current)")
	.option("--check", "exit 2 when any job matched/failed (for CI)")
	.action(async (action, name, opts) => {
		const auto = await import("./automation.js");
		if (action === "add") {
			if (!name) fail("Usage: agent automation add <name> --event <e> --command <cmd>", { command: "automation", action });
			if (!opts.event) fail("--event is required (one of: " + auto.EVENTS.join(", ") + ")", { command: "automation", action });
			if (!auto.EVENTS.includes(opts.event))
				fail(`Unknown event: ${opts.event} (valid: ${auto.EVENTS.join(", ")})`, { command: "automation", action });
			if (!opts.command) fail("--command is required", { command: "automation", action });
			let job;
			try {
				job = auto.addJob({ name, event: opts.event, command: opts.command, cwd: opts.cwd || null });
			} catch (e) {
				fail(e.message, { command: "automation", action });
			}
			emit({ command: "automation", action, job });
			if (!JSON_MODE) log.success(`Job '${name}' → on ${opts.event} run: ${opts.command}`);
			return;
		}
		if (action === "list") {
			const jobs = auto.readJobs();
			emit({ command: "automation", action, jobs });
			if (!JSON_MODE) {
				if (!jobs.length) log.info("No automation jobs. Add one: agent automation add <name> --event session-start --command \"…\"");
				for (const j of jobs) log.raw(`  ${c.bold(j.name.padEnd(16))} ${c.cyan(j.event.padEnd(14))} ${c.gray(j.command)}`);
			}
			return;
		}
		if (action === "remove") {
			if (!name) fail("Usage: agent automation remove <name>", { command: "automation", action });
			const removed = auto.removeJob(name);
			emit({ command: "automation", action, name, removed });
			if (!JSON_MODE) log.success(removed ? `Removed job '${name}'.` : `No job named '${name}'.`);
			return;
		}
		if (action === "run") {
			const event = opts.event || "*";
			const results = auto.runJobs({ event, cwd: opts.cwd || process.cwd() });
			const failed = results.filter((r) => r.status !== "ok").length;
			emit({ command: "automation", action, event, results, matched: results.length, failed });
			if (!JSON_MODE) {
				if (!results.length) log.info(`No jobs match event '${event}'.`);
				for (const r of results)
					log.raw(`  ${r.status === "ok" ? c.green("✓") : c.red("✗")} ${c.bold(r.name)} ${c.gray(r.status + (r.code != null ? " (" + r.code + ")" : ""))}`);
			}
			if (opts.check && failed) process.exit(EXIT.WORK);
			return;
		}
		fail(`Unknown automation action: ${action}. Use add|list|remove|run`, { command: "automation", action });
	});

program
	.command("manifest")
	.description(
		"Emit the machine-readable command surface + exit-code contract.",
	)
	.action(async () => {
		emit({
			command: "manifest",
			commands: collectCommands(),
			exitCodes: EXIT,
		});
	});

program
	.command("schema [command]")
	.description("Print the JSON envelope contract (or one command's shape).")
	.action(async (name) => {
		const contract = {
			ok: "boolean",
			command: "string",
			apiVersion: "string",
			data: "object",
			error: "string (optional)",
		};
		if (name) {
			const cmd = program.commands.find((c) => c.name() === name);
			if (!cmd) fail(`Unknown command: ${name}`, { command: "schema", name });
			emit({
				command: "schema",
				envelope: contract,
				exitCodes: EXIT,
				requested: {
					name: cmd.name(),
					description: cmd.description(),
					options: (cmd.options || []).map((o) => o.flags),
				},
			});
			return;
		}
		emit({ command: "schema", envelope: contract, exitCodes: EXIT });
	});

// `agent help [command]` — explicit subcommand so the built-in help command is
// not swallowed by the root action below. Help is success: exit 0.
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
