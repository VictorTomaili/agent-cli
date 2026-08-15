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
				const hasCatalog = before.includes("## Curated model catalog");
				if (!hasCatalog || opts.refresh) {
					const out = m.writeModelsMd({
						includeCatalog: true,
						refreshCatalog: true,
					});
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
							const src = opts.reassign ? "live" : "bundled";
							log.dim(
								`${applicable} alias${applicable === 1 ? "" : "es"} auto-pickable from the ${src} catalog. Apply with: agent models suggest --apply${opts.reassign ? " --reassign" : ""}`,
							);
						} else {
							log.dim(
								"No catalog match — assign manually: agent models set <alias> <provider/model>.",
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
}
