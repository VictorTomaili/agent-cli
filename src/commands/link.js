// src/commands/link.js — link + unlink, extracted from cli.js (HIGH-3).
// Injected deps: { emit, fail, log, c, TARGETS, targetsWithScope, loadConfig,
//   effectiveProjectIds, masterPaths, setExpectedCtx, linkTarget, unlinkTarget, isJson }.

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

/** Register the link and unlink commands. */
export function registerLinkCommands(
	program,
	{
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
		isJson,
	},
) {
	program
		.command("link")
		.description(
			"(Re)write pointer stubs for already-enabled agents — e.g. to repair drift after a sync pull or manual config edit. Idempotent. Edit the master anytime — no re-link needed.",
		)
		// M7: link/unlink select targets via -t/--target, never positionals —
		// a stray `agent link claude` must error, not silently link everything.
		.allowExcessArguments(false)
		.option("-g, --global", "Home (~) scope only")
		.option("-p, --project", "Current project (./) scope only")
		.option("-t, --target <ids...>", "Restrict to target ids")
		.option("--force", "Overwrite native (non-pointer) content (destructive)")
		.option("--overwrite", "alias for --force")
		.action(async (opts) => {
			const cfg = await loadConfig();
			validateIds(opts, "link", TARGETS, fail);
			const scopes = [];
			if (opts.global) scopes.push("global");
			if (opts.project) scopes.push("project");
			if (scopes.length === 0) scopes.push("global");
			const out = { command: "link", scopes, results: [] };
			for (const scope of scopes) {
				let ids = opts.target;
				if (!ids)
					ids = scope === "global" ? cfg.global : effectiveProjectIds(cfg);
				const targets = selectedTargets(scope, ids, targetsWithScope);
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
			if (!isJson()) {
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
		.description(
			"Remove pointer stubs only (deletes only files that are pointers); does not disable the target in config.json — use `target disable` to do both.",
		)
		.allowExcessArguments(false)
		.option("-g, --global")
		.option("-p, --project")
		.option("-t, --target <ids...>")
		.action(async (opts) => {
			const cfg = await loadConfig();
			validateIds(opts, "unlink", TARGETS, fail);
			const scopes = [];
			if (opts.global) scopes.push("global");
			if (opts.project) scopes.push("project");
			if (scopes.length === 0) scopes.push("global");
			const out = { command: "unlink", scopes, results: [] };
			for (const scope of scopes) {
				let ids = opts.target;
				if (!ids)
					ids = scope === "global" ? cfg.global : effectiveProjectIds(cfg);
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
