// src/commands/where.js — resolved paths for targets (extracted from cli.js, HIGH-3).
// Injected deps: { emit, log, c, pretty, TARGETS, pathFor, targetPath, masterPaths, isJson }.

/** Register the `where` command. */
export function registerWhereCommand(
	program,
	{ emit, log, c, pretty, TARGETS, pathFor, targetPath, masterPaths, isJson },
) {
	program
		.command("where")
		.description(
			"Print resolved paths for targets only — no health/enabled state; use `status` for that.",
		)
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
			if (!isJson()) {
				log.kv("master", c.cyan(pretty(masterAbs)));
				for (const r of rows) log.raw(`  ${r.id.padEnd(9)} ${pretty(r.path)}`);
			}
		});
}
