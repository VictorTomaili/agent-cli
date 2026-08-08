// src/commands/knowledge.js — models + lessons + consolidate, extracted from
// cli.js (HIGH-3). Injected deps: { emit, fail, log, c, pretty, EXIT,
//   isJson, readIfExists, writeFile, readFile, preSnapshot, loadConfig,
//   findUnresolvedModels, listAgents }.

/** Register the models + lessons + consolidate commands. */
export function registerKnowledgeCommands(
	program,
	{
		emit,
		fail,
		log,
		c,
		pretty,
		EXIT,
		isJson,
		readIfExists,
		writeFile,
		readFile,
		preSnapshot,
		loadConfig,
		findUnresolvedModels,
		listAgents,
	},
) {
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
		.option(
			"--apply",
			"(suggest) write the auto-picked model for each unresolved alias",
		)
		.option(
			"--reassign",
			"(suggest) re-pick the current best model for EVERY existing alias from the live/bundled catalog (report only unless --apply)",
		)
		.option(
			"--refresh",
			"(research) rewrite the catalog section in MODELS.md with the bundled baseline",
		)
		.option(
			"--fetch",
			"(research) pull the LIVE model list from a public endpoint (OpenRouter) into MODELS.md; offline-safe",
		)
		.action(async (action, rest, opts) => {
			const m = await import("../models.js");
			action = action || "list";
			if (action === "list") {
				emit({
					command: "models",
					action,
					aliases: m.getAliases(),
					categories: m.CATEGORIES,
				});
				if (!isJson())
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
				if (!isJson())
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
				if (!isJson())
					log.raw(
						`${alias} → ${r.model}${r.thinking ? " @" + r.thinking : ""}`,
					);
				return;
			}
			if (action === "write") {
				const f = m.writeModelsMd();
				emit({ command: "models", action, file: f });
				if (!isJson()) log.success(`Wrote ${pretty(f)}`);
				return;
			}
			if (action === "research") {
				// 'research' is the agent-facing entry point:
				//   - default: report the bundled curated catalog state (dry run).
				//   - --refresh: re-embed the bundled curated catalog in MODELS.md.
				//   - --fetch: pull the LIVE model list from a public no-auth
				//     endpoint (OpenRouter) and write a "Live model catalog" section
				//     into MODELS.md, so the agent has current provider/model data
				//     instead of only the bundled baseline. Offline-safe.
				if (opts.fetch) {
					const result = await m.fetchLiveCatalog();
					if (!result.ok) {
						emit({
							command: "models",
							action: "research",
							fetched: false,
							reason: result.reason,
						});
						if (!isJson())
							log.warn(`Could not fetch live catalog: ${result.reason}`);
						return;
					}
					// Merge the live section into MODELS.md, preserving the aliases
					// and bundled curated catalog sections already on disk.
					const existing = (await readIfExists(m.MODELS_MD)) || "";
					const liveSection = m.liveCatalogMarkdown(result);
					const out = m.mergeLiveCatalogSection(existing, liveSection);
					await writeFile(m.MODELS_MD, out);
					// Persist for live-aware auto-pick (models suggest --apply).
					try {
						m.saveLiveCatalog(result);
					} catch {
						/* best-effort; MODELS.md already has the data */
					}
					emit({
						command: "models",
						action: "research",
						fetched: true,
						source: result.source,
						count: result.count,
						fetchedAt: result.fetchedAt,
						file: m.MODELS_MD,
					});
					if (!isJson())
						log.success(
							`Fetched ${result.count} live models from ${result.source} → ${pretty(m.MODELS_MD)}`,
						);
					return;
				}
				const f = await readIfExists(m.MODELS_MD);
				const before = f || "";
				const want = m.catalogMarkdown();
				const hasCatalog = before.includes("## Curated model catalog");
				if (!hasCatalog || opts.refresh) {
					const out = m.writeModelsMd({ includeCatalog: true });
					emit({
						command: "models",
						action: "research",
						refreshed: true,
						file: out,
					});
					if (!isJson())
						log.success(
							`Refreshed catalog in ${pretty(out)} (${m.CATALOG.length} entries).`,
						);
				} else {
					emit({
						command: "models",
						action: "research",
						refreshed: false,
						count: m.CATALOG.length,
						diff: "catalog section already present; pass --refresh to overwrite, or --fetch for the live model list",
					});
					if (!isJson())
						log.info(
							`Catalog section already present (${m.CATALOG.length} entries). Pass --refresh to overwrite, or --fetch to pull the live model list.`,
						);
				}
				return;
			}
			if (action === "suggest") {
				const unresolved = await findUnresolvedModels();
				const cfg = await loadConfig();
				const preferredProviders = cfg.providers || [];
				// --reassign: consider EVERY existing alias (not just unresolved
				// ones) so the agent can upgrade stale assignments to the current
				// best model after a live-catalog fetch.
				const { rows, shared } = m.buildModelSuggestions(unresolved, {
					reassign: !!opts.reassign,
					preferredProviders,
				});
				emit({
					command: "models",
					action: "suggest",
					count: rows.length,
					unresolved: rows,
					shared,
				});
				if (!isJson()) {
					if (!rows.length) log.success("All model aliases resolve.");
					else {
						for (const r of rows) {
							const personaList =
								r.personas.length > 1
									? c.gray(
											` (${r.personas.length} personas: ${r.personas.map((p) => p.name).join(", ")})`,
										)
									: "";
							if (r.pick) {
								const full = r.pick.id.includes("/")
									? r.pick.id
									: `${r.pick.provider}/${r.pick.id}`;
								const changed = r.existing && r.existing !== full;
								const from = changed
									? c.yellow(r.existing + " → ")
									: c.gray("(current) ");
								log.raw(
									`  ${c.bold(r.alias.padEnd(28))} ${from}${c.green(full)} ${r.pick.thinking ? c.gray("(thinking)") : ""}${personaList}`,
								);
							} else {
								log.raw(
									`  ${c.bold(r.alias.padEnd(28))} ${c.yellow(r.alias)} — ${c.cyan(r.guidance)}${personaList}`,
								);
							}
						}
						const applyable = rows.filter((r) => r.pick).length;
						if (applyable > 0) {
							const src = opts.reassign ? "live" : "bundled";
							log.dim(
								`${applyable} alias${applyable === 1 ? "" : "es"} auto-pickable from the ${src} catalog. Apply with: agent models suggest --apply${opts.reassign ? " --reassign" : ""}`,
							);
						} else {
							log.dim(
								"No catalog match — assign manually: agent models set <alias> <provider/model>.",
							);
						}
					}
				}
				if (opts.apply) {
					const { applied, unchanged, writes } = m.planModelSuggestionApply(
						rows,
						{ reassign: !!opts.reassign },
					);
					for (const w of writes)
						m.setAlias(w.alias, {
							model: w.model,
							category: w.category,
							thinking: w.thinking,
						});
					m.writeModelsMd();
					if (!isJson()) {
						if (applied.length)
							log.success(
								`${opts.reassign ? "Reassigned" : "Applied"} ${applied.length} alias${applied.length === 1 ? "" : "es"}:`,
							);
						for (const a of applied) {
							const personas =
								a.personas.length > 1
									? c.gray(` (${a.personas.length} personas)`)
									: "";
							log.raw(`  ${c.green("✓")} ${a.alias} = ${a.model}${personas}`);
						}
						if (unchanged.length)
							log.dim(`${unchanged.length} already up to date (no change).`);
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
					counts: {
						aliases: Object.keys(aliases).length,
						unresolved: unresolved.length,
						unused: unused.length,
					},
				});
				if (!isJson()) {
					for (const u of unresolved)
						log.warn(`unresolved: ${u.name} → ${u.model} (${u.guidance})`);
					if (unused.length)
						log.dim(`unused aliases: ${unused.join(", ")}`);
					if (!unresolved.length && !unused.length)
						log.success("Aliases clean.");
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
				if (!isJson())
					for (const r of rows)
						log.raw(
							`  ${c.bold(r.alias.padEnd(14))} ${r.model} ${c.gray("by: " + (r.usedBy.join(", ") || "—"))}`,
						);
				return;
			}
			if (action === "test") {
				const alias = rest[0];
				if (!alias) fail("Usage: agent models test <alias>");
				const r = m.getAlias(alias);
				if (!r) fail(`No such alias: ${alias}`);
				emit({ command: "models", action: "test", alias, ...r, valid: true });
				if (!isJson())
					log.success(
						`Alias '${alias}' → ${r.model}${r.thinking ? " @" + r.thinking : ""}`,
					);
				return;
			}
			fail(`Unknown action: ${action}. Use list|set|resolve|write|suggest|lint|usage|test`);
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
				deriveTriageCandidate,
			} = await import("../lessons-lib.js");
			action = action || "list";
			const scope = opts.project ? "project" : "global";
			const cwd = process.cwd();
			if (action === "list") {
				const items = await listLessons({ includeProject: true, cwd });
				emit({ command: "lessons", action, count: items.length, lessons: items });
				if (!isJson()) {
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
					const r = await addInboxCapture(name, {
						body: opts.body,
						scope,
						cwd,
					});
					emit({ command: "lessons", action, inbox: true, ...r });
					if (!isJson())
						log.success(
							`Captured to inbox → ${pretty(r.file)} (triage: agent lessons triage --plan)`,
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
						`${r.created ? "Created" : "Updated (×" + r.occurrences + ")"}: ${pretty(r.file)}`,
					);
				return;
			}
			if (action === "show") {
				if (!name) {
					fail("Usage: agent lessons show <topic/descriptive-name>");
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
					fail("Usage: agent lessons capture <topic> [--inbox|--direct]");
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
							`  ${a.id.padEnd(10)} ${a.action.padEnd(8)} ${a.rel} ${c.gray("(" + a.reason + ")")}`,
						);
				}
				return;
			}
			if (opts.check) {
				const a = con.assess({ scope, cwd });
				emit({ command: "consolidate", check: true, ...a });
				if (!isJson()) {
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
