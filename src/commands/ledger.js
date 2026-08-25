// src/commands/ledger.js — session dispatch ledger visibility (P7).
// Injected deps: { emit, fail, log, c, pretty, isJson }.
// Thin: parse --show/--clear (or the show|clear subcommand), call the lib,
// format. The write path (recordDispatch / startDispatch) is the lib API the
// orchestrator's CLI host calls directly; this command is the read/clear view.
// P8 adds `--handoff <taskId>`: assemble + print the per-task handoff artifact.

import fs from "node:fs";

/** Register the `ledger` command. */
export function registerLedgerCommands(
	program,
	{ emit, fail, log, c, pretty, isJson },
) {
	program
		.command("ledger [action]")
		.description(
			"Session dispatch ledger: show or clear the current session's ~/.agents/.logs/<session>.dispatch.log.",
		)
		.option("--show", "print the current session's dispatch ledger (default)")
		.option("--clear", "truncate the current session's dispatch ledger")
		.option(
			"--handoff <taskId>",
			"assemble and print the per-task handoff artifact for <taskId> (P8)",
		)
		.action(async (action, opts = {}) => {
			if (opts.handoff) {
				const { attachContextForTask } = await import("../handoff.js");
				const res = attachContextForTask({ taskId: opts.handoff });
				if (!res.ok) {
					fail(res.reason || `no handoff for ${opts.handoff}`, {
						command: "ledger",
						op: "handoff",
						taskId: opts.handoff,
					});
				}
				const content = res.artifactPath
					? fs.readFileSync(res.artifactPath, "utf8")
					: "";
				emit({
					command: "ledger",
					op: "handoff",
					taskId: opts.handoff,
					artifactPath: res.artifactPath ? pretty(res.artifactPath) : null,
					content,
					ok: true,
				});
				if (!isJson()) {
					if (res.artifactPath)
						log.raw(`${c.bold("handoff")} ${c.gray(pretty(res.artifactPath))}`);
					log.raw(content);
				}
				return;
			}

			const show = opts.show || action === "show" || (!action && !opts.clear);
			const clear = opts.clear || action === "clear";

			if (action && !["show", "clear"].includes(action)) {
				fail(`Unknown ledger action: ${action}. Use show or clear.`, {
					command: "ledger",
					action,
				});
			}
			if (show && clear) {
				fail("Use --show or --clear, not both.", { command: "ledger" });
			}

			if (clear) {
				const { clearLedger } = await import("../dispatch-ledger.js");
				const res = clearLedger();
				emit({
					command: "ledger",
					op: "clear",
					path: res.path ? pretty(res.path) : null,
					cleared: res.cleared,
					ok: res.ok,
				});
				if (!isJson()) {
					if (res.path)
						log.raw(
							`${res.cleared ? c.green("✓") : c.gray("·")} cleared ${pretty(res.path)}`,
						);
					else log.raw(c.gray("· no dispatch ledger to clear"));
				}
				return;
			}

			const { readLedger } = await import("../dispatch-ledger.js");
			const res = readLedger();
			emit({
				command: "ledger",
				op: "show",
				path: res.path ? pretty(res.path) : null,
				count: res.entries.length,
				entries: res.entries,
				ok: res.ok,
			});
			if (!isJson()) {
				if (!res.path || !res.entries.length) {
					log.raw(c.gray("(no dispatch ledger entries)"));
					return;
				}
				for (const e of res.entries) {
					log.raw(
						`${c.bold(e.role)} ${c.gray(e.status)} ${e.model} ${c.gray(e.ms + "ms")} — ${e.task}`,
					);
				}
			}
		});
}
