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
			"(Re)write pointer stubs to enabled agents. Idempotent. Edit the master anytime — no re-link needed.",
		)
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
		.description("Remove pointer stubs (only deletes files that are pointers).")
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
