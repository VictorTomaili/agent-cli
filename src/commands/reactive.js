// src/commands/reactive.js — serve + watch + hooks + automation, extracted
// from cli.js (HIGH-3). Injected deps: { emit, fail, log, c, pretty, EXIT,
//   isJson, setJson, path }.

/** Register the serve/watch/hooks/automation commands. */
export function registerReactiveCommands(
	program,
	{ emit, fail, log, c, pretty, EXIT, isJson, setJson, path },
) {
	// ---------------------------------------------------------------------------
	// agent run / agent action verify — execute the session contract
	// ---------------------------------------------------------------------------
	program
		.command("serve")
		.description(
			"Run the MCP server over stdio (MCP tools: brief, doctor, search, snapshot, status, spect).",
		)
		.option("--mcp", "explicit: serve MCP (default)")
		.action(async () => {
			const serve = await import("../serve.js");
			// MCP speaks raw JSON-RPC — never emit the envelope here.
			setJson(false);
			await serve.serve();
		});

	program
		.command("watch")
		.description(
			"Watch agent state (~/.agents, .agents, skill.config, .spect) and print change events — long-running, blocks until Ctrl+C; for interactive terminal use, not scripts/agents.",
		)
		.option("--interval <ms>", "poll interval ms (default 1000)")
		.action(async (opts) => {
			const auto = await import("../automation.js");
			const interval = Math.max(
				200,
				parseInt(opts.interval || "1000", 10) || 1000,
			);
			const targets = auto.watchTargets(process.cwd());
			let last = auto.fingerprintAll(targets);
			if (!isJson()) {
				log.raw(
					c.bold("watch") +
						c.gray(
							" — " +
								targets.map((t) => t.type).join(", ") +
								` (poll ${interval}ms). Ctrl+C to stop.`,
						),
				);
			}
			// eslint-disable-next-line no-constant-condition
			while (true) {
				await new Promise((r) => setTimeout(r, interval));
				const now = auto.fingerprintAll(targets);
				const events = auto.diffFingerprints(last, now);
				last = now;
				for (const e of events) {
					if (isJson())
						process.stdout.write(
							JSON.stringify({ type: e.type, path: e.path }) + "\n",
						);
					else log.raw(`  ${c.cyan(e.type.padEnd(7))} ${pretty(e.path)}`);
				}
			}
		});

	program
		.command("hooks <action>")
		.description(
			"Manage git hooks: install | remove | list. Hooks re-point agent files after merge/checkout (unrelated to `brief-hooks`, which manages native SessionStart hooks).",
		)
		.option("--git", "git hooks (default)")
		.option(
			"--with-automation",
			"also run `automation run --event post-merge`",
		)
		.action(async (action, opts) => {
			const auto = await import("../automation.js");
			if (action === "install") {
				let installed;
				try {
					installed = auto.installGitHooks({
						withAutomation: !!opts.withAutomation,
					});
				} catch (e) {
					fail(e.message, { command: "hooks", action });
				}
				emit({ command: "hooks", action, installed });
				if (!isJson()) {
					log.success(`Installed git hooks: ${installed.join(", ")}`);
					log.dim("They run `agent link` after every merge/checkout.");
				}
				return;
			}
			if (action === "remove") {
				const removed = auto.removeGitHooks();
				emit({ command: "hooks", action, removed });
				if (!isJson())
					log.success(`Removed ${removed} agent-managed git hook(s).`);
				return;
			}
			if (action === "list") {
				const fsp = await import("node:fs");
				const autoMod = await import("../automation.js");
				const hooksDir = autoMod.gitHookPath(process.cwd());
				const present = ["post-merge", "post-checkout"].filter((h) =>
					fsp.existsSync(path.join(hooksDir, h)),
				);
				const managed = present.filter((h) => {
					const c = fsp.readFileSync(path.join(hooksDir, h), "utf8");
					return c.includes("Managed by agent-cli");
				});
				emit({ command: "hooks", action, present, managed });
				if (!isJson()) {
					if (!present.length) log.info("No git hooks installed.");
					else
						for (const h of present)
							log.raw(
								`  ${managed.includes(h) ? c.green("✓") : c.gray("·")} ${h}`,
							);
				}
				return;
			}
			fail(`Unknown hooks action: ${action}. Use install|remove|list`, {
				command: "hooks",
				action,
			});
		});

	program
		.command("automation <action> [name]")
		.description(
			"Reactive/scheduled jobs: add | list | remove | run. Jobs live in ~/.agents/automation.json.",
		)
		.option(
			"--event <e>",
			"event name (session-start, day-start, sync, memory, snapshot, post-merge, post-checkout)",
		)
		.option("--command <c>", "shell command to run when the event fires")
		.option("--cwd <dir>", "working directory for the command (default: current)")
		.option("--check", "exit 2 when any job matched/failed (for CI)")
		.action(async (action, name, opts) => {
			const auto = await import("../automation.js");
			if (action === "add") {
				if (!name)
					fail(
						"Usage: agent automation add <name> --event <e> --command <cmd>",
						{ command: "automation", action },
					);
				if (!opts.event)
					fail("--event is required (one of: " + auto.EVENTS.join(", ") + ")", {
						command: "automation",
						action,
					});
				if (!auto.EVENTS.includes(opts.event))
					fail(
						`Unknown event: ${opts.event} (valid: ${auto.EVENTS.join(", ")})`,
						{ command: "automation", action },
					);
				if (!opts.command)
					fail("--command is required", { command: "automation", action });
				let job;
				try {
					job = auto.addJob({
						name,
						event: opts.event,
						command: opts.command,
						cwd: opts.cwd || null,
					});
				} catch (e) {
					fail(e.message, { command: "automation", action });
				}
				emit({ command: "automation", action, job });
				if (!isJson())
					log.success(`Job '${name}' → on ${opts.event} run: ${opts.command}`);
				return;
			}
			if (action === "list") {
				const jobs = auto.readJobs();
				emit({ command: "automation", action, jobs });
				if (!isJson()) {
					if (!jobs.length)
						log.info(
							'No automation jobs. Add one: agent automation add <name> --event session-start --command "…"',
						);
					for (const j of jobs)
						log.raw(
							`  ${c.bold(j.name.padEnd(16))} ${c.cyan(j.event.padEnd(14))} ${c.gray(j.command)}`,
						);
				}
				return;
			}
			if (action === "remove") {
				if (!name)
					fail("Usage: agent automation remove <name>", {
						command: "automation",
						action,
					});
				const removed = auto.removeJob(name);
				emit({ command: "automation", action, name, removed });
				if (!isJson())
					log.success(
						removed ? `Removed job '${name}'.` : `No job named '${name}'.`,
					);
				return;
			}
			if (action === "run") {
				const event = opts.event || "*";
				const results = auto.runJobs({
					event,
					cwd: opts.cwd || process.cwd(),
				});
				const failed = results.filter((r) => r.status !== "ok").length;
				emit({
					command: "automation",
					action,
					event,
					results,
					matched: results.length,
					failed,
				});
				if (!isJson()) {
					if (!results.length)
						log.info(`No jobs match event '${event}'.`);
					for (const r of results)
						log.raw(
							`  ${r.status === "ok" ? c.green("✓") : c.red("✗")} ${c.bold(r.name)} ${c.gray(r.status + (r.code != null ? " (" + r.code + ")" : ""))}`,
						);
				}
				if (opts.check && failed) process.exit(EXIT.WORK);
				return;
			}
			fail(`Unknown automation action: ${action}. Use add|list|remove|run`, {
				command: "automation",
				action,
			});
		});
}
