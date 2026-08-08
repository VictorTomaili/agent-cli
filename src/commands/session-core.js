// src/commands/session-core.js — doctor + brief, extracted from cli.js
// (HIGH-3). Injected deps: { emit, log, c, pretty, EXIT, isJson, loadConfig,
//   saveConfig, readMaster, VERSION, PKG_NAME }.
//
// The payload-building logic (doctor's checks/issues, brief's JSON envelope)
// lives in src/doctor-report.js and src/brief-report.js as pure, testable
// functions (they import their own read-only helpers, same as
// src/actions.js#collectState/buildActions). These action handlers stay
// thin: gather already-loaded config/state, call the pure builder, then
// handle emit/log/human-vs-JSON formatting and --fix-safe/--apply-safe side
// effects.

/** Register the doctor + brief commands. */
export function registerSessionCoreCommands(
	program,
	{
		emit,
		log,
		c,
		pretty,
		EXIT,
		isJson,
		loadConfig,
		saveConfig,
		readMaster,
		VERSION,
		PKG_NAME,
	},
) {
	program
		.command("doctor")
		.description(
			"Diagnose master, pointers, skill-cli, staged updates, and npm version.",
		)
		.option("--force", "force a fresh npm version check (writes config.json)")
		.option("--refresh", "alias for --force")
		.option("--offline", "never hit the network; use the cached check only")
		.option("--no-network", "alias for --offline")
		.option("--plan", "include the structured action plan in the payload")
		.option("--fix-safe", "apply the safeToAutomate action prefix")
		.action(async (opts = {}) => {
			const cfg = await loadConfig();
			const masterContent = await readMaster();

			// npm latest version (cached by default; --force/--refresh to hit network)
			const npm = await import("../npm-check.js");
			const offline =
				opts.offline ||
				opts.network === false ||
				process.env.AGENT_OFFLINE === "1";
			let upd;
			if ((opts.force || opts.refresh) && !offline) {
				upd = await npm.ensureUpdateCheck(cfg, PKG_NAME, VERSION, {
					force: true,
					offline,
				});
				if (upd.refreshed) await saveConfig(cfg);
			} else {
				upd = npm.readCachedUpdate(cfg, VERSION);
			}

			const { buildDoctorReport } = await import("../doctor-report.js");
			const { issues, checks } = await buildDoctorReport(cfg, {
				masterContent,
				upd,
				version: VERSION,
				cwd: process.cwd(),
			});

			let plan = null;
			let fix = null;
			if (opts.plan || opts.fixSafe) {
				const actMod = await import("../actions.js");
				const s = await actMod.collectState({ offline: true });
				plan = actMod.buildActions(s);
				if (opts.fixSafe) fix = actMod.applySafe(plan);
			}
			const out = {
				command: "doctor",
				issues,
				checks,
				...(plan ? { plan } : {}),
				...(fix
					? {
							fix: {
								receipts: fix.receipts,
								applied: fix.applied,
								skipped: fix.skipped,
							},
						}
					: {}),
			};
			emit(out);
			if (!isJson()) {
				for (const ck of checks) {
					log.raw(
						`  ${ck.ok ? c.green("✓") : c.red("✗")} ${ck.check.padEnd(20)} ${c.gray(ck.detail)}`,
					);
				}
				if (issues.length) {
					log.raw("");
					for (const i of issues) log.warn(i);
				} else log.success("All checks passed.");
			}
			if (issues.length) process.exit(EXIT.WORK);
		});

	// ---------------------------------------------------------------------------
	// agent brief — AI session entrypoint (the `skill active` analogue)
	// ---------------------------------------------------------------------------
	program
		.command("brief")
		.description(
			"AI session brief: machine-readable state + suggested next actions.",
		)
		.option("--refresh", "force a fresh npm update check (writes config.json)")
		.option("--offline", "never hit the network; use the cached check only")
		.option("--no-network", "alias for --offline")
		.option(
			"--check",
			"exit 2 when suggested work exists, else 0 (CI/cron primitive)",
		)
		.option("--next", "emit only the highest-priority action")
		.option("--plan", "emit the full ordered action plan (default; no writes)")
		.option(
			"--apply-safe",
			"execute safeToAutomate actions, stop before user/destructive",
		)
		.option(
			"--for <task>",
			"task-aware retrieval: attach relevant search hits (alias: --for-task)",
		)
		.option(
			"--since <etag>",
			"return no actions when the state etag is unchanged (cache)",
		)
		.option("--oneline", "one-line status for shell prompts")
		.action(async (opts) => {
			const offline =
				opts.offline ||
				opts.network === false ||
				process.env.AGENT_OFFLINE === "1";
			const actMod = await import("../actions.js");
			const s = await actMod.collectState({
				cwd: process.cwd(),
				offline,
				refresh: opts.refresh,
				pkgName: PKG_NAME,
			});
			if (s.upd.refreshed) await saveConfig(s.cfg);

			// --for: task-aware retrieval (search over the brain). The option is
			// declared as '--for <task>' so commander exposes it as opts.for.
			let forTask = null;
			const taskQuery = opts.for || opts.forTask;
			if (taskQuery) {
				const searchMod = await import("../search.js");
				const sr = await searchMod.searchAll(taskQuery, { project: true });
				forTask = { query: taskQuery, hits: sr.results.slice(0, 5) };
			}
			// --apply-safe: run the safe prefix now, emit receipts, and exit.
			if (opts.applySafe) {
				const actionsList = actMod.buildActions(s);
				const res = actMod.applySafe(actionsList);
				emit({
					command: "brief",
					applySafe: true,
					receipts: res.receipts,
					applied: res.applied,
					skipped: res.skipped,
					stoppedAt: res.stoppedAt,
				});
				if (!isJson())
					for (const r of res.receipts)
						log.raw(
							`  ${r.applied ? c.green("✓") : c.gray("·")} ${r.id}${r.skipped ? c.yellow(" (not safe)") : ""}`,
						);
				const attempted = res.receipts.filter((r) => !r.skipped);
				process.exit(attempted.some((r) => !r.applied) ? EXIT.ERROR : EXIT.OK);
			}

			const { buildBriefPayload } = await import("../brief-report.js");
			const out = buildBriefPayload(s, { forTask, version: VERSION });

			// --since: unchanged state → no actions (etag cache for cron/CI polling).
			if (opts.since && opts.since === out.etag) {
				out.actions = [];
				out.suggestedActions = [];
				out.unchanged = true;
			}
			// --next: highest-priority action only.
			if (opts.next) out.actions = out.actions.length ? [out.actions[0]] : [];
			if (opts.oneline) {
				const onelineText = `v${VERSION} ${out.health === "ready" ? "✓" : "!"} ${out.actions.length} action${out.actions.length === 1 ? "" : "s"}${out.drift.length ? ` drift:${out.drift.join(",")}` : ""}`;
				// Default: print the plain oneline text to stdout (so shell prompts
				// can use it via $(agent brief --oneline)). Under --json, emit the
				// JSON envelope (data.onelineText) and don't pollute stdout.
				if (isJson()) {
					emit({
						command: "brief",
						oneline: true,
						onelineText,
						health: out.health,
						actions: out.actions.length,
						drift: out.drift.length,
					});
				} else {
					process.stdout.write(onelineText + "\n");
				}
				if (opts.check) process.exit(out.actions.length ? EXIT.WORK : EXIT.OK);
				return;
			}
			emit(out);
			if (!isJson()) {
				if (s.archetypeNeeded) {
					log.warn("Onboarding needed — ask the user (one question):");
					log.raw(c.bold(s.onboarding.question));
					log.raw(
						`  ${c.gray("(" + s.onboarding.options.map((o) => o.key).join(" | ") + ")")}`,
					);
					log.dim(
						"Then: agent identity apply <choice> [--soul <v>]. Other missing fields: agent identity/soul/user set <field> <value>.",
					);
				} else if (s.gapRecommended) {
					const gapStr = Object.entries(s.gapReport)
						.map(([k, v]) => `${k}: ${v.join(", ")}`)
						.join("; ");
					log.warn(
						`Information gap: ${c.yellow(gapStr)} — fill these (one Run line per field):`,
					);
					for (const hint of actMod.gapFixHints(s.gapReport)) {
						log.raw(`  ${c.cyan("Run:")} ${hint}`);
					}
				}
				if (s.unresolvedModels.length) {
					log.warn(
						`Unresolved model alias${s.unresolvedModels.length > 1 ? "es" : ""}:`,
					);
					for (const u of s.unresolvedModels) {
						const scope = u.scope ? c.gray(`[${u.scope}]`) : "";
						log.raw(
							`  ${c.bold(u.name)} ${scope}: ${c.yellow(u.model)} — ${c.cyan(u.guidance)}`,
						);
					}
				}
				log.kv(
					"master",
					out.master.exists
						? c.green("✓") + " " + out.master.path
						: c.red("✗ missing"),
				);
				log.kv(
					"pointers",
					`${s.pointerTargets.filter((p) => p.state === "pointer").length}/${s.pointerTargets.length} ok`,
				);
				log.kv(
					"skill-cli",
					out.skill.available ? c.green("✓ integrated") : c.red("✗"),
				);
				log.kv(
					"drift",
					s.drift.length ? c.yellow(s.drift.join(", ")) : c.green("none"),
				);
				log.kv(
					"consolidation",
					`score ${s.consG.score}${s.consG.recommend ? " ⚠" : ""} (global)${s.consP.recommend ? `, ${s.consP.score} ⚠ (project)` : ""}`,
				);
				log.kv(
					"update",
					s.upd.latest
						? s.upd.upToDate
							? c.green("up to date") + " " + c.gray("(" + s.upd.latest + ")")
							: c.yellow(s.upd.latest + " available")
						: c.gray("unknown"),
				);
				if (s.stagedUpdates.length)
					log.kv(
						"staged",
						c.yellow(`${s.stagedUpdates.length} payload(s) — agent update list`),
					);
				// AX: tell the agent exactly what to read now, and surface the lesson index.
				// The order is MANDATORY (see AGENTS.md "Session start read order" + the
				// test/identity-files-order.test.js regression). Number each step so the
				// model reads them in sequence, not in parallel or out of order.
				log.raw(
					c.bold(
						"\nSession start — read in this EXACT order (do NOT skip ahead):",
					),
				);
				out.sessionStart.load.forEach((f, i) => {
					let tag;
					// Project LESSONS.md is OPTIONAL — a missing or empty file just means
					// "no project-specific lessons yet", which is a legitimate state (the
					// global LESSONS.md carries the system-wide lessons). Don't surface it
					// as a gap or a missing-file warning — only flag global lessons.
					if (
						f.kind === "lessons" &&
						f.scope === "project" &&
						f.filled !== true
					) {
						tag = c.cyan("(no project lessons yet)");
					} else if (!f.exists) tag = c.gray("(missing)");
					else if (f.filled === false || (f.gaps && f.gaps.length))
						tag = c.yellow(`(gap: ${(f.gaps || []).join(", ") || "unfilled"})`);
					else tag = c.green("✓");
					// Make the global-only design explicit in the output: a model that
					// sees `(global only)` knows not to look for a project override.
					if (f.scope === "global" && f.globalOnly) {
						tag += c.cyan(" (global only)");
					}
					const kindLabel = f.scope === "project" ? `${f.kind} (proj)` : f.kind;
					const num = String(i + 1).padStart(2, " ");
					log.raw(
						`  ${c.cyan(num + ".")} ${kindLabel.padEnd(18)} ${pretty(f.path)}  ${tag}`,
					);
				});
				if (s.spect.initialized) {
					log.raw(c.bold("\nSPECT project workflow:"));
					log.raw(
						`  ${pretty(s.spect.root)} — ${s.spect.counts.specs} specs, ${s.spect.counts.plans} plans, ${s.spect.counts.tasks} tasks`,
					);
				} else {
					log.dim(
						"\nSPECT: not initialized (run agent spect init when using spec-driven work)",
					);
				}
				if (s.coreContent) {
					log.raw(c.bold("\nCore lessons (always-on — LESSONS.md):"));
					for (const line of s.coreContent.split("\n"))
						if (line.trim()) log.raw(`  ${line}`);
				}
				if (s.lessonsIndex.length) {
					log.raw(
						c.bold("\nLessons (filenames = summaries; read only relevant):"),
					);
					for (const l of s.lessonsIndex)
						log.raw(
							`  ${c.gray("×" + l.occurrences)} ${l.path}${l.marked ? c.yellow(" ⚠marked") : ""}`,
						);
				}
				if (s.inboxCount)
					log.dim(
						`inbox: ${s.inboxCount} raw capture(s) — triage: agent lessons inbox`,
					);
				if (out.suggestedActions.length) log.raw(c.bold("\nSuggested:"));
				for (const sug of out.suggestedActions) log.raw(`  ${c.cyan(sug)}`);
				if (!out.suggestedActions.length && !s.gapRecommended)
					log.success("Everything in sync.");
			}
			if (opts.check) process.exit(out.actions.length ? EXIT.WORK : EXIT.OK);
		});
}
