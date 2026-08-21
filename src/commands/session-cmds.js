// src/commands/session-cmds.js — run + action + setup + day-start +
// session-start + project, extracted from cli.js (HIGH-3). Injected deps:
// { emit, fail, log, c, pretty, EXIT, isJson, loadConfig, saveConfig,
//   readMaster, detectInstalled, getTarget, enableGlobal, effectiveProjectIds,
//   hasExplicitProjectTargets, ensureSkillStore, findUnresolvedModels, classify,
//   projectMasterPath, masterPaths, setExpectedCtx, exists, writeFile, path }.
// `run` dispatches tasks to external coding-agent CLIs (src/runners.js);
// brief-action-id invocations keep the legacy behavior (deprecated).

/** Suggested fix for an unhealthy project pointer, by on-disk state. */
function pointerFix(state, id) {
	if (state === "pointer-stale") return `agent-cli link -p -t ${id}`;
	if (state === "native")
		return `agent-cli pull ${id} -p, then agent-cli link -p -t ${id}`;
	return `agent-cli target enable ${id} -p`;
}

/** Register the run/action/setup/day-start/session-start/project commands. */
export function registerSessionCommands(
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
		readMaster,
		detectInstalled,
		getTarget,
		enableGlobal,
		effectiveProjectIds,
		hasExplicitProjectTargets,
		ensureSkillStore,
		findUnresolvedModels,
		classify,
		projectMasterPath,
		masterPaths,
		setExpectedCtx,
		exists,
		writeFile,
		path,
	},
) {
	// ---------------------------------------------------------------------------
	// agent-cli run — dispatch a task to an external coding-agent CLI (with the
	// configured fallback chain). Positionals that all look like brief action
	// ids keep the LEGACY behavior (executing brief actions), deprecated.
	// ---------------------------------------------------------------------------
	const ACTION_ID_RE = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9.:-]*$/;
	program
		.command("run [task...]")
		.description(
			'Dispatch a task to a configured coding-agent CLI (agent-cli run --tool pi "refactor utils"); brief action ids still execute (deprecated — prefer `agent-cli action run <id>`).',
		)
		.option("--tool <id>", "runner tool override (pi | codex)")
		.option("--read-only", "run with a read-only tool/sandbox profile")
		.option("--timeout <seconds>", "per-attempt timeout in seconds (default 600)")
		.option("--safe", "(legacy action mode) only run safeToAutomate actions")
		.action(async (task, opts) => {
			const newOpt =
				opts.tool != null || opts.readOnly === true || opts.timeout != null;
			const looksLikeActionIds =
				task.length > 0 && task.every((t) => ACTION_ID_RE.test(t));
			if (!newOpt && (task.length === 0 || looksLikeActionIds)) {
				// LEGACY: execute brief actions by id (same as `agent-cli action run`).
				if (!isJson())
					log.warn(
						"action ids via `agent-cli run` are deprecated; use `agent-cli action run <id>`",
					);
				const ids = task;
				const actMod = await import("../actions.js");
				const s = await actMod.collectState();
				const all = actMod.buildActions(s);
				const byId = new Map(all.map((a) => [a.id, a]));
				const selected = ids.length
					? ids.map((id) => byId.get(id)).filter(Boolean)
					: all;
				if (ids.length && selected.length !== ids.length) {
					const missing = ids.filter((id) => !byId.has(id));
					fail(
						`Unknown action id${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
						{
							command: "run",
							missing,
						},
					);
				}
				const toRun = opts.safe ? selected.filter((a) => a.safeToAutomate) : selected;
				const res = actMod.applySafe(toRun);
				emit({
					command: "run",
					ids: toRun.map((a) => a.id),
					receipts: res.receipts,
					applied: res.applied,
					skipped: res.skipped,
				});
				if (!isJson())
					for (const r of res.receipts)
						log.raw(
							`  ${r.applied ? c.green("✓") : c.gray("·")} ${r.id}${r.stderr ? c.yellow(" — " + r.stderr) : ""}`,
						);
				// no-op (nothing attempted) and full success both exit 0; a failed action exits 1.
				const attempted = res.receipts.filter((r) => !r.skipped);
				process.exit(attempted.some((r) => !r.applied) ? EXIT.ERROR : EXIT.OK);
			}
			// NEW: dispatch the task text to the configured runner chain.
			const joined = task.join(" ").trim();
			if (!joined)
				fail(
					'Usage: agent-cli run [--tool <id>] [--read-only] [--timeout <seconds>] "<task>"',
					{ command: "run" },
				);
			const runners = await import("../runners.js");
			const seconds = Number(opts.timeout);
			const timeoutMs =
				opts.timeout != null && Number.isFinite(seconds) && seconds > 0
					? seconds * 1000
					: 600000;
			let res;
			try {
				res = runners.runTask({
					task: joined,
					readOnly: opts.readOnly === true,
					toolOverride: opts.tool,
					timeoutMs,
					cwd: process.cwd(),
				});
			} catch (e) {
				fail(e.message, { command: "run", task: joined });
			}
			if (!res.ok) {
				const summary = res.attempts
				.map((a) => `${a.tool}/${a.model}: ${a.kind}`)
				.join("; ");
				fail(`all runners failed (${summary})`, {
					command: "run",
					attempts: res.attempts,
				});
			}
			emit({
				command: "run",
				tool: res.tool,
				provider: res.provider,
				model: res.model,
				output: res.output,
				attempts: res.attempts,
			});
			if (!isJson()) {
				log.success(
					`${res.tool}:${res.provider ? res.provider + "/" : ""}${res.model}`,
				);
				log.raw(res.output);
			}
		});

	program
		.command("action <sub> [id]")
		.description("Action feedback loop: verify <id> (run its verification command).")
		.action(async (sub, id) => {
			if (sub !== "verify")
				fail(`Unknown action sub: ${sub}. Use verify`, {
					command: "action",
					sub,
				});
			if (!id) fail("Usage: agent-cli action verify <action-id>");
			const actMod = await import("../actions.js");
			const s = await actMod.collectState();
			const action = actMod.buildActions(s).find((a) => a.id === id);
			if (!action) fail(`Unknown action id: ${id}`, { command: "action", sub, id });
			const r = actMod.verifyAction(action);
			emit({
				command: "action",
				sub: "verify",
				id,
				verified: r.verified,
				reason: r.reason,
				code: r.code,
				output: r.output,
			});
			if (!isJson())
				log.raw(
					`${r.verified == null ? "No verification command." : r.verified ? "✓ verified" : "✗ not verified"} ${id}`,
				);
			process.exit(r.verified === false ? EXIT.ERROR : EXIT.OK);
		});

	// ---------------------------------------------------------------------------
	// agent-cli completion — ergonomics (config/version moved to src/commands/info.js)
	// ---------------------------------------------------------------------------
	program
		.command("setup")
		.description(
			"One-pass setup: init, detect targets, suggest models, snapshot, and readiness.",
		)
		.action(async () => {
			const steps = {};
			const cfg = await loadConfig();
			// 1. master
			const master = await readMaster();
			if (master == null) {
				const init = await (async () => {
					// reuse the init command's action via direct orchestration below
					const { ensureMaster } = await import("../store.js");
					const m = await ensureMaster();
					if (m.skipped) return { skipped: m.skipped };
					const installed = await detectInstalled();
					for (const id of installed) {
						const t = getTarget(id);
						if (t && t.global) enableGlobal(cfg, id);
					}
					await saveConfig(cfg);
					return { master: m.action, targets: installed };
				})();
				steps.init = init;
			} else {
				steps.init = { existing: true };
			}
			// 2. skill store
			steps.skill = await ensureSkillStore();
			// 3. models suggest
			const unresolved = await findUnresolvedModels();
			steps.models = {
				unresolved: unresolved.map((u) => u.name),
				count: unresolved.length,
			};
			// 4. snapshot
			const { snapshot: snap } = await import("../snapshot.js");
			steps.snapshot = snap().name;
			// 5. readiness
			const doctorMod = await import("../actions.js");
			const s = await doctorMod.collectState({ offline: true });
			steps.readiness = {
				health:
					s.masterContent == null || s.drift.length || s.archetypeNeeded
						? "degraded"
						: "ready",
				actions: doctorMod.buildActions(s).length,
			};
			emit({ command: "setup", steps });
			if (!isJson()) {
				log.success(
					`Setup complete — ${steps.readiness.health}, ${steps.readiness.actions} action(s) pending.`,
				);
				log.kv("models", `${steps.models.count} unresolved`);
				log.dim(
					`Next: agent-cli brief --check · agent-cli models suggest · agent-cli brief --apply-safe`,
				);
			}
		});

	// ---------------------------------------------------------------------------
	// Composite commands: day-start / session-start / stats / archetype / template
	// / project / models lint|usage|test
	// ---------------------------------------------------------------------------
	program
		.command("day-start")
		.description(
			"Session-start composite: effective skills + brief actions in one pass.",
		)
		.option("--offline", "never hit the network")
		.option("--check", "exit 2 when actions exist")
		.action(async (opts) => {
			const sg = await import("../skills-gate.js");
			const actMod = await import("../actions.js");
			const s = await actMod.collectState({ offline: !!opts.offline });
			const actions = actMod.buildActions(s);
			const effectiveSkills = sg.effectiveSkills(process.cwd());
			const health =
				s.masterContent == null || s.drift.length || s.archetypeNeeded
					? "degraded"
					: "ready";
			emit({
				command: "day-start",
				health,
				actions,
				suggestedActions: actMod.suggestedStrings(actions),
				effectiveSkills,
				sessionLoad: s.sessionLoad,
			});
			if (!isJson()) {
				log.raw(
					`${c.bold("day-start")} — ${c.gray(health)} · ${actions.length} action(s) · ${effectiveSkills.length} active skill(s)`,
				);
				for (const a of actions)
					log.raw(`  ${a.id}${a.safeToAutomate ? c.green(" ✓safe") : ""}`);
			}
			if (opts.check) process.exit(actions.length ? EXIT.WORK : EXIT.OK);
		});

	program
		.command("session-start [task...]")
		.description("Start a session and emit the brief actions (session + day-start).")
		.option("--offline", "never hit the network")
		.action(async (task, opts) => {
			const sess = await import("../session.js");
			const sr = await sess.sessionStart({
				task: task ? task.join(" ") : null,
				cwd: process.cwd(),
			});
			const actMod = await import("../actions.js");
			const s = await actMod.collectState({ offline: !!opts.offline });
			const actions = actMod.buildActions(s);
			emit({
				command: "session-start",
				session: sr.session,
				actions,
				suggestedActions: actMod.suggestedStrings(actions),
			});
			if (!isJson())
				log.success(`Session started — ${actions.length} action(s) pending.`);
		});

	program
		.command("project <action>")
		.description(
			"Project tooling: detect (fingerprint) | init (scaffold project .agents) | doctor (pointer health vs global).",
		)
		.option("-p, --project", "scope (default project)")
		.action(async (action) => {
			const cwd = process.cwd();
			const fsp = await import("node:fs/promises");
			if (action === "detect") {
				const out = {
					name: path.basename(cwd),
					git: false,
					packageManager: null,
					files: {},
				};
				try {
					await fsp.access(path.join(cwd, ".git"));
					out.git = true;
				} catch {}
				for (const [k, f] of [
					["package.json", "npm"],
					["pyproject.toml", "poetry"],
					["go.mod", "go"],
					["Cargo.toml", "cargo"],
					["Gemfile", "bundler"],
					["pom.xml", "maven"],
				]) {
					try {
						await fsp.access(path.join(cwd, f));
						out.packageManager =
							out.packageManager ?? k === "package.json" ? "npm" : k;
						out.files[f] = true;
					} catch {}
				}
				emit({ command: "project", action, ...out });
				if (!isJson()) {
					log.kv("name", out.name);
					log.kv("git", out.git ? "yes" : "no");
					log.kv("packageManager", out.packageManager ?? "(none)");
				}
				return;
			}
			if (action === "init") {
				// project master at [cwd]/.agents/AGENTS.md
				const masterPath = projectMasterPath(cwd);
				const created = [];
				const arc = await import("../archetypes.js");
				const files = [
					["AGENTS.md", "# Project agent\n\n> Managed by agent-cli (project scope).\n"],
					["IDENTITY.md", arc.identityContent(arc.DEFAULT_IDENTITY)],
					["SOUL.md", arc.soulContent(arc.DEFAULT_SOUL)],
					["USER.md", arc.userContent()],
					["LESSONS.md", arc.lessonsContent()],
					["ENVIRONMENTS.md", arc.environmentsContent()],
				];
				for (const [name, content] of files) {
					const fp = path.join(path.dirname(masterPath), name);
					if (await exists(fp)) continue;
					await writeFile(fp, content);
					created.push(name);
				}
				emit({ command: "project", action, master: masterPath, created });
				if (!isJson()) {
					log.success(
						`Project .agents scaffolded at ${pretty(path.dirname(masterPath))}`,
					);
					if (created.length) log.dim(`Created: ${created.join(", ")}`);
				}
				return;
			}
			if (action === "doctor") {
				const issues = [];
				const checks = [];
				const masterPath = projectMasterPath(cwd);
				const masterOk = await exists(masterPath);
				checks.push({
					check: "project-master-exists",
					ok: masterOk,
					detail: pretty(masterPath),
				});
				if (!masterOk)
					issues.push("project master missing — run agent-cli project init");
				const cfg = await loadConfig();
				// classify() must compare pointer stubs against the PROJECT master
				// (same contract as link/unlink): without setExpectedCtx, project
				// pointers are diffed against the global master and every healthy
				// one classifies as pointer-stale.
				const { masterAbs, masterTilde } = masterPaths("project", cwd);
				setExpectedCtx({ masterAbs, masterTilde });
				// An explicit per-root allowlist (materialized by `target disable
				// <id> -p`, or legacy cfg.project) expresses per-tool intent: a
				// native/missing pointer there is actionable drift. No explicit list
				// = the "all project-capable targets" default, where unconfigured
				// targets are OPTIONAL — doctor must not flag tools the project
				// never opted into. A deployed-but-drifted stub (pointer-stale) is
				// actionable either way: something wrote it.
				const explicit = hasExplicitProjectTargets(cfg, cwd);
				const projIds = effectiveProjectIds(cfg);
				let optional = 0;
				for (const id of projIds) {
					const t = getTarget(id);
					if (!t || !t.project) continue;
					const cls = await classify(t, "project");
					const isPointer = cls.state === "pointer";
					const ok =
						isPointer || (!explicit && cls.state !== "pointer-stale");
					let status;
					if (isPointer) status = "ok";
					else if (ok) status = "optional";
					else status = "error";
					checks.push({
						check: `pointer:${id}`,
						ok,
						status,
						detail: cls.state + " " + pretty(cls.path),
					});
						if (!ok) {
							issues.push(
								`${id} project pointer ${
									cls.state === "pointer-stale" ? "stale" : cls.state
								} — ${pointerFix(cls.state, id)}`,
							);
					} else if (!isPointer) {
						optional++;
					}
				}
				emit({
					command: "project",
					action: "doctor",
					issues,
					checks,
					optionalCount: optional,
				});
				if (!isJson()) {
					for (const ck of checks) {
						let mark;
						if (ck.status === "optional") mark = c.gray("·");
						else if (ck.ok) mark = c.green("✓");
						else mark = c.red("✗");
						log.raw(
							`  ${mark} ${ck.check.padEnd(24)} ${c.gray(ck.detail)}`,
						);
					}
					if (optional > 0)
						log.dim(
							`${optional} target(s) unconfigured (optional) — agent-cli target enable <id> -p to manage one`,
						);
				}
				if (issues.length) process.exit(EXIT.WORK);
				return;
			}
			fail(`Unknown project action: ${action}. Use detect|init|doctor`, {
				command: "project",
				action,
			});
		});
}
