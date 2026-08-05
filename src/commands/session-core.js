// src/commands/session-core.js — doctor + brief, extracted from cli.js
// (HIGH-3). Injected deps: { emit, fail, log, c, pretty, EXIT, isJson,
//   loadConfig, saveConfig, readMaster, detectInstalled, getTarget, classify,
//   isSkillAvailable, identityInventory, computeOnboarding,
//   findUnresolvedModels, listAgents, hasAgentCliBlock, isConfigCorrupt,
//   exists, readFile, path, os, AGENTS_DIR, MASTER_FILE, VERSION, PKG_NAME }.

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
		detectInstalled,
		getTarget,
		classify,
		isSkillAvailable,
		identityInventory,
		computeOnboarding,
		findUnresolvedModels,
		listAgents,
		hasAgentCliBlock,
		isConfigCorrupt,
		exists,
		readFile,
		path,
		os,
		AGENTS_DIR,
		MASTER_FILE,
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
			const issues = [];
			const checks = [];
			const masterContent = await readMaster();
			const masterOk = masterContent != null;
			checks.push({
				check: "config-not-corrupt",
				ok: !isConfigCorrupt(cfg),
				detail: isConfigCorrupt(cfg) ? "config.json is corrupt" : "ok",
			});
			if (isConfigCorrupt(cfg))
				issues.push(
					"config.json is corrupt — repair or remove it before changing settings",
				);
			checks.push({
				check: "master-exists",
				ok: masterOk,
				detail: pretty(MASTER_FILE),
			});
			if (!masterOk) issues.push("Master missing — run `agent init`.");
			checks.push({
				check: "agent-cli-block",
				ok: hasAgentCliBlock(masterContent || ""),
				detail: "managed block in master",
			});
			if (masterOk && !hasAgentCliBlock(masterContent || ""))
				issues.push(
					"agent-cli block missing — run `agent skill refresh` or `agent init`.",
				);

			for (const id of cfg.global) {
				const t = getTarget(id);
				if (!t || !t.global) continue;
				const cls = await classify(t, "global");
				const ok = cls.state === "pointer";
				checks.push({
					check: "pointer:" + id,
					ok,
					detail: cls.state + " " + pretty(cls.path),
				});
				if (!ok && cls.state !== "missing")
					issues.push(`${id} pointer ${cls.state} — run \`agent link\`.`);
			}
			const skillOk = isSkillAvailable();
			checks.push({
				check: "skill-available",
				ok: skillOk,
				detail: skillOk ? "integrated" : "none",
			});
			if (!skillOk)
				issues.push("skill-cli unavailable — run `agent skill setup`.");

			// project skill.config health (false-green guard — doctor must not report
			// all-clear when a broken project skill.config would break the skill gate).
			const sgMod = await import("../skills-gate.js");
			const projSkillConfig = sgMod.readProjectConfig(process.cwd());
			const skillConfigOk = !projSkillConfig || projSkillConfig.ok !== false;
			checks.push({
				check: "skill-config",
				ok: skillConfigOk,
				detail:
					projSkillConfig && projSkillConfig.ok === false
						? "corrupt project skill.config"
						: "ok",
			});
			if (!skillConfigOk)
				issues.push("project skill.config is corrupt — repair or remove it");

			// #1 identity files filled?
			const inv = await identityInventory({
				scope: "global",
				cwd: process.cwd(),
			});
			for (const f of inv.files) {
				if (f.exists && f.filled === false) {
					checks.push({
						check: "identity-filled:" + f.kind,
						ok: false,
						detail: "unfilled template",
					});
					issues.push(
						`${f.kind} is an unfilled template — edit it: agent edit ${f.kind}`,
					);
				}
			}
			// F1: required files must EXIST (false-green guard — doctor must not report
			// healthy when the load manifest would show files as missing).
			const REQUIRED = new Set([
				"identity",
				"soul",
				"user",
				"lessons",
				"environments",
			]);
			const modelsMod = await import("../models.js");
			const modelsMdPath = modelsMod.MODELS_MD;
			const modelsMdExists = await exists(modelsMdPath);
			for (const f of inv.files) {
				if (!REQUIRED.has(f.kind)) continue;
				if (!f.exists) {
					checks.push({
						check: "file-exists:" + f.kind,
						ok: false,
						detail: "missing",
					});
					issues.push(
						`${f.kind} file missing (${pretty(f.path)}) — run \`agent init\` to seed it.`,
					);
				}
			}
			checks.push({
				check: "file-exists:models",
				ok: modelsMdExists,
				detail: modelsMdExists ? pretty(modelsMdPath) : "missing",
			});
			if (!modelsMdExists)
				issues.push(
					`MODELS.md missing (${pretty(modelsMdPath)}) — run \`agent init\` to seed it.`,
				);
			// #2 integration: personalities discoverable + none stranded in old pi path
			const subList = await listAgents({ includeProject: false });
			checks.push({
				check: "personalities-discoverable",
				ok: true,
				detail: `${subList.length} in ~/.agents/agents`,
			});
			// #2b unresolved model aliases → actionable setup guidance
			const unresolvedModels = await findUnresolvedModels();
			checks.push({
				check: "models-resolved",
				ok: unresolvedModels.length === 0,
				detail: unresolvedModels.length
					? unresolvedModels.map((u) => `${u.name} (${u.model})`).join(", ")
					: "all model aliases resolve",
			});
			if (unresolvedModels.length)
				issues.push(
					`unresolved model aliases: ${unresolvedModels
						.map((u) => `${u.name} uses '${u.model}' — run ${u.guidance}`)
						.join("; ")}`,
				);
			const oldPiAgents = path.join(os.homedir(), ".pi", "agent", "agents");
			let orphans = 0;
			try {
				const fspD = await import("node:fs/promises");
				orphans = (await fspD.readdir(oldPiAgents)).filter((n) =>
					n.endsWith(".md"),
				).length;
			} catch {
				/* dir absent */
			}
			if (orphans > 0) {
				checks.push({
					check: "no-orphan-personalities",
					ok: false,
					detail: `${orphans} in old ~/.pi/agent/agents`,
				});
				issues.push(
					`${orphans} personalities stranded in old path ~/.pi/agent/agents — move them to ~/.agents/agents`,
				);
			} else {
				checks.push({
					check: "no-orphan-personalities",
					ok: true,
					detail: "old path clean",
				});
			}
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
			checks.push({
				check: "npm-update",
				ok: !upd.latest || upd.upToDate,
				detail: upd.latest
					? upd.upToDate
						? `latest ${upd.latest}`
						: `latest ${upd.latest} (installed ${VERSION})`
					: "unable to check",
			});
			if (upd.latest && !upd.upToDate)
				issues.push(
					`agent-cli ${upd.latest} is available (installed ${VERSION}).`,
				);
			// staged update payloads awaiting migration
			const seed = await import("../seed.js");
			const staged = await seed.listStagedUpdates({ home: AGENTS_DIR });
			checks.push({
				check: "staged-updates",
				ok: staged.length === 0,
				detail: staged.length ? `${staged.length} payload(s)` : "none",
			});
			if (staged.length)
				issues.push(
					`${staged.length} staged update payload(s) under ~/.agents/update-* — review with the user and migrate (see: agent update list).`,
				);

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
			const cfg = await loadConfig();
			const masterContent = await readMaster();
			const installed = await detectInstalled();
			const conMod = await import("../consolidate.js");
			const consG = conMod.assess({ scope: "global", cwd: process.cwd() });
			const consP = conMod.assess({ scope: "project", cwd: process.cwd() });
			const npm = await import("../npm-check.js");
			const offline =
				opts.offline ||
				opts.network === false ||
				process.env.AGENT_OFFLINE === "1";
			let upd;
			if (opts.refresh && !offline) {
				upd = await npm.ensureUpdateCheck(cfg, PKG_NAME, VERSION, {
					force: true,
					offline,
				});
				if (upd.refreshed) await saveConfig(cfg);
			} else {
				upd = npm.readCachedUpdate(cfg, VERSION);
			}
			const seed = await import("../seed.js");
			const stagedUpdates = await seed.listStagedUpdates({ home: AGENTS_DIR });
			const idMod = await import("../identity.js");
			const invG = await identityInventory({
				scope: "global",
				cwd: process.cwd(),
			});
			const projectBase = path.join(process.cwd(), ".agents");
			const invP =
				projectBase !== AGENTS_DIR
					? await identityInventory({
							scope: "project",
							cwd: process.cwd(),
						})
					: null;
			const modelsMod = await import("../models.js");
			const spectMod = await import("../spect.js");
			const spect = await spectMod.inspectSpect(process.cwd());
			const spectHeadline =
				spect.initialized || spect.partial
					? await spectMod.spectHeadline(process.cwd())
					: null;
			const { gapReport, archetypeNeeded, gapRecommended } =
				computeOnboarding(invG);
			const onboarding = {
				recommended: gapRecommended,
				archetypeNeeded,
				gaps: gapReport,
				...(archetypeNeeded ? idMod.onboardSuggest() : {}),
			};
			// F2: load manifest = global + (project override where allowed) + MODELS.md.
			// Kinds flagged `globalOnly` (identity / user / models) never get a project
			// entry — they have a single canonical home and don't vary per project.
			const sessionLoad = [];
			for (const gF of invG.files) {
				sessionLoad.push({
					kind: gF.kind,
					scope: "global",
					path: gF.path,
					exists: gF.exists,
					filled: gF.filled,
					gaps: gF.gaps,
					globalOnly: !!gF.globalOnly,
				});
				if (invP && !gF.globalOnly) {
					const pF = invP.files.find((x) => x.kind === gF.kind);
					if (pF) {
						sessionLoad.push({
							kind: pF.kind,
							scope: "project",
							path: pF.path,
							exists: pF.exists,
							filled: pF.filled,
							gaps: pF.gaps,
							globalOnly: false,
						});
					}
				}
			}
			if (spect.initialized || spect.partial)
				for (const file of new Set([
					...(spect.load || []),
					...(spect.missingFiles || []),
				]))
					sessionLoad.push({
						kind: "spect",
						scope: "project",
						path: file,
						exists: !(spect.missingFiles || []).includes(file),
						filled: !(spect.missingFiles || []).includes(file),
						gaps: (spect.missingFiles || []).includes(file)
							? ["missing"]
							: null,
					});
			// AX: surface the lesson index (filenames ARE the summaries) + inbox so the agent
			// actually loads memory at session start instead of only seeing a score. Also load the
			// LESSONS.md core DIRECTLY (critical-lesson pointer index) so it's never skipped.
			// Project lessons are included; project core takes precedence over global core.
			const { listLessons, coreFile } = await import("../lessons-lib.js");
			const lessonsIndex = (await listLessons({ includeProject: true }))
				.map((l) => ({
					path: l.path,
					scope: l.scope,
					occurrences: l.occurrences,
					marked: l.marked,
				}))
				.sort((a, b) => a.path.localeCompare(b.path));
			const inboxCount =
				(consG.metrics.inbox || 0) + (consP.metrics.inbox || 0);
			let coreContent = null;
			let coreScope = null;
			for (const scope of ["project", "global"]) {
				try {
					const md = await readFile(coreFile(scope, process.cwd()));
					const idx = md.indexOf("## Core");
					if (idx >= 0) {
						const cleaned = md
							.slice(idx + "## Core".length)
							.replace(/<!--[\s\S]*?-->/g, "")
							.trim();
						if (cleaned) {
							coreContent = cleaned;
							coreScope = scope;
							break;
						}
					}
				} catch {
					/* no core file */
				}
			}
			const unresolvedModels = await findUnresolvedModels();
			const pointerTargets = [];
			const drift = [];
			for (const id of cfg.global) {
				const t = getTarget(id);
				if (!t || !t.global) continue;
				const cls = await classify(t, "global");
				pointerTargets.push({
					id,
					scope: "global",
					state: cls.state,
					path: cls.path,
				});
				if (cls.state !== "pointer") drift.push(id);
			}
			// Structured executable actions (the session contract) + legacy strings.
			const actMod = await import("../actions.js");
			const actionsList = actMod.buildActions({
				masterContent,
				archetypeNeeded,
				pointerTargets,
				consG,
				consP,
				upd,
				stagedUpdates,
				inboxCount,
				unresolvedModels,
				liveCatalogAge: modelsMod.liveCatalogAgeDays(),
			});
			const suggested = actMod.suggestedStrings(actionsList);
			const etag = actMod.computeEtag({
				masterContent,
				drift,
				archetypeNeeded,
				unresolvedModels,
				consG,
				consP,
				stagedUpdates,
				inboxCount,
				upd,
			});
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

			const blockers = [];
			if (masterContent == null)
				blockers.push("master missing — run `agent init`");
			const warnings = [];
			if (archetypeNeeded) warnings.push("identity onboarding incomplete");
			if (unresolvedModels.length)
				warnings.push(`${unresolvedModels.length} unresolved model alias(es)`);
			if (consG.recommend || consP.recommend)
				warnings.push("lesson consolidation recommended");
			if (upd.latest && !upd.upToDate)
				warnings.push(`agent-cli ${upd.latest} available`);

			const out = {
				tool: "agent-cli",
				version: VERSION,
				schemaVersion: "1.1.0",
				health:
					masterContent == null ||
					drift.length > 0 ||
					archetypeNeeded ||
					unresolvedModels.length > 0
						? "degraded"
						: "ready",
				warnings,
				blockers,
				etag,
				actions: actionsList,
				...(forTask ? { forTask } : {}),
				master: {
					path: pretty(MASTER_FILE),
					absolute: MASTER_FILE,
					exists: masterContent != null,
					hasAgentCliBlock: hasAgentCliBlock(masterContent || ""),
				},
				enabledGlobal: cfg.global,
				installed,
				pointerTargets,
				drift,
				skill: {
					available: isSkillAvailable(),
				},
				suggestedActions: suggested,
				consolidation: {
					global: {
						score: consG.score,
						recommend: consG.recommend,
						reasons: consG.reasons,
						metrics: consG.metrics,
					},
					project: {
						score: consP.score,
						recommend: consP.recommend,
						reasons: consP.reasons,
						metrics: consP.metrics,
					},
				},
				update: {
					installedVersion: VERSION,
					latest: upd.latest,
					upToDate: upd.upToDate,
					checkedAt: upd.checkedAt,
					stagedUpdates,
				},
				onboarding,
				sessionStart: {
					load: sessionLoad,
				},
				lessons: {
					count: lessonsIndex.length,
					index: lessonsIndex,
					inbox: inboxCount,
					core: coreContent,
					coreScope,
				},
				modelAliases: {
					unresolved: unresolvedModels,
				},
				project: {
					spect,
					...(spectHeadline ? { spectHeadline } : {}),
				},
			};
			// --since: unchanged state → no actions (etag cache for cron/CI polling).
			if (opts.since && opts.since === etag) {
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
				if (archetypeNeeded) {
					log.warn("Onboarding needed — ask the user (one question):");
					log.raw(c.bold(onboarding.question));
					log.raw(
						`  ${c.gray("(" + onboarding.options.map((o) => o.key).join(" | ") + ")")}`,
					);
					log.dim(
						"Then: agent identity apply <choice> [--soul <v>]. Other missing fields: agent identity/soul/user set <field> <value>.",
					);
				} else if (gapRecommended) {
					const gapStr = Object.entries(gapReport)
						.map(([k, v]) => `${k}: ${v.join(", ")}`)
						.join("; ");
					log.warn(
						`Information gap: ${c.yellow(gapStr)} — fill these (one Run line per field):`,
					);
					for (const hint of actMod.gapFixHints(gapReport)) {
						log.raw(`  ${c.cyan("Run:")} ${hint}`);
					}
				}
				if (unresolvedModels.length) {
					log.warn(
						`Unresolved model alias${unresolvedModels.length > 1 ? "es" : ""}:`,
					);
					for (const u of unresolvedModels) {
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
					`${pointerTargets.filter((p) => p.state === "pointer").length}/${pointerTargets.length} ok`,
				);
				log.kv(
					"skill-cli",
					out.skill.available ? c.green("✓ integrated") : c.red("✗"),
				);
				log.kv(
					"drift",
					drift.length ? c.yellow(drift.join(", ")) : c.green("none"),
				);
				log.kv(
					"consolidation",
					`score ${consG.score}${consG.recommend ? " ⚠" : ""} (global)${consP.recommend ? `, ${consP.score} ⚠ (project)` : ""}`,
				);
				log.kv(
					"update",
					upd.latest
						? upd.upToDate
							? c.green("up to date") + " " + c.gray("(" + upd.latest + ")")
							: c.yellow(upd.latest + " available")
						: c.gray("unknown"),
				);
				if (stagedUpdates.length)
					log.kv(
						"staged",
						c.yellow(`${stagedUpdates.length} payload(s) — agent update list`),
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
					if (f.kind === "lessons" && f.scope === "project" && f.filled !== true) {
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
				if (spect.initialized) {
					log.raw(c.bold("\nSPECT project workflow:"));
					log.raw(
						`  ${pretty(spect.root)} — ${spect.counts.specs} specs, ${spect.counts.plans} plans, ${spect.counts.tasks} tasks`,
					);
				} else {
					log.dim(
						"\nSPECT: not initialized (run agent spect init when using spec-driven work)",
					);
				}
				if (coreContent) {
					log.raw(c.bold("\nCore lessons (always-on — LESSONS.md):"));
					for (const line of coreContent.split("\n"))
						if (line.trim()) log.raw(`  ${line}`);
				}
				if (lessonsIndex.length) {
					log.raw(
						c.bold("\nLessons (filenames = summaries; read only relevant):"),
					);
					for (const l of lessonsIndex)
						log.raw(
							`  ${c.gray("×" + l.occurrences)} ${l.path}${l.marked ? c.yellow(" ⚠marked") : ""}`,
						);
				}
				if (inboxCount)
					log.dim(
						`inbox: ${inboxCount} raw capture(s) — triage: agent lessons inbox`,
					);
				if (suggested.length) log.raw(c.bold("\nSuggested:"));
				for (const s of suggested) log.raw(`  ${c.cyan(s)}`);
				if (!suggested.length && !gapRecommended)
					log.success("Everything in sync.");
			}
			if (opts.check) process.exit(out.actions.length ? EXIT.WORK : EXIT.OK);
		});
}
