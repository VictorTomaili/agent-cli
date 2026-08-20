// src/commands/memory-stack.js — memory + session + secret + env, extracted
// from cli.js (HIGH-3). Injected deps: { emit, fail, log, c, pretty, EXIT, isJson }.

/** Register the memory-stack commands (memory, session, secret, env). */
export function registerMemoryStackCommands(
	program,
	{ emit, fail, log, c, pretty, EXIT, isJson },
) {
	program
		.command("memory <action>")
		.description(
			"Memory loop: check (honor consolidate.prompt) | maintain (snapshot→triage→consolidate).",
		)
		.option("--apply", "(check) run consolidate when prompt=auto and recommended")
		.option("-p, --project", "project scope")
		.action(async (action, opts) => {
			const memMod = await import("../memory.js");
			const scope = opts.project ? "project" : "global";
			if (action === "check") {
				const r = await memMod.memoryCheck({ scope });
				if (opts.apply && r.action === "consolidate") {
					const conMod = await import("../consolidate.js");
					const applied = conMod.consolidate({ scope });
					r.applied = applied.ok ? applied.stats : null;
				}
				emit({ command: "memory", action: "check", ...r });
				if (!isJson())
					log.raw(
						`prompt=${r.prompt} → action=${r.action} (score ${r.consolidate.score}, recommend ${r.consolidate.recommend})`,
					);
				return;
			}
			if (action === "maintain") {
				const r = await memMod.memoryMaintain({ scope: opts.project ? "project" : "all" });
				emit({ command: "memory", action: "maintain", ...r });
				if (!isJson())
					log.success(
						`Snapshot ${r.snapshot} · ${r.inbox} inbox · ${r.consolidated.length} scope(s) consolidated.`,
					);
				return;
			}
			fail(`Unknown memory action: ${action}. Use check|maintain`, { command: "memory", action });
		});

	program
		.command("session <action> [task...]")
		.description(
			"Session lifecycle: start [task] | end | report (lesson candidate).",
		)
		.option(
			"--if-active",
			"(end) exit 0 with a no-op result when no session is active — for SessionEnd hooks",
		)
		.action(async (action, task, opts) => {
			const sess = await import("../session.js");
			if (action === "start") {
				const r = await sess.sessionStart({ task: task ? task.join(" ") : null, cwd: process.cwd() });
				emit({ command: "session", action, ...r });
				if (!isJson()) {
					if (!r.ok) {
						log.error(r.reason);
						process.exit(EXIT.ERROR);
					}
					log.success(`Session started (${r.session.startedAt}).`);
				}
				if (!r.ok) process.exit(EXIT.ERROR);
				return;
			}
			if (action === "end") {
				const r = await sess.sessionEnd();
				if (!r.ok && opts && opts.ifActive) {
					// Hook mode: a host SessionEnd hook fires even when no session
					// was ever started (headless runs, sessions that only ran
					// `brief`). No active session is a normal no-op there, not an error.
					emit({ command: "session", action, ok: true, noop: true, noActiveSession: true });
					if (!isJson()) log.dim("No active session — nothing to end.");
					return;
				}
				emit({ command: "session", action, ...r });
				if (!isJson()) {
					if (!r.ok) {
						log.error(r.reason);
						process.exit(EXIT.ERROR);
					}
					log.success(`Session ended (${Math.round(r.durationMs / 1000)}s).`);
					log.dim(r.lesson.suggestion);
				}
				if (!r.ok) process.exit(EXIT.ERROR);
				return;
			}
			if (action === "report") {
				const r = await sess.sessionReport();
				emit({ command: "session", action, ...r });
				if (!isJson()) {
					if (!r.ok) {
						log.error(r.reason);
						process.exit(EXIT.ERROR);
					}
					log.raw(`task: ${r.session.task ?? "(none)"}`);
					log.dim(r.lesson.suggestion);
				}
				if (!r.ok) process.exit(EXIT.ERROR);
				return;
			}
			fail(`Unknown session action: ${action}. Use start|end|report`, { command: "session", action });
		});

	program
		.command("secret <action> [name] [value...]")
		.description(
			"Machine-local encrypted secrets: set|get|list|rm|env. Never synced or surfaced.",
		)
		.option("-p, --project", "project scope")
		.action(async (action, name, value, opts) => {
			const sec = await import("../secrets.js");
			const scope = opts.project ? "project" : "global";
			if (action === "set") {
				if (!name || !value.length) fail("Usage: agent-cli secret set <name> <value>");
				const r = sec.setSecret(name, value.join(" "), { scope });
				emit({ command: "secret", action, ...r });
				if (!isJson()) log.success(`Secret '${name}' stored (${scope}).`);
				return;
			}
			if (action === "get") {
				if (!name) fail("Usage: agent-cli secret get <name>");
				try {
					const v = sec.getSecret(name, { scope });
					emit({ command: "secret", action, name, value: v });
					if (!isJson()) process.stdout.write(v + "\n");
				} catch (e) {
					fail(e.message, { command: "secret", action, name });
				}
				return;
			}
			if (action === "list") {
				const names = sec.listSecretNames({ scope });
				emit({ command: "secret", action, scope, names, count: names.length });
				if (!isJson()) {
					if (!names.length) log.info("No secrets.");
					for (const n of names) log.raw(`  ${n}`);
				}
				return;
			}
			if (action === "rm") {
				if (!name) fail("Usage: agent-cli secret rm <name>");
				const r = sec.rmSecret(name, { scope });
				emit({ command: "secret", action, ...r });
				if (!isJson())
					log.success(r.existed ? `Removed '${name}'.` : `No such secret '${name}'.`);
				return;
			}
			if (action === "env") {
				const env = sec.secretEnv({ scope });
				emit({ command: "secret", action, scope, env, count: env.length });
				if (!isJson()) for (const l of env) process.stdout.write(l + "\n");
				return;
			}
			fail(
				`Unknown secret action: ${action}. Use set|get|list|rm|env`,
				{ command: "secret", action },
			);
		});

	program
		.command("env <action> [rest...]")
		.description("Environment: capture (detect + fill ENVIRONMENTS.md) | set <Field> <value>.")
		.option("-p, --project", "project scope")
		.action(async (action, rest, opts) => {
			if (action === "set") {
				const field = rest?.[0];
				const value = (rest?.slice(1) || []).join(" ");
				if (!field || !value) fail("Usage: agent-cli env set <Field> <value>");
				const envc = await import("../env-capture.js");
				const r = await envc.setEnvironmentField(field, value, {
					scope: opts.project ? "project" : "global",
					cwd: process.cwd(),
				});
				emit({ command: "env", action: "set", ...r });
				if (!isJson()) {
					if (!r.ok) {
						log.error(r.reason);
						process.exit(EXIT.ERROR);
					}
					log.success(`ENVIRONMENTS.md: ${r.field}: ${r.value}`);
					if (r.warning) log.warn(r.warning);
				}
				if (!r.ok) process.exit(EXIT.ERROR);
				return;
			}
			if (action !== "capture")
				fail(`Unknown env action: ${action}. Use capture|set`, { command: "env", action });
			const envc = await import("../env-capture.js");
			const r = await envc.captureAndApply({
				scope: opts.project ? "project" : "global",
				cwd: process.cwd(),
			});
			emit({ command: "env", action: "capture", ...r });
			if (!isJson()) {
				if (!r.ok) {
					log.error(r.reason);
					process.exit(EXIT.ERROR);
				}
				log.success(
					`ENVIRONMENTS.md: filled ${r.filled} field(s) → ${pretty(r.file)}`,
				);
				if (r.sshAliases.length) log.kv("ssh aliases", r.sshAliases.join(", "));
			}
			if (!r.ok) process.exit(EXIT.ERROR);
		});
}
