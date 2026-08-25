// src/commands/ledger.js — session dispatch ledger (P7).
// Injected deps: { emit, fail, log, c, pretty, isJson }.
// Thin: parse the action + options, call the lib, format.
//
// `start` / `record` / `end` are the WRITE surface. They exist because the
// dev-team protocol's orchestrator is an LLM reading markdown: its only way
// into this module is `agent-cli ...` over Bash, so the in-process
// recordDispatch/startDispatch API was unreachable and nothing ever wrote a
// ledger line — leaving P6's eval harness reading an empty file.
// `show` / `clear` / `--handoff <taskId>` are the read side.
//
// One line per FINISHED dispatch, not one per state change: summarizeSession
// counts `runs` per line (src/team-eval.js), so a started+terminal pair would
// double every per-role count and halve the success rate.

import fs from "node:fs";

const STATUSES = ["started", "succeeded", "failed", "cancelled"];
const ACTIONS = ["show", "clear", "start", "record", "end"];

/** Register the `ledger` command. */
export function registerLedgerCommands(
	program,
	{ emit, fail, log, c, pretty, isJson },
) {
	program
		.command("ledger [action]")
		.description(
			"Session dispatch ledger (~/.agents/.logs/<session>.dispatch.log): start|record|end to write, show|clear to read.",
		)
		.option("--show", "print the current session's dispatch ledger (default)")
		.option("--clear", "truncate the current session's dispatch ledger")
		.option(
			"--handoff <taskId>",
			"assemble and print the per-task handoff artifact for <taskId> (P8)",
		)
		.option(
			"--session <id>",
			"act on this session id instead of the pinned/current one",
		)
		.option("--role <role>", "(record) the role slot the dispatch went to")
		.option("--task <id>", "(record) the task id, as used in the task DAG")
		.option("--model <model>", "(record) the model/alias the dispatch ran on")
		.option(
			"--status <status>",
			`(record) one of: ${STATUSES.join(" | ")} — record the TERMINAL status, one line per finished dispatch`,
		)
		.option("--ms <n>", "(record) elapsed milliseconds, when the host measured it")
		.option("--note <text>", "(record) note kept on the entry; JSON is read for {\"dependsOn\":[...]}")
		.action(async (action, opts = {}) => {
			if (action && !ACTIONS.includes(action)) {
				fail(`Unknown ledger action: ${action}. Use ${ACTIONS.join(", ")}.`, {
					command: "ledger",
					action,
				});
			}

			if (action === "start") {
				const { startSession } = await import("../dispatch-ledger.js");
				const res = startSession(opts.session);
				emit({
					command: "ledger",
					op: "start",
					session: res.session,
					path: pretty(res.path),
					pinned: res.pinned,
					ok: true,
				});
				if (!isJson()) {
					log.raw(`${c.green("✓")} session ${c.bold(res.session)}`);
					log.raw(c.gray(`  ${pretty(res.path)}`));
					if (!res.pinned)
						log.warn(
							"could not pin the session — later processes will not share this ledger",
						);
				}
				return;
			}

			if (action === "end") {
				const { endSession } = await import("../dispatch-ledger.js");
				const res = endSession();
				emit({
					command: "ledger",
					op: "end",
					session: res.session,
					cleared: res.cleared,
					ok: res.ok,
				});
				if (!isJson())
					log.raw(
						res.cleared
							? `${c.green("✓")} unpinned ${c.bold(res.session)}`
							: c.gray("· no pinned session"),
					);
				return;
			}

			if (action === "record") {
				const { recordDispatch } = await import("../dispatch-ledger.js");
				if (!opts.role || !opts.task) {
					fail(
						"ledger record requires --role and --task. Usage: agent-cli ledger record --role <role> --task <id> --status <status> [--model <model>] [--ms <n>] [--note <text>]",
						{ command: "ledger", op: "record" },
					);
				}
				// Reject an out-of-enum status here rather than letting the lib
				// coerce it to `failed` — silently turning a typo into a failed
				// dispatch would corrupt the very KPI this exists to measure.
				if (opts.status && !STATUSES.includes(opts.status)) {
					fail(
						`Unknown status: ${opts.status}. Use ${STATUSES.join(" | ")}.`,
						{ command: "ledger", op: "record", status: opts.status },
					);
				}
				let ms = 0;
				if (opts.ms != null) {
					ms = Number(opts.ms);
					if (!Number.isFinite(ms) || ms < 0)
						fail(`--ms must be a non-negative number, got: ${opts.ms}`, {
							command: "ledger",
							op: "record",
						});
				}
				const entry = recordDispatch({
					role: opts.role,
					task: opts.task,
					model: opts.model,
					status: opts.status ?? "succeeded",
					note: opts.note,
					ms,
					session: opts.session,
				});
				emit({
					command: "ledger",
					op: "record",
					session: entry.session,
					entry,
					ok: true,
				});
				if (!isJson())
					log.raw(
						`${c.green("✓")} ${c.bold(entry.role)} ${c.gray(entry.status)} ${entry.model} ${c.gray(entry.ms + "ms")} — ${entry.task}`,
					);
				return;
			}

			if (opts.handoff) {
				const { attachContextForTask } = await import("../handoff.js");
				const res = attachContextForTask({
					taskId: opts.handoff,
					session: opts.session,
				});
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

			if (show && clear) {
				fail("Use --show or --clear, not both.", { command: "ledger" });
			}

			if (clear) {
				const { clearLedger } = await import("../dispatch-ledger.js");
				const res = clearLedger({ session: opts.session });
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
			const res = readLedger({ session: opts.session });
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
