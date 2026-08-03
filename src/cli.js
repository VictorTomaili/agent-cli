#!/usr/bin/env node
// src/cli.js — agent-cli entry point. AI-first: --json everywhere, idempotent, no
// interactive prompts (safe for agents/CI). Pointer model: edit ~/.agents/AGENTS.md
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
	AGENTS_DIR,
	exists,
	readFile,
	writeFile,
} from "./util.js";
import { TARGETS, getTarget, targetsWithScope, pathFor } from "./targets.js";
import {
	loadConfig,
	saveConfig,
	enableGlobal,
	disableGlobal,
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
	submodulePresent,
	globalSkillBin,
} from "./skill.js";

const PKG = createRequire(import.meta.url)("../package.json");
const VERSION = PKG.version;
const PKG_NAME = PKG.name;

// Silence Node's DEP0190 (spawn shell:true) deprecation — every arg we pass to a
// shell is internal/trusted (skill-cli invocations). Correctness on pnpm POSIX-shim
// setups requires shell:true, so we suppress only this one warning.
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
function emit(obj) {
	if (JSON_MODE) console.log(JSON.stringify(obj, null, 2));
	return obj;
}

function ctxPaths() {
	return { masterAbs: MASTER_FILE, masterTilde: masterTilde() };
}

function selectedTargets(scope, ids) {
	const pool = targetsWithScope(scope);
	if (ids && ids.length) {
		const set = new Set(ids);
		return pool.filter((t) => set.has(t.id));
	}
	return pool;
}

const program = new Command();
program
	.name("agent")
	.description(
		"Manage AGENTS.md and point every coding agent at one canonical source (~/.agents/AGENTS.md). Bundles skill-cli.",
	)
	.version(VERSION, "-v, --version")
	.option("--json", "Emit machine-readable JSON (AI/CI friendly)")
	.hook("preAction", (cmd) => {
		JSON_MODE = !!cmd.optsWithGlobals().json;
		setExpectedCtx(ctxPaths());
	});

// ---------------------------------------------------------------------------
// agent init
// ---------------------------------------------------------------------------
program
	.command("init")
	.description(
		"Bootstrap ~/.agents/ master, deploy pointer stubs, and set up skill-cli.",
	)
	.option("--no-skill", "Skip skill-cli setup")
	.option(
		"--yes",
		"Confirm any non-interactive defaults (no-op; agent-cli never prompts)",
	)
	.action(async (opts) => {
		const result = { command: "init", steps: {} };

		// 1. master + managed blocks
		const master = await ensureMaster();
		result.steps.master = master;

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
		}

		// 4. seed defaults: first install writes them into ~/.agents; a version bump
		//    stages new defaults into ~/.agents/update-<version>/ for review.
		//    Existing user files are never overwritten.
		const seed = await import("./seed.js");
		const seedPlan = seed.planSeedAction(cfg.seedVersion, VERSION);
		if (seedPlan.action === "install") {
			result.steps.seeds = await seed.installSeeds({ home: AGENTS_DIR });
		} else if (seedPlan.action === "stage") {
			result.steps.seeds = await seed.stageSeeds({
				home: AGENTS_DIR,
				version: VERSION,
			});
		}
		cfg.seedVersion = VERSION;

		await saveConfig(cfg);

		// 4b. seed the full identity/memory file set (NON-DESTRUCTIVE) + model aliases.
		//     Skips any file the user already has; ensures fresh installs have the full
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
		const aliases = models.ensureDefaultAliases();
		const modelsMdPath = models.MODELS_MD;
		let modelsMdCreated = false;
		if (!(await exists(modelsMdPath))) {
			models.writeModelsMd();
			modelsMdCreated = true;
		}
		result.steps.identityFiles = { created: idCreated, skipped: idSkipped };
		result.steps.models = {
			aliases: Object.keys(aliases).length,
			modelsMdCreated,
		};

		// 5. deploy pointers (non-destructive; auto-convert the seed source)
		const { masterAbs, masterTilde: mTilde } = ctxPaths();
		const seedId = master.seed ? getTargetByFile(master.seed) : null;
		const deploy = [];
		for (const id of cfg.global) {
			const t = getTarget(id);
			if (!t) continue;
			const force = seedId === id; // seed content already lives in master
			const r = await linkTarget(t, "global", {
				masterAbs,
				masterTilde: mTilde,
				force,
			});
			deploy.push({ id, name: t.name, ...r });
		}
		result.steps.deploy = deploy;
		result.config = { global: cfg.global, project: cfg.project };

		emit(result);
		if (!JSON_MODE) {
			log.success(
				`Master ready at ${c.cyan(mTilde)} (${master.action}${master.seed ? " ← " + master.seed : ""})`,
			);
			const linked = deploy.filter((d) => d.linked).length;
			const blocked = deploy.filter((d) => d.blocked);
			log.info(
				`Pointers: ${c.green(linked + " linked")}, ${cfg.global.length} global targets enabled`,
			);
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
	.action(async (opts) => {
		const cfg = await loadConfig();
		const scopes = [];
		if (opts.global) scopes.push("global");
		if (opts.project) scopes.push("project");
		if (scopes.length === 0) scopes.push("global");
		const { masterAbs, masterTilde } = ctxPaths();
		const out = { command: "link", scopes, results: [] };
		for (const scope of scopes) {
			let ids = opts.target;
			if (!ids)
				ids = scope === "global" ? cfg.global : effectiveProjectIds(cfg);
			const targets = selectedTargets(scope, ids);
			for (const t of targets) {
				const r = await linkTarget(t, scope, {
					masterAbs,
					masterTilde,
					force: !!opts.force,
				});
				out.results.push({ id: t.id, name: t.name, scope, ...r });
			}
		}
		emit(out);
		if (!JSON_MODE) {
			const linked = out.results.filter((r) => r.linked).length;
			const ok = out.results.filter((r) => r.unchanged).length;
			const blocked = out.results.filter((r) => r.blocked);
			log.success(`${linked} linked, ${ok} up-to-date`);
			if (blocked.length)
				for (const b of blocked)
					log.warn(`${b.name}: native content — pull first or use --force`);
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
			for (const t of targets) {
				const r = await unlinkTarget(t, scope);
				out.results.push({ id: t.id, name: t.name, scope, ...r });
			}
		}
		emit(out);
		if (!JSON_MODE) {
			const n = out.results.filter((r) => r.unlinked).length;
			log.success(`${n} pointer stubs removed`);
		}
	});

// ---------------------------------------------------------------------------
// agent status / targets / target enable|disable
// ---------------------------------------------------------------------------
program
	.command("status")
	.description(
		"Show master state, per-target pointer health, and skill-cli state.",
	)
	.action(async () => {
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
			targets,
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
			for (const t of targets) {
				const tag =
					t.global?.state === "pointer"
						? c.green("●")
						: t.global?.state === "native"
							? c.yellow("●")
							: t.global?.state === "missing"
								? c.gray("○")
								: c.gray("○");
				const en = t.globalEnabled ? c.green("on") : c.gray("off");
				log.raw(
					`  ${tag} ${c.bold(t.id.padEnd(9))} ${t.name.padEnd(34)} ${en} ${c.gray(t.global?.path ? pretty(t.global.path) : "(no global)")}`,
				);
			}
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

program
	.command("target <action> [id]")
	.description("enable|disable a target globally (--project for project scope)")
	.option("-g, --global")
	.option("-p, --project")
	.action(async (action, id, opts) => {
		if (!id || !["enable", "disable", "on", "off"].includes(action)) {
			log.error("Usage: agent target enable|disable <id> [-g|-p]");
			process.exit(1);
		}
		const t = getTarget(id);
		if (!t) {
			log.error(`Unknown target: ${id}. Run ${c.cyan("agent targets")}.`);
			process.exit(1);
		}
		const scope = opts.project ? "project" : "global";
		const cfg = await loadConfig();
		const enabling = action === "enable" || action === "on";
		if (scope === "global")
			enabling ? enableGlobal(cfg, id) : disableGlobal(cfg, id);
		else
			enabling
				? (cfg.project = Array.from(
						new Set([...(Array.isArray(cfg.project) ? cfg.project : []), id]),
					))
				: (cfg.project = (
						Array.isArray(cfg.project) ? cfg.project : effectiveProjectIds(cfg)
					).filter((x) => x !== id));
		await saveConfig(cfg);
		const { masterAbs, masterTilde } = ctxPaths();
		let linked = null;
		if (enabling) {
			const r = await linkTarget(t, scope, { masterAbs, masterTilde });
			linked = r;
		} else {
			linked = await unlinkTarget(t, scope);
		}
		emit({
			command: "target",
			action,
			id,
			scope,
			config: { global: cfg.global, project: cfg.project },
			result: linked,
		});
		if (!JSON_MODE)
			log.success(`${enabling ? "enabled" : "disabled"} ${id} (${scope})`);
	});

// ---------------------------------------------------------------------------
// agent edit / pull / where
// ---------------------------------------------------------------------------
program
	.command("edit [kind]")
	.description(
		"Open a unified home file in $EDITOR. kind: agents (default) | soul | identity | user | lessons",
	)
	.option("--print-path", "Just print the resolved path (for agents) and exit")
	.option("-p, --project", "Edit the project-local copy")
	.action(async (kind, opts) => {
		const scope = opts.project ? "project" : "global";
		let target = MASTER_FILE;
		if (kind && kind !== "agents") {
			target = identityFilePath(kind, scope);
			if (!target) {
				log.error(
					`Unknown kind: ${kind}. Use: agents|soul|identity|user|lessons`,
				);
				process.exit(1);
			}
			if (!(await exists(target))) {
				const arc = await import("./archetypes.js");
				let tpl = `# ${kind.toUpperCase()}.md\n\n`;
				if (kind === "identity") tpl = arc.identityContent("general-purpose");
				else if (kind === "soul") tpl = arc.soulContent("pragmatist");
				else if (kind === "user") tpl = arc.userContent();
				await writeFile(target, tpl);
			}
		}
		emit({ command: "edit", kind: kind || "agents", path: target });
		if (opts.printPath) {
			process.stdout.write(target + "\n");
			return;
		}
		const editor =
			process.env.VISUAL ||
			process.env.EDITOR ||
			(process.platform === "win32" ? "notepad" : "vi");
		spawnSync(editor, [target], { stdio: "inherit", shell: true });
	});

program
	.command("agents [action] [name]")
	.description(
		"Manage reusable sub-agent personalities: list | show <name> | new <name> | validate [name] | path",
	)
	.option("-p, --project", "project-local scope (for new)")
	.action(async (action, name, opts) => {
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
				log.error("Usage: agent agents show <name>");
				process.exit(1);
			}
			const a = await showAgent(name, { cwd });
			if (!a) {
				log.error(`No agent named '${name}'`);
				process.exit(1);
			}
			const fsp = (await import("node:fs/promises")).default;
			const content = await fsp.readFile(a.path, "utf8");
			if (JSON_MODE) emit({ command: "agents", action, agent: a, content });
			else process.stdout.write(content);
			return;
		}
		if (action === "new") {
			if (!name) {
				log.error("Usage: agent agents new <name>");
				process.exit(1);
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
			const targets = name ? list.filter((a) => a.name === name) : list;
			const results = [];
			for (const a of targets) results.push(await validateAgent(a.path));
			emit({ command: "agents", action: "validate", results });
			if (!JSON_MODE)
				for (const r of results)
					log.raw(
						`  ${r.valid ? c.green("✓") : c.red("✗")} ${c.bold(r.name)} ${r.issues.length ? c.gray(r.issues.join("; ")) : c.green("ok")}`,
					);
			return;
		}
		log.error(`Unknown action: ${action}. Use list|show|new|validate|path`);
		process.exit(1);
	});

program
	.command("identity [action] [rest...]")
	.description(
		"Identity archetypes: list | apply <id> [--soul <v>] | set <section> <value...>. -p project.",
	)
	.option("-p, --project", "project scope")
	.option("--soul <variant>", "also apply this soul variant")
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
				log.error("Usage: agent identity apply <id>");
				process.exit(1);
			}
			const r = await id.applyIdentity(key, { scope, cwd });
			let soul = null;
			if (opts.soul) {
				const sr = await id.applySoul(opts.soul, { scope, cwd });
				soul = sr.soul;
			}
			emit({ command: "identity", action, ...r, soul });
			if (!JSON_MODE)
				log.success(
					`Identity '${key}'${soul ? ` + soul '${soul}'` : ""} → ${pretty(r.file)}`,
				);
			return;
		}
		if (action === "set") {
			const [section, ...val] = rest;
			if (!section) {
				log.error("Usage: agent identity set <section> <value...>");
				process.exit(1);
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
		log.error(`Unknown action: ${action}. Use list|apply|set`);
		process.exit(1);
	});

program
	.command("soul [action] [rest...]")
	.description(
		"Soul variants: list | apply <variant> | set <section> <value...>. -p project.",
	)
	.option("-p, --project", "project scope")
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
				log.error("Usage: agent soul apply <variant>");
				process.exit(1);
			}
			const r = await id.applySoul(key, { scope, cwd });
			emit({ command: "soul", action, ...r });
			if (!JSON_MODE) log.success(`Soul '${key}' → ${pretty(r.file)}`);
			return;
		}
		if (action === "set") {
			const [section, ...val] = rest;
			if (!section) {
				log.error("Usage: agent soul set <section> <value...>");
				process.exit(1);
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
		log.error(`Unknown action: ${action}. Use list|apply|set`);
		process.exit(1);
	});

program
	.command("user [action] [rest...]")
	.description(
		"USER.md: apply (write template) | set <field> <value...>. -p project.",
	)
	.option("-p, --project", "project scope")
	.action(async (action, rest, opts) => {
		const id = await import("./identity.js");
		const arc = await import("./archetypes.js");
		action = action || "apply";
		const scope = opts.project ? "project" : "global";
		const cwd = process.cwd();
		const file = identityFilePath("user", scope, cwd);
		if (action === "apply") {
			await writeFile(file, arc.userContent());
			emit({ command: "user", action, file });
			if (!JSON_MODE) log.success(`USER.md template → ${pretty(file)}`);
			return;
		}
		if (action === "set") {
			const [section, ...val] = rest;
			if (!section) {
				log.error("Usage: agent user set <field> <value...>");
				process.exit(1);
			}
			const f = await id.setSection(file, section, val.join(" "));
			emit({ command: "user", action, file: f });
			if (!JSON_MODE) log.success(`Updated ${pretty(f)}`);
			return;
		}
		log.error(`Unknown action: ${action}. Use apply|set`);
		process.exit(1);
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
				for (const o of s.options)
					log.raw(`  ${c.bold(o.key.padEnd(18))} ${o.label}`);
				log.dim(
					`Default: ${s.default}. Ask the user, then: agent identity apply <choice>`,
				);
			}
			return;
		}
		log.error(`Unknown action: ${action}. Use suggest`);
		process.exit(1);
	});

program
	.command("models [action] [rest...]")
	.description(
		"Model aliases: list | set <alias> <provider/model> [--category c] [--thinking lvl] | resolve <alias> | seed | write.",
	)
	.option("--category <c>", "category for set")
	.option("--thinking <lvl>", "thinking level for set")
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
				log.error("Usage: agent models set <alias> <provider/model>");
				process.exit(1);
			}
			const r = m.setAlias(alias, {
				model,
				category: opts.category,
				thinking: opts.thinking,
			});
			m.writeModelsMd();
			emit({ command: "models", action, alias, ...r });
			if (!JSON_MODE)
				log.success(
					`Alias '${alias}' → ${r.model}${r.thinking ? " @" + r.thinking : ""}`,
				);
			return;
		}
		if (action === "resolve") {
			const alias = rest[0];
			const r = alias ? m.getAlias(alias) : null;
			emit({ command: "models", action, alias, resolved: r });
			if (!JSON_MODE)
				log.raw(
					r
						? `${alias} → ${r.model}${r.thinking ? " @" + r.thinking : ""}`
						: `${alias} not found`,
				);
			return;
		}
		if (action === "seed") {
			const a = m.ensureDefaultAliases();
			m.writeModelsMd();
			emit({ command: "models", action, aliases: a });
			if (!JSON_MODE)
				log.success(`Seeded ${Object.keys(a).length} default aliases`);
			return;
		}
		if (action === "write") {
			const f = m.writeModelsMd();
			emit({ command: "models", action, file: f });
			if (!JSON_MODE) log.success(`Wrote ${pretty(f)}`);
			return;
		}
		log.error(`Unknown action: ${action}. Use list|set|resolve|seed|write`);
		process.exit(1);
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
	.option("--file <n>", "inbox index to file (triage)")
	.option("--delete <n>", "inbox index to delete (triage)")
	.option("--clear", "delete ALL inbox captures (with the inbox action)")
	.action(async (action, name, opts) => {
		const {
			listLessons,
			addLesson,
			inboxLessons,
			lessonsRoot,
			fileInboxItem,
			deleteInboxItem,
			clearInbox,
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
				log.error("Usage: agent lessons add <topic/descriptive-name>");
				process.exit(1);
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
				log.error("Usage: agent lessons show <topic/descriptive-name>");
				process.exit(1);
			}
			const pathMod = await import("node:path");
			const { exists: ex, readFile: rf } = await import("./util.js");
			const fp = pathMod.join(
				lessonsRoot(scope, cwd),
				`${name.replace(/\.md$/, "")}.md`,
			);
			if (!(await ex(fp))) {
				log.error(`Not found: ${pretty(fp)}`);
				process.exit(1);
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
			if (opts.file != null) {
				if (!name) {
					log.error("Usage: agent lessons triage --file <i> <topic/name>");
					process.exit(1);
				}
				const r = await fileInboxItem(parseInt(opts.file, 10), name, { cwd });
				emit({ command: "lessons", action: "triage", op: "file", ...r });
				if (!JSON_MODE)
					log.success(
						r.ok
							? `Filed inbox #${opts.file} → ${pretty(r.filedTo)}`
							: `Failed: ${r.reason}`,
					);
				return;
			}
			if (opts.delete != null) {
				const r = await deleteInboxItem(parseInt(opts.delete, 10), { cwd });
				emit({ command: "lessons", action: "triage", op: "delete", ...r });
				if (!JSON_MODE)
					log.success(
						r.ok ? `Deleted inbox #${opts.delete}` : `Failed: ${r.reason}`,
					);
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
		log.error(`Unknown action: ${action}. Use list|add|show|inbox|triage`);
		process.exit(1);
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
	.action(async (opts) => {
		const con = await import("./consolidate.js");
		const scope = opts.project ? "project" : "global";
		const cwd = process.cwd();
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
		const r = con.consolidate({
			scope,
			cwd,
			dryRun: !!opts.dryRun,
			promoteThreshold: opts.threshold
				? parseInt(opts.threshold, 10)
				: undefined,
		});
		emit({ command: "consolidate", ...r });
		if (!JSON_MODE) {
			if (!r.ok) {
				log.error(r.reason);
				process.exit(1);
			}
			const s = r.stats;
			log.success(
				`Consolidated (${r.dryRun ? "dry-run" : "applied"}, ${r.scope}): promoted ${c.green(s.promoted)}, pruned ${c.red(s.deleted)}, marked ${c.yellow(s.marked)}, kept ${s.kept}, core ${s.core}`,
			);
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
			log.error(`Unknown target: ${id}`);
			process.exit(1);
		}
		const scope = opts.project ? "project" : "global";
		const p = targetPath(t, scope);
		if (!p) {
			log.error(`${id} has no ${scope} path`);
			process.exit(1);
		}
		if (!(await exists(p))) {
			log.error(`Not found: ${p}`);
			process.exit(1);
		}
		const fs = await import("node:fs/promises");
		const content = await fs.readFile(p, "utf8");
		if (content.includes(POINTER_MARK)) {
			log.error(`${p} is already a pointer (no native content to pull).`);
			process.exit(1);
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
		emit({ command: "where", scope, master: MASTER_FILE, targets: rows });
		if (!JSON_MODE) {
			log.kv("master", c.cyan(pretty(MASTER_FILE)));
			for (const r of rows) log.raw(`  ${r.id.padEnd(9)} ${pretty(r.path)}`);
		}
	});

// ---------------------------------------------------------------------------
// agent update — shipped-default update payloads + npm latest version
// ---------------------------------------------------------------------------
program
	.command("update [action] [version]")
	.description(
		"Shipped-default updates: list staged payloads + npm latest version (default), stage the current version's seeds, or clear <version>.",
	)
	.option("--force", "force a fresh npm version check")
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
			cfg.seedVersion = VERSION;
			await saveConfig(cfg);
			emit({ command: "update", action, ...r });
			if (!JSON_MODE)
				log.success(`Staged ${r.staged.length} seeds → ${pretty(r.path)}`);
			return;
		}
		if (action === "list") {
			const upd = await npm.ensureUpdateCheck(cfg, PKG_NAME, VERSION, {
				force: !!opts.force,
			});
			if (upd.refreshed) await saveConfig(cfg);
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
			if (!version) {
				log.error("Usage: agent update clear <version>");
				process.exit(1);
			}
			const r = await seed.clearStaged(version, { home: AGENTS_DIR });
			emit({ command: "update", action: "clear", ...r });
			if (!JSON_MODE)
				r.ok
					? log.success(`Removed ${pretty(r.path)}`)
					: log.warn(`Not found: update-${version}`);
			return;
		}
		if (action === "diff") {
			if (!version) {
				log.error("Usage: agent update diff <version> [--file <rel>]");
				process.exit(1);
			}
			const stagedList = await seed.listStagedUpdates({ home: AGENTS_DIR });
			const payload = stagedList.find((s) => s.version === version);
			if (!payload) {
				log.error(`No staged update for ${version}`);
				process.exit(1);
			}
			const rels = opts.file ? [opts.file] : payload.files;
			const diffs = [];
			for (const rel of rels) {
				const stagedContent = await seed.readStagedFile(version, rel, {
					home: AGENTS_DIR,
				});
				const livePath = path.join(AGENTS_DIR, ...rel.split("/"));
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
		log.error(`Unknown action: ${action}. Use list|diff|stage|clear <version>`);
		process.exit(1);
	});

// ---------------------------------------------------------------------------
// agent skill — skill-cli integration (bundled submodule)
// ---------------------------------------------------------------------------
program
	.command("skill [args...]")
	.description(
		"skill-cli: setup|refresh|status, or pass any args through to skill.",
	)
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
				...v,
				submodulePresent: submodulePresent(),
				globalBin: globalSkillBin(),
			});
			if (!JSON_MODE) {
				log.kv("available", isSkillAvailable() ? c.green("yes") : c.red("no"));
				log.kv("version", v.version ?? "none");
				log.kv("source", v.source);
				log.kv("global bin", globalSkillBin() || c.gray("—"));
				log.kv(
					"submodule",
					submodulePresent() ? c.green("present") : c.red("missing"),
				);
			}
			return;
		}
		// passthrough
		const r = runSkill(args, { stdio: "inherit" });
		process.exit(typeof r.code === "number" ? r.code : r.ok ? 0 : 1);
	});

// ---------------------------------------------------------------------------
// agent doctor
// ---------------------------------------------------------------------------
program
	.command("snapshot")
	.description("Snapshot the whole ~/.agents brain to backups/snapshots/<ts>/.")
	.action(async () => {
		const { snapshot: snap } = await import("./snapshot.js");
		const r = snap();
		emit({ command: "snapshot", ...r });
		if (!JSON_MODE)
			log.success(`Snapshot ${r.name}: ${r.files} files → ${pretty(r.path)}`);
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
		"Restore the brain from a snapshot (latest non-pre-restore if no name).",
	)
	.action(async (name) => {
		const { restore, listSnapshots } = await import("./snapshot.js");
		const list = listSnapshots();
		const target =
			name || list.find((n) => !n.startsWith("pre-restore-")) || list[0];
		if (!target) {
			log.error("No snapshot to restore.");
			process.exit(1);
		}
		const r = restore(target);
		emit({ command: "restore", ...r });
		if (!JSON_MODE)
			log.success(
				r.ok
					? `Restored ${r.name} (pre-restore backup: ${pretty(r.preRestoreBackup)})`
					: `Failed: ${r.reason}`,
			);
	});

program
	.command("doctor")
	.description(
		"Diagnose master, pointers, skill-cli, staged updates, and npm version.",
	)
	.option("--force", "force a fresh npm version check")
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
		// npm latest version (daily-cached; --force to refresh)
		const npm = await import("./npm-check.js");
		const upd = await npm.ensureUpdateCheck(cfg, PKG_NAME, VERSION, {
			force: !!opts.force,
		});
		if (upd.refreshed) await saveConfig(cfg);
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

		const out = { command: "doctor", ok: issues.length === 0, issues, checks };
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
		if (issues.length) process.exit(2);
	});

// ---------------------------------------------------------------------------
// agent brief — AI session entrypoint (the `skill active` analogue)
// ---------------------------------------------------------------------------
program
	.command("brief")
	.description(
		"AI session brief: machine-readable state + suggested next actions.",
	)
	.action(async () => {
		const cfg = await loadConfig();
		const masterContent = await readMaster();
		const installed = await detectInstalled();
		const skill = skillVersion();
		const conMod = await import("./consolidate.js");
		const consG = conMod.assess({ scope: "global", cwd: process.cwd() });
		const consP = conMod.assess({ scope: "project", cwd: process.cwd() });
		const npm = await import("./npm-check.js");
		const upd = await npm.ensureUpdateCheck(cfg, PKG_NAME, VERSION);
		if (upd.refreshed) await saveConfig(cfg);
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
		// AX: surface the lesson index (filenames ARE the summaries) + inbox so the agent
		// actually loads memory at session start instead of only seeing a score. Also load the
		// LESSONS.md core DIRECTLY (critical-lesson pointer index) so it's never skipped.
		const { listLessons, coreFile } = await import("./lessons-lib.js");
		const lessonsIndex = (await listLessons({ includeProject: false }))
			.map((l) => ({
				path: l.path,
				occurrences: l.occurrences,
				marked: l.marked,
			}))
			.sort((a, b) => a.path.localeCompare(b.path));
		const inboxCount = (consG.metrics.inbox || 0) + (consP.metrics.inbox || 0);
		let coreContent = null;
		try {
			const md = await readFile(coreFile("global", process.cwd()));
			const idx = md.indexOf("## Core");
			if (idx >= 0) {
				const cleaned = md
					.slice(idx + "## Core".length)
					.replace(/<!--[\s\S]*?-->/g, "")
					.trim();
				if (cleaned) coreContent = cleaned;
			}
		} catch {
			/* no core file */
		}
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
		const suggested = [];
		if (archetypeNeeded) suggested.push("agent onboard suggest");
		if (masterContent == null) suggested.push("agent init");
		if (drift.length) suggested.push("agent link");
		if (!isSkillAvailable()) suggested.push("agent skill setup");
		if (consG.recommend) suggested.push("agent consolidate");
		if (consP.recommend) suggested.push("agent consolidate -p");
		if (upd.latest && !upd.upToDate)
			suggested.push(`npm i -g ${PKG_NAME}@latest`);
		if (stagedUpdates.length) suggested.push("agent update list");
		if (inboxCount >= 10) suggested.push("agent lessons inbox (triage)");

		const out = {
			tool: "agent-cli",
			version: VERSION,
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
			},
		};
		emit(out);
		if (!JSON_MODE) {
			log.raw(`${c.bold("agent-cli")} ${c.gray("v" + VERSION)} — brief`);
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
					`Information gap: ${c.yellow(gapStr)} — ask the user, or fill via agent identity/soul/user set <field> <value>.`,
				);
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
	});

program.parseAsync(process.argv).catch((e) => {
	if (JSON_MODE) console.log(JSON.stringify({ error: e.message }));
	else log.error(e.message);
	process.exit(1);
});
