// src/commands/bootstrap.js — init + brief-hooks, extracted from cli.js
// (HIGH-3). Injected deps: { emit, fail, log, c, pretty, isJson, TARGETS,
//   loadConfig, saveConfig, detectInstalled, getTarget, enableGlobal,
//   ensureMaster, ensureMasterPointer, ensureSkillStore,
//   stripSkillBlockFromMaster, linkTarget, ctxPaths, exists, writeFile,
//   path, AGENTS_DIR, MASTER_FILE, HOME_POINTER_FILE, VERSION }.

/** Register the init + brief-hooks commands. */
export function registerBootstrapCommands(
	program,
	{
		emit,
		fail,
		log,
		c,
		pretty,
		isJson,
		TARGETS,
		loadConfig,
		saveConfig,
		detectInstalled,
		getTarget,
		enableGlobal,
		ensureMaster,
		ensureMasterPointer,
		ensureSkillStore,
		stripSkillBlockFromMaster,
		linkTarget,
		ctxPaths,
		exists,
		writeFile,
		path,
		AGENTS_DIR,
		MASTER_FILE,
		HOME_POINTER_FILE,
		VERSION,
	},
) {
	function getTargetByFile(homeRel) {
		// homeRel like '.pi/agent/AGENTS.md' → match a target whose global ends with that
		for (const t of TARGETS) {
			if (
				t.global &&
				(t.global === homeRel ||
					t.global.endsWith("/" + homeRel) ||
					homeRel.endsWith(t.global))
			) {
				return t.id;
			}
		}
		return null;
	}

	// ---------------------------------------------------------------------------
	// agent-cli init
	// ---------------------------------------------------------------------------
	program
		.command("init")
		.description(
			"Bootstrap the ~/.agents/AGENTS.md master, deploy pointer stubs, deploy the home pointer at ~/AGENTS.md, install SessionStart brief hooks, and set up skill-cli. Idempotent — re-runs repair any missing parts.",
		)
		.option("--no-skill", "Skip skill-cli setup")
		.option(
			"--yes",
			"Confirm any non-interactive defaults (no-op; agent-cli never prompts)",
		)
		.option(
			"--force",
			"Overwrite native content in ~/AGENTS.md (destructive) and re-write all missing parts",
		)
		.action(async (opts) => {
			const result = { command: "init", steps: {} };

			// 1. master + managed blocks
			const master = await ensureMaster();
			result.steps.master = master;
			if (master.skipped) {
				fail(
					`Cannot initialize: ${master.skipped}. Preserve the existing master and repair it before retrying.`,
					{ command: "init", steps: result.steps },
				);
			}
			if (!isJson()) {
				// Layout migration outcome (old ~/AGENTS.md master → ~/.agents/AGENTS.md):
				// one clear line naming the backup, or a divergence warning.
				if (master.action === "migrated") {
					log.success(
						`Master migrated to ${c.cyan(pretty(MASTER_FILE))} — previous copy backed up at ${c.cyan(pretty(master.backup))}`,
					);
				} else if (master.action === "diverged" && master.warning) {
					log.warn(master.warning);
				}
			}

			// 2. detect + enable installed global targets
			const cfg = await loadConfig();
			const installed = await detectInstalled();
			for (const id of installed) {
				const t = getTarget(id);
				if (t && t.global) enableGlobal(cfg, id);
			}
			result.steps.detected = installed;

			// 3. skill-cli store + block (block already ensured by ensureMaster)
			if (opts.skill !== false && cfg.skillManaged) {
				result.steps.skillStore = await ensureSkillStore();
			} else if (opts.skill === false) {
				// --no-skill: suppress the skill-cli block that ensureMaster injected,
				// not just the store setup.
				result.steps.skillBlockRemoved = await stripSkillBlockFromMaster();
			}

			// 4. seed defaults: first install writes them into ~/.agents; a version bump
			//    stages new defaults into ~/.agents/update-<version>/ for review.
			//    Existing user files are never overwritten.
			const seed = await import("../seed.js");
			const seedPlan = seed.planSeedAction(cfg.seedVersion, VERSION);
			const seedEntries = await seed.listSeedFiles();
			const currentSeedFiles = seedEntries.map((f) => f.rel).sort();
			if (seedPlan.action === "install") {
				result.steps.seeds = await seed.installSeeds({ home: AGENTS_DIR });
			} else if (seedPlan.action === "stage") {
				result.steps.seeds = await seed.stageSeeds({
					home: AGENTS_DIR,
					version: VERSION,
					previousFiles: cfg.seedFiles || [],
				});
			}
			cfg.seedFiles = currentSeedFiles;
			cfg.seedVersion = VERSION;

			await saveConfig(cfg);

			// 4b. seed the full identity/memory file set (NON-DESTRUCTIVE) + empty model document.
			//     Model mappings are agent-owned; init never invents provider choices.
			//     required set so brief/doctor don't report missing files.
			const arc = await import("../archetypes.js");
			const models = await import("../models.js");
			const home = AGENTS_DIR;
			const identityFiles = [
				["IDENTITY.md", arc.identityContent(arc.DEFAULT_IDENTITY)],
				["SOUL.md", arc.soulContent(arc.DEFAULT_SOUL)],
				["USER.md", arc.userContent()],
				["LESSONS.md", arc.lessonsContent()],
				["ENVIRONMENTS.md", arc.environmentsContent()],
				// last, mirroring IDENTITY_FILES: WORKFLOW.md is read after MODELS.md.
				["WORKFLOW.md", arc.workflowContent()],
			];
			const idCreated = [];
			const idSkipped = [];
			for (const [name, content] of identityFiles) {
				const fp = path.join(home, name);
				if (await exists(fp)) {
					idSkipped.push(name);
					continue;
				}
				await writeFile(fp, content);
				idCreated.push(name);
			}
			const modelsMdPath = models.MODELS_MD;
			let modelsMdCreated = false;
			if (!(await exists(modelsMdPath))) {
				models.writeModelsMd();
				modelsMdCreated = true;
			}
			result.steps.identityFiles = { created: idCreated, skipped: idSkipped };
			result.steps.models = {
				modelsMdCreated,
			};

			// 5. deploy home pointer stub at ~/AGENTS.md (idempotent; re-creates it
			//    if missing or stale so agent-cli is the only writer of that path).
			const mTildeForPointer = ctxPaths().masterTilde;
			// The layout migration inside ensureMaster already replaced ~/AGENTS.md
			// with the home pointer when it moved the master — ensureMasterPointer
			// then no-ops (identical content). --force still overrides stray native
			// content at ~/AGENTS.md.
			const forcePointer = !!opts.force;
			const homePointer = await ensureMasterPointer({
				masterAbs: MASTER_FILE,
				masterTilde: mTildeForPointer,
				force: forcePointer,
			});
			result.steps.homePointer = homePointer;

			// 6. deploy per-target pointer stubs (non-destructive; auto-convert the seed source)
			const { masterAbs, masterTilde: mTilde } = ctxPaths();
			const seedId = master.seed ? getTargetByFile(master.seed) : null;
			const deploy = [];
			for (const id of cfg.global) {
				const t = getTarget(id);
				if (!t) continue;
				const seedForce = seedId === id; // seed content already lives in master
				const force = seedForce || !!opts.force; // --force on init promotes seed+re-init overwrite
				const r = await linkTarget(t, "global", {
					masterAbs,
					masterTilde: mTilde,
					force,
				});
				deploy.push({ id, name: t.name, ...r });
			}
			result.steps.deploy = deploy;

			// 6b. cross-tool share links (manage once, use everywhere): link every
			// enabled, share-capable tool's agents/skills dir to the single sources.
			// Non-destructive — native dirs are left alone and reported (the user can
			// `link agents|skills --force` to adopt them with a backup).
			try {
				const share = await import("../share.js");
				const shareOut = {};
				for (const kind of share.SHARE_KINDS) {
					const results = share.linkShared(kind, cfg.global, { force: false });
					shareOut[kind] = {
						linked: results.filter((r) => r.linked && !r.unchanged).length,
						alreadyLinked: results.filter((r) => r.unchanged).length,
						blocked: results.filter((r) => r.blocked).length,
					};
				}
				result.steps.shareLinks = shareOut;
			} catch (e) {
				result.steps.shareLinks = { error: e.message };
			}
			result.config = { global: cfg.global, project: cfg.project };

			// 7. auto-install SessionStart brief hooks for enabled targets (best-effort).
			try {
				const hooks = await import("../hooks.js");
				const enabledIds = new Set(cfg.global);
				const hookCapable = hooks
					.targetsWithHooks()
					.filter((t) => enabledIds.has(t.id));
				const hookResults = [];
				for (const t of hookCapable) {
					hookResults.push(await hooks.installHook(t, { force: !!opts.force }));
				}
				result.steps.hooks = {
					count: hookResults.length,
					installed: hookResults.filter((r) => r.installed).length,
					skipped: hookResults.filter((r) => r.skipped).length,
					blocked: hookResults.filter((r) => r.blocked).length,
				};
			} catch (e) {
				result.steps.hooks = { error: e.message };
			}

			// 8. auto-capture environment info (OS, shell, home, ssh aliases).
			//    Non-destructive: fills empty ENVIRONMENTS.md fields only.
			try {
				const envMod = await import("../env-capture.js");
				const envResult = await envMod.captureAndApply({ cwd: process.cwd() });
				result.steps.envCapture = {
					filled: envResult.filled || 0,
					detected: envResult.detected || {},
					sshAliases: (envResult.sshAliases || []).length,
				};
			} catch (e) {
				result.steps.envCapture = { error: e.message };
			}

			// 9. auto-pick model aliases from the bundled catalog so personas
			//    are immediately usable without manual model assignment.
			try {
				const hooks = await import("../agents-lib.js");
				const unresolved = await hooks.findUnresolvedModels();
				if (unresolved.length > 0) {
					const applied = [];
					// Group by alias like models suggest does.
					const byAlias = new Map();
					for (const u of unresolved) {
						const arr = byAlias.get(u.model) || [];
						arr.push(u);
						byAlias.set(u.model, arr);
					}
					for (const [alias, personas] of byAlias) {
						const hint = String(alias)
							.replace(/-model$/, "")
							.toLowerCase();
						let category = models.CATEGORIES.includes(hint) ? hint : null;
						if (!category) category = "smart"; // fallback
						const picked = models.pickForCategory(category);
						if (picked) {
							models.setAlias(alias, {
								model: `${picked.provider}/${picked.id}`,
								category,
								thinking: picked.thinking ? "on" : undefined,
							});
							applied.push({
								alias,
								model: `${picked.provider}/${picked.id}`,
								personas: personas.length,
							});
						}
					}
					if (applied.length > 0) {
						models.writeModelsMd();
						result.steps.autoModels = { applied: applied.length, aliases: applied };
					}
				}
			} catch (e) {
				result.steps.autoModels = { error: e.message };
			}

			emit(result);

			if (!isJson()) {
				const linked = deploy.filter((d) => d.linked).length;
				const blocked = deploy.filter((d) => d.blocked);
				log.info(
					`Pointers: ${c.green(linked + " linked")}, ${cfg.global.length} global targets enabled`,
				);
				if (cfg.global.length === 0) {
					const installed = await detectInstalled();
					const installable = installed.filter((id) => {
						const t = TARGETS.find((x) => x.id === id);
						return t && t.global;
					});
					if (installable.length) {
						log.dim(
							`Detected ${installable.length} installable target(s): ${installable.join(", ")}. Enable with: agent-cli target enable ${installable.slice(0, 3).join(" ")}${installable.length > 3 ? " …" : ""}`,
						);
					} else {
						log.dim(
							"No targets detected yet. Install a supported agent (claude/codex/gemini/pi/...) and run 'agent-cli init' again, or 'agent-cli target enable <id>' to enable manually.",
						);
					}
				}
				// Home pointer stub status is independent of target count: report
				// created/overwritten/updated/native-content whenever it happened.
				if (
					homePointer.action === "created" ||
					homePointer.action === "overwritten"
				) {
					log.success(
						`Home pointer stub written: ${c.cyan(pretty(HOME_POINTER_FILE))}`,
					);
				} else if (homePointer.action === "updated") {
					log.info(
						`Home pointer stub refreshed: ${c.cyan(pretty(HOME_POINTER_FILE))}`,
					);
				} else if (homePointer.skipped === "native-content") {
					log.warn(
						`Home pointer stub at ${c.cyan(pretty(HOME_POINTER_FILE))} has native content — run ${c.cyan("agent-cli init --force")} to replace it.`,
					);
				}
				if (blocked.length) {
					for (const b of blocked) {
						log.warn(
							`${b.name}: native content — run ${c.cyan("agent-cli pull " + b.id)} then ${c.cyan("agent-cli link --force")}`,
						);
					}
				}
				log.dim(
					`Next: run ${c.cyan("agent-cli brief")}, then read every file under "Load at session start". Edit the master: ${c.cyan("agent-cli edit")}.`,
				);
			}
		});

	// ---------------------------------------------------------------------------
	// agent-cli brief-hooks (SessionStart auto-brief for supported agents)
	//
	// Named `brief-hooks` (not `hooks`) because `agent-cli hooks` is already the
	// git-hooks command; commander requires unique command names. The two share
	// the same noun in user-facing help text but operate on entirely different
	// files.
	// ---------------------------------------------------------------------------
	program
		.command("brief-hooks <action>")
		.description(
			"Manage native SessionStart hooks for supported agents. Action: install | uninstall | status. Each installs a hook that calls `agent-cli brief --oneline` at session start (unrelated to `agent-cli hooks`, which manages git post-merge/checkout hooks).",
		)
		.option(
			"-t, --target <ids...>",
			"Restrict to a subset of hook-capable target ids (default: all enabled)",
		)
		.option(
			"--force",
			"Overwrite native (non-agent-cli) hook entries (destructive)",
		)
		.action(async (action, opts) => {
			const hooks = await import("../hooks.js");
			const cfg = await loadConfig();
			const enabledIds = new Set(cfg.global);
			const known = hooks.targetsWithHooks().map((t) => t.id);
			let ids = opts.target || known;
			// When the user didn't pass --target, restrict to ENABLED targets.
			if (!opts.target) ids = ids.filter((id) => enabledIds.has(id));
			const targets = ids
				.map((id) => hooks.getTarget(id) || getTarget(id))
				.filter(Boolean);
			const unknown = ids.filter((id) => !targets.find((t) => t.id === id));
			if (unknown.length) {
				fail(
					`Unknown target id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Hook-capable ids: ${known.join(", ")}.`,
					{ command: "brief-hooks", action, target: unknown },
				);
			}
			const out = { command: "brief-hooks", action, results: [] };
			const force = !!opts.force;
			if (action === "install") {
				for (const t of targets) {
					const r = await hooks.installHook(t, { force });
					out.results.push({ id: t.id, name: t.name, ...r });
				}
			} else if (action === "uninstall") {
				for (const t of targets) {
					const r = await hooks.uninstallHook(t);
					out.results.push({ id: t.id, name: t.name, ...r });
				}
			} else if (action === "status") {
				for (const t of targets) {
					const r = await hooks.statusHook(t);
					out.results.push(r);
				}
			} else {
				fail(
					`Unknown brief-hooks action: ${action}. Use install | uninstall | status.`,
					{
						command: "brief-hooks",
						action,
					},
				);
			}
			out.count = out.results.length;
			emit(out);
			if (!isJson()) {
				if (action === "status") {
					for (const r of out.results) {
						const mark = r.installed ? c.green("✓") : c.gray("·");
						log.raw(
							`  ${mark} ${r.id.padEnd(9)} ${r.state.padEnd(14)} ${c.gray(r.prettyPath || "")}`,
						);
					}
				} else {
					const installed = out.results.filter((r) => r.installed).length;
					const unlinked = out.results.filter((r) => r.unlinked).length;
					const skipped = out.results.filter((r) => r.skipped).length;
					const blocked = out.results.filter((r) => r.blocked).length;
					if (action === "install") {
						log.success(
							`${installed} installed, ${skipped} skipped, ${blocked} blocked (use --force to overwrite)`,
						);
					} else if (action === "uninstall") {
						log.success(`${unlinked} removed, ${skipped} skipped`);
					}
				}
			}
		});
}
