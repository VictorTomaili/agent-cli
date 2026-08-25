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
		.requiredOption("--session <id>", "session id whose P7 dispatch ledger informs the entry")
		.option("--lane <lane>", "collaboration lane: 'fast' or 'full' (default 'full')")
		.option("--roles <csv>", "comma-separated roles activated (defaults to the ledger summary)")
		.option("--outcome <verdict>", "PASS|PASS-WITH-NOTES|REFUTED|LOW-CONFIDENCE")
		.option("--source <text>", "provenance for the ## Source line (default 'manual')")
		.action(async (opts) => {
			const { recordRetro } = await import("../dev-team-retro.js");
			const { summarizeSession } = await import("../team-eval.js");
			const home = reportHome();
			const summary = summarizeSession({ sessionId: opts.session, home });
			const lesson = readLessonStdin();
			if (!lesson) {
				fail("retro record requires a lesson body on stdin", {
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
					session: opts.session,
				});
			}
			emit({
				command: "retro",
				op: "record",
				file: pretty(file),
				path: file,
				session: opts.session,
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
		.option("--theme <name>", "theme to count (default 'dev-team')")
		.option("--core", "also count dev-team lessons already filed into the main store")
		.action(async (opts) => {
			const { countRetros } = await import("../dev-team-retro.js");
			const count = countRetros({
				home: reportHome(),
				theme: opts.theme || "dev-team",
				since: opts.since,
				includeCore: !!opts.core,
			});
			emit({
				command: "retro",
				op: "count",
				count,
				theme: opts.theme || "dev-team",
				since: opts.since || null,
				includeCore: !!opts.core,
			});
			if (!isJson()) {
				log.raw(`${c.bold(count)} retro entr${count === 1 ? "y" : "ies"}` +
					(opts.since ? c.gray(` since ${opts.since}`) : ""));
			}
		});
}
