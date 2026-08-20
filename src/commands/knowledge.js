// src/commands/knowledge.js — lessons + consolidate, extracted from cli.js
// (HIGH-3). The `models` command moved to src/commands/models.js (Phase-1
// leftover: keep every command file under ~500 lines).
// Injected deps: { emit, fail, log, c, pretty, EXIT, isJson, readFile,
//   preSnapshot }.

/** Register the lessons + consolidate commands. */
export function registerKnowledgeCommands(
	program,
	{ emit, fail, log, c, pretty, EXIT, isJson, readFile, preSnapshot },
) {
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
		.action(async (action_, name, opts) => {
			const {
				listLessons,
				addLesson,
				inboxLessons,
				resolveLessonFile,
				fileInboxItem,
				deleteInboxItem,
				clearInbox,
				addInboxCapture,
				deriveTriageCandidate,
			} = await import("../lessons-lib.js");
			const action = action_ || "list";
			const scope = opts.project ? "project" : "global";
			const cwd = process.cwd();
			if (action === "list") {
				const items = await listLessons({ includeProject: true, cwd });
				emit({ command: "lessons", action, count: items.length, lessons: items });
				if (!isJson()) {
					if (!items.length)
						log.warn(
							"No lessons yet. Create one: agent-cli lessons add <topic/descriptive-name>",
						);
					for (const it of items)
						log.raw(
							`${it.scope === "project" ? c.cyan("[proj]") : c.gray("[glob]")} ${c.bold(it.path)}  ${c.gray(`×${it.occurrences}`)}${it.marked ? c.yellow(" ⚠marked") : ""}`,
						);
				}
				return;
			}
			if (action === "add") {
				if (!name) {
					fail("Usage: agent-cli lessons add <topic/descriptive-name>");
				}
				if (opts.inbox) {
					const r = await addInboxCapture(name, {
						body: opts.body,
						scope,
						cwd,
					});
					emit({ command: "lessons", action, inbox: true, ...r });
					if (!isJson())
						log.success(
							`Captured to inbox → ${pretty(r.file)} (triage: agent-cli lessons triage --plan)`,
						);
					return;
				}
				const r = await addLesson(name, { body: opts.body, scope, cwd });
				try {
					(await import("../session.js")).recordLessonCapture(name);
				} catch {
					/* best-effort; lesson is already filed */
				}
				emit({ command: "lessons", action, ...r });
				if (!isJson())
					log.success(
						`${r.created ? "Created" : `Updated (×${r.occurrences})`}: ${pretty(r.file)}`,
					);
				return;
			}
			if (action === "show") {
				if (!name) {
					fail("Usage: agent-cli lessons show <topic/descriptive-name>");
				}
				const { exists: ex, readFile: rf } = await import("../util.js");
				const fp = await resolveLessonFile(name, { scope, cwd });
				if (!fp) {
					fail("Lesson path must stay inside the lessons directory");
				}
				if (!(await ex(fp))) {
					fail(`Not found: ${pretty(fp)}`);
				}
				const content = await rf(fp);
				if (isJson()) emit({ command: "lessons", action, path: fp, content });
				else process.stdout.write(content);
				return;
			}
			if (action === "inbox") {
				if (opts.clear) {
					const r = await clearInbox({ includeProject: true, cwd });
					emit({ command: "lessons", action: "inbox", op: "clear", ...r });
					if (!isJson()) log.success(`Cleared ${r.deleted} inbox capture(s)`);
					return;
				}
				const items = await inboxLessons({ includeProject: true, cwd });
				emit({ command: "lessons", action, count: items.length, inbox: items });
				if (!isJson()) {
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
						// candidate topic from `- Capture: <topic>` or the first body line,
						// skipping the YAML frontmatter block so fields like
						// `sourceSession:` are never picked as the topic.
						const { candidate, topic } = deriveTriageCandidate(
							content,
							items[i].name.replace(/\.md$/, ""),
						);
						plans.push({
							index: i,
							scope: items[i].scope,
							file: items[i].file,
							candidate,
							topic,
						});
					}
					emit({ command: "lessons", action: "triage", op: "plan", plans });
					if (!isJson()) {
						if (!plans.length) log.info("Inbox empty.");
						for (const p of plans)
							log.raw(
								`  [${p.index}] ${pretty(p.file)} → ${c.cyan(p.candidate)}${c.gray(`  (${p.topic})`)}`,
							);
						log.dim("File one: agent-cli lessons triage --index <i> <topic>");
					}
					return;
				}
				const fileIndex = opts.index == null ? opts.file : opts.index;
				if (fileIndex != null) {
					if (!name) {
						fail("Usage: agent-cli lessons triage --index <i> <topic/name>");
					}
					const r = await fileInboxItem(parseInt(fileIndex, 10), name, {
						cwd,
					});
					emit({ command: "lessons", action: "triage", op: "file", ...r });
					if (!r.ok) {
						if (!isJson()) log.error(r.reason);
						process.exit(1);
					}
					if (!isJson())
						log.success(`Filed inbox #${fileIndex} → ${pretty(r.filedTo)}`);
					return;
				}
				if (opts.delete != null) {
					const r = await deleteInboxItem(parseInt(opts.delete, 10), { cwd });
					emit({ command: "lessons", action: "triage", op: "delete", ...r });
					if (!r.ok) {
						if (!isJson()) log.error(r.reason);
						process.exit(1);
					}
					if (!isJson()) log.success(`Deleted inbox #${opts.delete}`);
					return;
				}
				const items = await inboxLessons({ includeProject: true, cwd });
				emit({
					command: "lessons",
					action: "triage",
					count: items.length,
					inbox: items,
				});
				if (!isJson()) {
					if (!items.length) log.info("Inbox empty.");
					items.forEach((it, i) => {
						log.raw(
							`  [${i}] ${it.scope === "project" ? c.cyan("[proj]") : c.gray("[glob]")} ${pretty(it.file)}`,
						);
					});
					log.dim(
						"File one: agent-cli lessons triage --file <i> <topic/name> · delete: agent-cli lessons triage --delete <i>",
					);
				}
				return;
			}
			if (action === "search") {
				if (!name) fail("Usage: agent-cli lessons search <query>");
				const search = await import("../search.js");
				const r = await search.searchLessons(name, {
					includeProject: true,
					cwd,
				});
				emit({ command: "lessons", action: "search", ...r });
				if (!isJson()) {
					if (!r.results.length) log.info("No lesson matches.");
					for (const hit of r.results)
						log.raw(
							`  ${c.bold(String(hit.score).padStart(3))} [${hit.scope}] ${pretty(hit.path)} ×${hit.occurrences}${hit.marked ? c.yellow(" ⚠marked") : ""}`,
						);
				}
				return;
			}
			if (action === "capture") {
				if (!name)
					fail("Usage: agent-cli lessons capture <topic> [--inbox|--direct]");
				const memMod = await import("../memory.js");
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
					if (!isJson())
						log.success(`Captured to inbox → ${pretty(r.file)}`);
					return;
				}
				const r = await addLesson(name, { body: opts.body, scope, cwd });
				try {
					(await import("../session.js")).recordLessonCapture(name);
				} catch {
					/* best-effort; lesson is already filed */
				}
				emit({ command: "lessons", action: "capture", mode: "direct", ...r });
				if (!isJson()) log.success(`Captured → ${pretty(r.file)}`);
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
			const con = await import("../consolidate.js");
			const scope = opts.project ? "project" : "global";
			const cwd = process.cwd();
			if (opts.plan || opts.apply) {
				const plan = con.planConsolidation({ scope, cwd });
				if (opts.apply) {
					const r = con.applyPlanAction(scope, cwd, opts.apply);
					emit({
						command: "consolidate",
						action: "apply",
						planId: opts.apply,
						...r,
					});
					if (!isJson()) {
						if (!r.ok) {
							log.error(r.reason);
							process.exit(EXIT.ERROR);
						}
						log.success(
							`Applied ${opts.apply} (${r.applied.action}) → ${pretty(r.applied.path)}`,
						);
					}
					if (!r.ok) process.exit(EXIT.ERROR);
					return;
				}
				emit({ command: "consolidate", action: "plan", ...plan });
				if (!isJson()) {
					if (plan.nothingToDo) log.info("Nothing to consolidate.");
					for (const a of plan.actions)
						log.raw(
							`  ${a.id.padEnd(10)} ${a.action.padEnd(8)} ${a.rel} ${c.gray(`(${a.reason})`)}`,
						);
				}
				return;
			}
			if (opts.check) {
				const a = con.assess({ scope, cwd });
				emit({ command: "consolidate", check: true, ...a });
				if (!isJson()) {
					log.raw(
						`${c.bold("consolidate")} ${c.gray(`(${a.scope})`)} — score ${c.bold(String(a.score))}/100 ${a.recommend ? c.yellow("⚠ recommend") : c.green("ok")}`,
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
			const pre =
				!opts.dryRun && !opts.check ? await preSnapshot("consolidate") : null;
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
				if (isJson()) process.exit(EXIT.ERROR);
				fail(r.reason);
			}
			if (!isJson()) {
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
}
