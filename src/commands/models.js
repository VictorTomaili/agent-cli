// src/commands/models.js — the `models` command, extracted from knowledge.js
// (Phase-1 leftover: keep every command file under ~500 lines).
// Injected deps: { emit, fail, log, c, pretty, isJson, readIfExists, writeFile,
//   loadConfig, findUnresolvedModels, listAgents }.

/** Register the `models` command (model aliases over ~/.agents/MODELS.md). */
export function registerModelsCommands(
	program,
	{
		emit,
		fail,
		log,
		c,
		pretty,
		isJson,
		readIfExists,
		writeFile,
		loadConfig,
		findUnresolvedModels,
		listAgents,
	},
) {
	program
		.command("models [action] [rest...]")
		.description(
			"Model aliases (global ~/.agents/MODELS.md; project scope is not supported): list | rm <alias> | set <alias> <provider/model> [--category c] [--thinking lvl] [--fallback <provider/model>...] | resolve <alias> | write | suggest [--apply] | research [--fetch] | lint | usage | test <alias>. agent-cli ships no model list: import candidates with 'research --fetch', then auto-pick per category with 'suggest --apply'.",
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
			"(suggest) re-pick the current best model for EVERY existing alias from the imported live catalog (report only unless --apply)",
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
				if (!isJson()) {
					const entries = Object.entries(m.getAliases());
					for (const [name, v] of entries)
						log.raw(
							`  ${c.bold(name.padEnd(14))} ${c.gray(v.category)} ${v.model} ${v.thinking ? c.gray("@" + v.thinking) : ""}`,
						);
					// An empty alias set printed nothing at all, which reads as a
					// broken command. The master AGENTS.md contract points the agent
					// at `models list` to discover what this machine has, so the
					// empty case has to say what to do next.
					if (!entries.length) {
						log.info("No model aliases configured.");
						// Which remedy depends on whether a catalog exists. An empty
						// alias set with a catalog already imported needs `suggest
						// --apply`; sending that user to `research --fetch` first is a
						// step that changes nothing.
						log.dim(`  ${m.catalogHint()}`);
					}
				}
				return;
			}
			if (action === "set") {
				const [alias, model] = rest;
				if (!alias || !model) {
					fail("Usage: agent-cli models set <alias> <provider/model>");
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
			if (action === "rm" || action === "remove") {
				// `rest` is variadic so an alias containing spaces still resolves
				// to the key shown in `models list`. The names this exists to clean
				// up (written before the P11 name check) look like
				// `smart-model <!-- why -->`; quote them, or pass them after `--`
				// so the trailing `-->` is not parsed as an option.
				const alias = rest.join(" ").trim();
				if (!alias) {
					fail(
						"Usage: agent-cli models rm <alias>   (quote a name with spaces, or pass it after --)",
					);
				}
				// config.json and MODELS.md can drift, so an alias may exist as a
				// line in the file with no config entry behind it. `rm` has to be
				// able to clear those too, or the line would be unremovable.
				const removed = m.removeAlias(alias) || m.getModelsMdAlias(alias);
				if (!removed) {
					fail(`No such alias: ${alias}`, {
						command: "models",
						action: "rm",
						alias,
					});
				}
				// Keep MODELS.md in sync — `drop` is what deletes the alias line;
				// the writer preserves every line it was not told about.
				m.writeModelsMd({ drop: [alias] });
				emit({
					command: "models",
					action: "rm",
					alias,
					removed,
					modelsMd: m.MODELS_MD,
				});
				if (!isJson())
					log.success(`Removed alias '${alias}' (was ${removed.model})`);
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
				// 'research' is the agent-facing entry point, and has exactly two modes
				// now that agent-cli ships no model data of its own:
				//   - --fetch: pull the LIVE model list from a public no-auth endpoint
				//     (OpenRouter), write a 'Live model catalog' section into MODELS.md
				//     and persist it for auto-pick. Offline-safe.
				//   - default: report what has been imported. READ-ONLY - it must never
				//     write MODELS.md. The old default re-embedded a bundled baseline
				//     over whatever catalog section was already on disk.
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
					// and any catalog section already on disk.
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
				// READ-ONLY status report. Never writes MODELS.md: agent-cli has no
				// model data to write, and the path that used to do it was the only
				// one that could clobber a hand-curated catalog section.
				const age = m.liveCatalogAgeDays();
				const imported = age != null;
				const aliasCount = Object.keys(m.getAliases()).length;
				emit({
					command: "models",
					action: "research",
					imported,
					ageDays: age,
					aliases: aliasCount,
					hint: imported ? null : m.NO_CATALOG_HINT,
				});
				if (!isJson()) {
					if (!imported) {
						log.warn('No model catalog imported yet.');
						log.raw(`  ${c.cyan('Run:')} agent-cli models research --fetch`);
					} else {
						log.info(
							`Live catalog imported ${age} day(s) ago; ${aliasCount} alias(es) configured.`,
						);
						if (!aliasCount)
							log.raw(`  ${c.cyan('Run:')} agent-cli models suggest --apply`);
					}
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
					reassign: opts.reassign === true,
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
					if (rows.length) {
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
						const applicable = rows.filter((r) => r.pick).length;
						if (applicable > 0) {
								log.dim(
								`${applicable} alias${applicable === 1 ? "" : "es"} auto-pickable from the imported catalog. Apply with: agent-cli models suggest --apply${opts.reassign ? " --reassign" : ""}`,
							);
						} else if (!m.hasCatalog()) {
							log.dim(m.NO_CATALOG_HINT);
						} else {
							log.dim(
								"No candidate matched these categories — assign manually: agent-cli models set <alias> <provider/model>.",
							);
						}
					} else log.success("All model aliases resolve.");
				}
				if (opts.apply) {
					const { applied, unchanged, writes } = m.planModelSuggestionApply(
						rows,
						{ reassign: opts.reassign === true },
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
						// Without this the command printed nothing at all and exited 0
						// when there was no catalog to pick from - indistinguishable
						// from success.
						if (!applied.length && !unchanged.length)
							log.warn(
								m.hasCatalog()
									? "Nothing applied: no candidate matched these categories."
									: `Nothing applied. ${m.NO_CATALOG_HINT}`,
							);
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
				if (!alias) fail("Usage: agent-cli models test <alias>");
				const r = m.getAlias(alias);
				if (!r) fail(`No such alias: ${alias}`);
				emit({ command: "models", action: "test", alias, ...r, valid: true });
				if (!isJson())
					log.success(
						`Alias '${alias}' → ${r.model}${r.thinking ? " @" + r.thinking : ""}`,
					);
				return;
			}
			fail(
				`Unknown action: ${action}. Use list|set|rm|resolve|write|suggest|lint|usage|test`,
			);
		});
}
