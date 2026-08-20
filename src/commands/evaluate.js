// src/commands/evaluate.js — compliance scoring (ROADMAP Phase 2). Injected
// deps: { emit, fail, log, c, pretty, isJson, path, AGENTS_DIR, resolveContained }.
// This is the one place scoreSession's I/O lives — src/evaluate.js itself
// stays pure (no fs), per the file's own header comment.

/** Register the `evaluate` command. */
export function registerEvaluateCommands(
	program,
	{ emit, fail, log, c, pretty, isJson, path, AGENTS_DIR, resolveContained },
) {
	const sessionsDir = () => path.join(AGENTS_DIR, "sessions");

	program
		.command("evaluate <action> [name]")
		.description(
			"Compliance scoring: session [name] — did the agent close/report/capture lessons? Emits score + feedback. Defaults to the most recently archived session; --active scores the current unended session; a literal [name] scores a specific archived session file.",
		)
		.option(
			"--active",
			"score the currently active (unended) session instead of an archived one",
		)
		.action(async (action, name, opts) => {
			if (action !== "session") {
				fail(`Unknown evaluate action: ${action}. Use: session`, {
					command: "evaluate",
					action,
				});
			}
			const { scoreSession } = await import("../evaluate.js");
			const sess = await import("../session.js");
			const fsp = await import("node:fs/promises");

			let session;
			let source;
			if (opts.active) {
				session = sess.currentSession();
				source = "active";
				if (!session) {
					fail("No active session — run `agent-cli session start` first.", {
						command: "evaluate",
						action,
					});
				}
			} else if (name) {
				const file = resolveContained(
					sessionsDir(),
					name.endsWith(".json") ? name : `${name}.json`,
				);
				if (!file) {
					fail(`Invalid session name: ${name}`, {
						command: "evaluate",
						action,
						name,
					});
				}
				let raw;
				try {
					raw = await fsp.readFile(file, "utf8");
				} catch {
					fail(`No archived session found: ${pretty(file)}`, {
						command: "evaluate",
						action,
						name,
					});
				}
				try {
					session = JSON.parse(raw);
				} catch {
					fail(`Archived session file is corrupt: ${pretty(file)}`, {
						command: "evaluate",
						action,
						name,
					});
				}
				source = file;
			} else {
				let entries = [];
				try {
					entries = await fsp.readdir(sessionsDir());
				} catch {
					entries = [];
				}
				// Archive filenames are ISO-timestamp-derived (see sessionEnd() in
				// session.js), so a lexical sort is also chronological.
				const files = entries.filter((f) => f.endsWith(".json")).sort();
				if (!files.length) {
					fail(
						"No archived sessions yet — run `agent-cli session start` then `agent-cli session end`.",
						{ command: "evaluate", action },
					);
				}
				const file = path.join(sessionsDir(), files[files.length - 1]);
				try {
					session = JSON.parse(await fsp.readFile(file, "utf8"));
				} catch {
					fail(`Most recent archived session is corrupt: ${pretty(file)}`, {
						command: "evaluate",
						action,
					});
				}
				source = file;
			}

			const result = scoreSession(session);
			emit({
				command: "evaluate",
				action,
				source: opts.active ? source : pretty(source),
				...result,
			});
			if (!isJson()) {
				log.raw(
					`${c.bold("evaluate session")} ${c.gray("(" + (opts.active ? source : pretty(source)) + ")")} — score ${c.bold(String(result.score))}/${result.max}`,
				);
				for (const b of result.breakdown)
					log.raw(
						`  ${b.points === b.max ? c.green("✓") : c.yellow("✗")} ${b.signal}: ${b.points}/${b.max} ${c.gray("(" + b.detail + ")")}`,
					);
				if (result.feedback.length) {
					log.raw(c.bold("Feedback:"));
					for (const f of result.feedback) log.raw(`  • ${f}`);
				} else {
					log.success("All signals met.");
				}
			}
		});
}
