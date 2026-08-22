// src/commands/link.js — link + unlink, extracted from cli.js (HIGH-3).
// Injected deps: { emit, fail, log, c, pretty, TARGETS, targetsWithScope, loadConfig,
//   effectiveProjectIds, masterPaths, setExpectedCtx, linkTarget, unlinkTarget,
//   ensureMaster, ensureMasterPointer, isJson, linkShared, unlinkShared }.
import { SHARE_KINDS } from "../share.js";

function selectedTargets(scope, ids, targetsWithScope) {
	const pool = targetsWithScope(scope);
	if (ids && ids.length) {
		const set = new Set(ids);
		return pool.filter((t) => set.has(t.id));
	}
	return pool;
}

function validateIds(opts, command, TARGETS, fail) {
	if (opts.global && opts.project)
		fail(`Use either -g/--global or -p/--project, not both`, { command });
	if (opts.target) {
		const known = new Set(TARGETS.map((t) => t.id));
		const unknown = opts.target.filter((id) => !known.has(id));
		if (unknown.length)
			fail(
				`Unknown target id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Known ids: ${[...known].sort().join(", ")}`,
				{ command, target: unknown },
			);
	}
}

/** Shared-link flows use a fixed vocabulary positional (link agents|skills) —
 *  anything else must error (M7 spirit: no silent anything-goes positionals). */
function validateWhat(what, command, fail) {
	if (what !== undefined && !SHARE_KINDS.includes(what))
		fail(
			`Unknown link kind: '${what}'. Use 'agent-cli link' (pointer stubs), 'agent-cli link agents', or 'agent-cli link skills'.`,
			{ command, what },
		);
}

/** Register the status command (pointer-health sibling of link/unlink). */
export function registerStatusCommand(
	program,
	{
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
		isJson,
	},
) {
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
					corrupt: isConfigCorrupt(cfg) ? true : false,
				},
				skill: {
					available: isSkillAvailable(),
					backend: "integrated",
				},
				targets: visibleTargets,
				targetCount: targets.length,
				all: showAll,
				targetsSummary: {
					pointer: visibleTargets.filter((t) => t.global?.state === "pointer")
						.length,
					missing: visibleTargets.filter((t) => t.global?.state === "missing")
						.length,
					stale: visibleTargets.filter((t) => t.global?.state === "pointer-stale")
						.length,
					native: visibleTargets.filter((t) => t.global?.state === "native").length,
				},
			};
			emit(out);
			if (!isJson()) {
				log.raw(`${c.bold("agent-cli")} ${c.gray("v" + VERSION)}`);
				log.kv(
					"master",
					c.cyan(pretty(MASTER_FILE)) +
						(out.master.exists ? c.green(" ✓") : c.red(" ✗ missing")),
				);
				log.kv(
					"skill-cli",
					out.skill.available ? c.green("✓ integrated") : c.red("✗"),
				);
				if (out.config.corrupt)
					log.warn(
						"config.json is corrupt — repair or remove it before changing settings",
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
}

/** Human line for one share-link result row. */
function shareRowLine(c, pretty, r) {
	const mark = r.linked
		? c.green(r.unchanged ? "✓" : "✓+")
		: r.unlinked
			? c.green("−")
			: r.blocked || r.skipped
				? c.yellow("!")
				: c.gray("·");
	const note = r.blocked
		? `native content — ${r.hint ?? "move it into the shared source first"}`
		: r.skipped
			? `skipped (${r.skipped})`
			: r.missing
				? "not linked (missing)"
				: r.unchanged
					? "already linked"
					: r.backup
						? `linked (native backed up: ${pretty(r.backup)})`
						: "";
	return `  ${mark} ${String(r.id).padEnd(10)} ${pretty(r.path)}${note ? c.gray("  — " + note) : ""}`;
}

/** `link agents|skills` flow: share the roster/store with capable tools. */
function sharedLinkFlow(
	what,
	opts,
	{ emit, log, c, pretty, isJson, fail, linkShared },
) {
	if (opts.project)
		fail("Share links are home-scope only (-g is the default; no -p).", {
			command: "link",
			what,
		});
	const results = linkShared(what, opts.target, {
		force: !!(opts.force || opts.overwrite),
	});
	const linked = results.filter((r) => r.linked && !r.unchanged).length;
	const ok = results.filter((r) => r.unchanged).length;
	const blocked = results.filter((r) => r.blocked);
	emit({
		command: "link",
		what,
		scope: "global",
		results,
		changed: linked > 0,
	});
	if (!isJson()) {
		for (const r of results) log.raw(shareRowLine(c, pretty, r));
		log.success(`${linked} linked, ${ok} up-to-date`);
		if (blocked.length)
			for (const b of blocked)
				log.warn(`${b.id}: native content — ${b.hint ?? "merge or use --force"}`);
	}
}

/** `unlink agents|skills` flow. */
function sharedUnlinkFlow(
	what,
	opts,
	{ emit, log, c, pretty, isJson, unlinkShared },
) {
	if (opts.project)
		fail("Share links are home-scope only (-g is the default; no -p).", {
			command: "unlink",
			what,
		});
	const results = unlinkShared(what, opts.target);
	const n = results.filter((r) => r.unlinked).length;
	emit({ command: "unlink", what, scope: "global", results, changed: n > 0 });
	if (!isJson()) {
		for (const r of results) log.raw(shareRowLine(c, pretty, r));
		log.success(`${n} share link(s) removed`);
	}
}

/** Register the link and unlink commands. */
export function registerLinkCommands(
	program,
	{
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
		isJson,
		linkShared,
		unlinkShared,
	},
) {
	program
		.command("link [what]")
		.description(
			"(Re)write pointer stubs for already-enabled agents — e.g. to repair drift after a sync pull or manual config edit. Idempotent. Edit the master anytime — no re-link needed. 'link agents' / 'link skills' share the persona roster / skill store with every capable tool (manage once, use everywhere).",
		)
		// M7: link/unlink select targets via -t/--target, never bare ids — the one
		// accepted positional is the fixed vocabulary 'agents' | 'skills'.
		.allowExcessArguments(false)
		.option("-g, --global", "Home (~) scope only")
		.option("-p, --project", "Current project (./) scope only")
		.option("-t, --target <ids...>", "Restrict to target ids")
		.option("--force", "Overwrite native (non-pointer) content (destructive)")
		.option("--overwrite", "alias for --force")
		.action(async (what, opts) => {
			validateWhat(what, "link", fail);
			const cfg = await loadConfig();
			validateIds(opts, "link", TARGETS, fail);
			if (what)
				return sharedLinkFlow(what, opts, {
					emit,
					log,
					c,
					pretty,
					isJson,
					fail,
					linkShared,
				});
			const scopes = [];
			if (opts.global) scopes.push("global");
			if (opts.project) scopes.push("project");
			if (scopes.length === 0) scopes.push("global");
			const out = { command: "link", scopes, results: [] };
			for (const scope of scopes) {
				let ids = opts.target;
				if (!ids) ids = scope === "global" ? cfg.global : effectiveProjectIds(cfg);
				const targets = selectedTargets(scope, ids, targetsWithScope);
				// Project pointers must redirect to the project master, not the global one.
				const { masterAbs, masterTilde } = masterPaths(scope);
				setExpectedCtx({ masterAbs, masterTilde });
				if (scope === "global") {
					// Global layout upkeep, mirroring `agent-cli init`: migrate any pre-flip
					// master layout (~/AGENTS.md → ~/.agents/AGENTS.md, with backup), then
					// refresh the managed home pointer at ~/AGENTS.md alongside the target
					// stubs. Never destructive without --force: a native ~/AGENTS.md is
					// only converted after the migration backed it up.
					const master = await ensureMaster();
					if (master.action === "migrated" || master.action === "diverged")
						out.master = {
							action: master.action,
							...(master.backup ? { backup: master.backup } : {}),
						};
					if (master.warning) out.masterWarning = master.warning;
					const homePointer = await ensureMasterPointer({
						masterAbs,
						masterTilde,
						force: !!(opts.force || opts.overwrite),
					});
					out.homePointer = {
						path: homePointer.path,
						action: homePointer.action ?? homePointer.skipped,
					};
				}
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
			if (!isJson()) {
				if (out.master?.action === "migrated")
					log.success(
						`Master migrated to ${c.cyan("~/.agents/AGENTS.md")} — previous copy backed up at ${c.cyan(pretty(out.master.backup))}`,
					);
				if (out.masterWarning) log.warn(out.masterWarning);
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
		.command("unlink [what]")
		.description(
			"Remove pointer stubs only (deletes only files that are pointers); does not disable the target in config.json — use `target disable` to do both. 'unlink agents' / 'unlink skills' remove the cross-tool share links.",
		)
		.allowExcessArguments(false)
		.option("-g, --global")
		.option("-p, --project")
		.option("-t, --target <ids...>")
		.action(async (what, opts) => {
			validateWhat(what, "unlink", fail);
			const cfg = await loadConfig();
			validateIds(opts, "unlink", TARGETS, fail);
			if (what)
				return sharedUnlinkFlow(what, opts, {
					emit,
					log,
					c,
					pretty,
					isJson,
					unlinkShared,
				});
			const scopes = [];
			if (opts.global) scopes.push("global");
			if (opts.project) scopes.push("project");
			if (scopes.length === 0) scopes.push("global");
			const out = { command: "unlink", scopes, results: [] };
			for (const scope of scopes) {
				let ids = opts.target;
				if (!ids) ids = scope === "global" ? cfg.global : effectiveProjectIds(cfg);
				const targets = selectedTargets(scope, ids, targetsWithScope);
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
			if (!isJson()) {
				const n = out.results.filter((r) => r.unlinked).length;
				log.success(`${n} pointer stubs removed`);
			}
		});
}
