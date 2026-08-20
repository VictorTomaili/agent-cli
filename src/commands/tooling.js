// src/commands/tooling.js — spect + search + sync, extracted from cli.js
// (HIGH-3). Injected deps: { emit, fail, log, c, pretty, EXIT, isJson,
//   loadConfig, saveConfig, ctxPaths, getTarget, linkTarget }.

/** Register the spect + search + sync commands. */
export function registerToolingCommands(
	program,
	{
		emit,
		fail,
		log,
		c,
		pretty,
		EXIT,
		isJson,
		loadConfig,
		saveConfig,
		ctxPaths,
		getTarget,
		linkTarget,
	},
) {
	program
		.command("spect [action] [rest...]")
		.description(
			"SPECT workflow (.spect): init|status|task list|done|open, validate, report, next, close, trace.",
		)
		.option("--spec <id>", "restrict report/task-list to one spec id")
		.action(async (action, rest, opts) => {
			const spect = await import("../spect.js");
			const cwd = process.cwd();
			action = action || "status";
			if (action === "init") {
				const result = await spect.initSpect(cwd);
				emit({ command: "spect", action, ...result });
				if (!isJson()) {
					if (result.ok === false) {
						log.error(result.reason || "SPECT init failed");
						process.exit(EXIT.ERROR);
					}
					log.success(`SPECT initialized in ${pretty(result.root)}`);
					if (result.created.length)
						log.info(`Created: ${result.created.join(", ")}`);
					if (result.skipped.length)
						log.dim(`Preserved: ${result.skipped.join(", ")}`);
					log.dim(
						`Next: copy .spect/templates/spec.md into .spect/specs/ and define acceptance criteria before implementation.`,
					);
				}
				if (result.ok === false) process.exit(EXIT.ERROR);
				return;
			}
			if (action === "status") {
				const result = await spect.inspectSpect(cwd);
				emit({ command: "spect", action, ...result });
				if (!isJson())
					log.kv(
						"project",
						result.initialized
							? `${pretty(result.root)} (${result.counts.specs} specs, ${result.counts.plans} plans, ${result.counts.tasks} tasks)`
							: "not initialized — run agent-cli spect init",
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
					if (!isJson()) {
						if (!filtered.length) log.info("No tasks.");
						for (const t of filtered)
							log.raw(
								`  ${t.done ? c.green("[x]") : c.gray("[ ]")} ${c.bold(t.id.padEnd(9))} ${t.reqs.length ? c.gray("[" + t.reqs.join(", ") + "] ") : ""}${t.title}`,
							);
						log.dim(
							`${filtered.filter((t) => !t.done).length} open — mark: agent-cli spect task done|open <TASK-xxx>`,
						);
					}
					return;
				}
				if (sub === "done" || sub === "open") {
					if (!id) fail("Usage: agent-cli spect task done|open <TASK-xxx>");
					const r = await spect.setTaskStatus(cwd, id, sub === "done");
					emit({ command: "spect", action: "task", op: sub, ...r });
					if (!r.ok) {
						if (!isJson()) log.error(r.reason);
						process.exit(EXIT.ERROR);
					}
					if (!isJson()) {
						if (r.unchanged)
							log.info(
								`${id} is already ${sub === "done" ? "done" : "open"} (no change).`,
							);
						else
							log.success(
								`${id} → ${sub === "done" ? "done" : "open"} (${pretty(r.file)})`,
							);
					}
					return;
				}
				fail(`Unknown task op: ${sub}. Use list|done|open`);
			}
			if (action === "validate") {
				const r = await spect.validateSpect(cwd);
				emit({ command: "spect", action, ...r });
				if (!isJson()) {
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
				if (!isJson()) {
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
				if (!isJson()) {
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
				if (!id) fail("Usage: agent-cli spect close <TASK-xxx>");
				const r = await spect.closeTask(cwd, id);
				emit({ command: "spect", action, ...r });
				if (!r.ok) {
					if (!isJson()) log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				if (!isJson()) {
					log.success(`Closed ${id} — ${pretty(r.file)}`);
					log.dim(r.lesson.suggestion);
					log.dim(r.snapshotSuggestion);
				}
				return;
			}
			if (action === "trace") {
				const specId = rest[0];
				if (!specId) fail("Usage: agent-cli spect trace <SPEC-id>");
				const r = await spect.traceSpect(specId, cwd);
				emit({ command: "spect", action, ...r });
				if (!r.ok) {
					if (!isJson()) log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				if (!isJson()) {
					for (const q of r.reqs)
						log.raw(
							`  ${q.implemented ? c.green("✓") : c.gray("○")} ${q.id.padEnd(9)} ${q.tasks.map((t) => t.id).join(", ") || c.gray("(no task)")} ${q.verified ? c.green("verified") : c.yellow("unverified")}`,
						);
					if (r.issues.length)
						for (const i of r.issues) log.warn(`${i.type}: ${i.req}`);
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
			"Search lessons, identity files, and SPECT docs by relevance — check before starting work to avoid duplicating existing guidance.",
		)
		.option("--kind <k>", "lessons|identity|spect|all (default all)")
		.option("--project", "include the project scope")
		.option("--limit <n>", "max results")
		.action(async (query, opts) => {
			const search = await import("../search.js");
			const r = await search.searchAll(query, {
				kind: opts.kind || "all",
				project: !!opts.project,
				limit: opts.limit ? parseInt(opts.limit, 10) : 10,
			});
			emit({ command: "search", ...r });
			if (!isJson()) {
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
	// agent-cli sync — git-backed brain portability
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
			const sync = await import("../sync.js");
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
						cfg.sync = {
							...(cfg.sync || {}),
							lastPull: new Date().toISOString(),
						};
						await saveConfig(cfg);
					}
					break;
				case "status":
					r = await sync.syncStatus();
					break;
				case "log":
					r = await sync.syncLog({
						limit: opts.limit ? parseInt(opts.limit, 10) : 20,
					});
					break;
				case "diff":
					r = await sync.syncDiff({ commit: opts.commit || arg });
					break;
				case "rollback":
					r = await sync.syncRollback({ commit: opts.commit || arg });
					break;
				case "auto":
					{
						const posOn = arg === "on" || arg === "1";
						const posOff = arg === "off" || arg === "0";
						if (
							opts.on === undefined &&
							opts.off === undefined &&
							!posOn &&
							!posOff
						) {
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
					const lr = await linkTarget(t, "global", {
						masterAbs,
						masterTilde,
					});
					if (lr.linked || lr.unchanged) relinked++;
				}
				r.relinked = relinked;
			}
			emit({ command: "sync", action, ...r });
			if (!isJson()) {
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
					for (const e of r.entries)
						log.raw(`  ${c.gray(e.hash)} ${e.date} ${e.message}`);
				else if (action === "diff") {
					if (r.summary) log.raw(r.summary);
					if (r.diff) log.raw(r.diff.trim());
				} else if (action === "auto")
					log.success(`auto-commit ${r.enabled ? "on" : "off"}`);
				else if (action === "init")
					log.success(`Sync repo ready at ${pretty(r.dir)}`);
				else if (action === "rollback")
					log.success(`Restored ${r.commit} — re-linked pointers.`);
			}
			if (r && !r.ok && !r.nothingToDo) process.exit(EXIT.ERROR);
		});
}
