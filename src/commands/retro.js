// src/commands/retro.js — dev-team retro persistence surface (P8). Injected deps:
// { emit, fail, log, c, pretty, isJson }. Thin: parse options, read stdin for the
// lesson body, call the lib (src/dev-team-retro.js), format. Mirrors the P7 `ledger`
// command style.

import os from "node:os";
import fs from "node:fs";

function reportHome() {
	return process.env.AGENT_CLI_HOME || os.homedir();
}

/** Read the lesson body from stdin (piped by the caller). Trims trailing whitespace. */
function readLessonStdin() {
	try {
		return fs.readFileSync(0, "utf8").trim();
	} catch {
		return "";
	}
}

/** Register the `retro` command. */
export function registerRetroCommands(
	program,
	{ emit, fail, log, c, pretty, isJson },
) {
	const retro = program
		.command("retro")
		.description("Dev-team retro persistence: record a retro lesson or count them (P8).");

	retro
		.command("record")
		.description(
			"Write one dev-team retro lesson to the lessons-store inbox (stdin is the lesson body).",
		)
		.option(
			"--session <id>",
			"session id whose P7 dispatch ledger informs the entry (default: the pinned/current session)",
		)
		.option("--lesson <text>", "the lesson body, when not piped on stdin")
		.option("--lane <lane>", "collaboration lane: 'fast' or 'full' (default 'full')")
		.option("--roles <csv>", "comma-separated roles activated (defaults to the ledger summary)")
		.option("--outcome <verdict>", "PASS|PASS-WITH-NOTES|REFUTED|LOW-CONFIDENCE")
		.option("--source <text>", "provenance for the ## Source line (default 'manual')")
		.action(async (opts) => {
			const { recordRetro } = await import("../dev-team-retro.js");
			const { summarizeSession } = await import("../team-eval.js");
			const { resolveSession } = await import("../dispatch-ledger.js");
			const home = reportHome();
			// The orchestrator does not know a session id — it pinned one with
			// `ledger start` and never saw it again. Default to that pin rather
			// than demanding the id back.
			const sessionId = resolveSession(opts.session);
			const summary = summarizeSession({ sessionId, home });
			// `--lesson` first: piping a heredoc is a shell-quoting trap for prose
			// that contains backticks or `$`, and the caller here is an LLM.
			const lesson = opts.lesson ? String(opts.lesson).trim() : readLessonStdin();
			if (!lesson) {
				fail("retro record requires a lesson body — pass --lesson <text> or pipe it on stdin", {
					command: "retro",
					op: "record",
				});
			}
			const roles = opts.roles
				? opts.roles.split(",").map((r) => r.trim()).filter(Boolean)
				: undefined;
			const file = recordRetro({
				sessionSummary: summary,
				lane: opts.lane || "full",
				rolesActivated: roles,
				outcome: opts.outcome,
				source: opts.source || "manual",
				lesson,
			});
			if (!file) {
				fail("retro record failed to write the lesson (best-effort)", {
					command: "retro",
					op: "record",
					session: sessionId,
				});
			}
			emit({
				command: "retro",
				op: "record",
				file: pretty(file),
				path: file,
				session: sessionId,
			});
			if (!isJson()) {
				log.raw(`${c.green("✓")} recorded retro → ${pretty(file)}`);
			}
		});

	retro
		.command("count")
		.description(
			"Count dev-team retro entries in the lessons store (the Self-Improvement trigger's 5+ threshold).",
		)
		.option("--since <iso>", "only count entries written at/after this ISO timestamp")
		.option(
			"--since-last-loop",
			"count only entries written since the last `retro mark` (the Self-Improvement trigger)",
		)
		.option("--theme <name>", "theme to count (default 'dev-team')")
		.option("--core", "also count dev-team lessons already filed into the main store")
		.action(async (opts) => {
			const { countRetros, lastLoopRun } = await import("../dev-team-retro.js");
			const home = reportHome();
			// --since-last-loop is opt-in rather than the default: `retro count`
			// keeps meaning "how many retros are there", and the trigger asks the
			// narrower question explicitly.
			const since = opts.sinceLastLoop
				? lastLoopRun({ home }) || undefined
				: opts.since;
			const count = countRetros({
				home,
				since,
				theme: opts.theme || "dev-team",
				includeCore: !!opts.core,
			});
			emit({
				command: "retro",
				op: "count",
				count,
				theme: opts.theme || "dev-team",
				since: since || null,
				sinceLastLoop: !!opts.sinceLastLoop,
				includeCore: !!opts.core,
			});
			if (!isJson()) {
				log.raw(`${c.bold(count)} retro entr${count === 1 ? "y" : "ies"}` +
					(since ? c.gray(` since ${since}`) : ""));
			}
		});

	retro
		.command("mark")
		.description(
			"Stamp 'the Self-Improvement Loop ran now', so `retro count --since-last-loop` counts forward from here.",
		)
		.option("--at <iso>", "stamp this instant instead of now")
		.action(async (opts) => {
			const { markLoopRun } = await import("../dev-team-retro.js");
			const at = markLoopRun({ home: reportHome(), at: opts.at });
			if (!at) {
				fail("retro mark failed to write the watermark (best-effort)", {
					command: "retro",
					op: "mark",
				});
			}
			emit({ command: "retro", op: "mark", lastRunAt: at });
			if (!isJson()) log.raw(`${c.green("✓")} loop watermark ${c.gray(at)}`);
		});
}
