// src/commands/memory-ops.js — snapshot + restore + backups, extracted from cli.js (HIGH-3).
// Injected deps: { emit, fail, log, c, pretty, EXIT, loadConfig, getTarget, linkTarget,
//   ctxPaths, preSnapshot, isJson }.

/** Register the snapshot / restore / backups commands. */
export function registerMemoryOpsCommands(
	program,
	{
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
		isJson,
	},
) {
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
			} = await import("../snapshot.js");
			if (action === "diff") {
				const [a, b] = args || [];
				if (!a || !b) fail("Usage: agent-cli snapshot diff <a> <b>");
				const r = diffSnapshots(a, b);
				emit({ command: "snapshot", action: "diff", ...r });
				if (!isJson()) {
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
			const r = await snap();
			let pruned = [];
			if (opts.retain) pruned = pruneSnapshots(parseInt(opts.retain, 10)).pruned;
			emit({
				command: "snapshot",
				...r,
				...(pruned.length ? { pruned } : {}),
			});
			if (!isJson()) {
				log.success(`Snapshot ${r.name}: ${r.files} files → ${pretty(r.path)}`);
				if (pruned.length) log.dim(`Pruned ${pruned.length} old snapshot(s)`);
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
			const { restore, listSnapshots, snapshotDiff } = await import(
				"../snapshot.js"
			);
			const latest = () =>
				listSnapshots().find((n) => !n.startsWith("pre-restore-")) || null;
			if (opts.diff) {
				const target = name || latest();
				if (!target) fail("No snapshot to diff.");
				const r = snapshotDiff(target);
				emit({ command: "restore", diff: true, name: target, ...r });
				if (!isJson()) {
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
			const target =
				name || list.find((n) => !n.startsWith("pre-restore-")) || list[0];
			if (!target) fail("No snapshot to restore.");
			const pre = await preSnapshot("restore");
			const r = await restore(target);
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
				if (!isJson()) log.error(r.reason);
				process.exit(EXIT.ERROR);
			}
			if (!isJson()) {
				log.success(
					`Restored ${r.name} (pre-restore backup: ${pretty(r.preRestoreBackup)})`,
				);
				if (relinked) log.dim(`${relinked} pointer(s) re-linked.`);
			}
		});

	program
		.command("backups <action> [name]")
		.description(
			"Consolidation backup history: list | diff <name> — automatic backups from lesson consolidation, separate from `snapshot`/`restore`.",
		)
		.option("-p, --project", "project scope")
		.action(async (action, name, opts) => {
			const memMod = await import("../memory.js");
			const scope = opts.project ? "project" : "global";
			if (action === "list") {
				const r = memMod.backupsList({ scope });
				emit({ command: "backups", action: "list", ...r });
				if (!isJson()) {
					if (!r.ok) {
						log.error(r.reason || "failed to list backups");
						process.exit(EXIT.ERROR);
					}
					if (!r.backups.length) log.info("No consolidation backups.");
					for (const b of r.backups) {
						const kind = b.kind === "tx" ? c.gray("[tx]") : "    ";
						log.raw(
							`  ${kind} ${c.gray(b.name.padEnd(40))} ${b.mtime} ${c.gray(b.size + "B")}`,
						);
					}
				}
				if (!r.ok) process.exit(EXIT.ERROR);
				return;
			}
			if (action === "diff") {
				if (!name) fail("Usage: agent-cli backups diff <name>");
				const r = memMod.backupsDiff(name, { scope });
				emit({ command: "backups", action: "diff", ...r });
				if (!isJson()) {
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
			fail(`Unknown backups action: ${action}. Use list|diff`, {
				command: "backups",
				action,
			});
		});
}
