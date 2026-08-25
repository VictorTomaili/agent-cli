// src/commands/team-eval.js — team KPI harness surface (P6). Injected deps:
// { emit, log, c, isJson }. Thin: parse --home/--session, call the lib
// (src/team-eval.js), format the summary table. Mirrors the `ledger` command
// P7 registered.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Most-recent .dispatch.log under <home>/.agents/.logs (or null) — so a
 *  `report` without --session can reach the ledger a prior writing process left
 *  behind (the CLI process carries its own fresh session id). */
function latestLedgerPath(home) {
	const dir = path.join(home, ".agents", ".logs");
	let entries;
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return null;
	}
	let best = null;
	let bestM = -1;
	for (const name of entries) {
		if (!name.endsWith(".dispatch.log")) continue;
		const full = path.join(dir, name);
		try {
			const m = fs.statSync(full).mtimeMs;
			if (m > bestM) {
				bestM = m;
				best = full;
			}
		} catch {
			/* raced away — skip */
		}
	}
	return best;
}

function reportHome() {
	return process.env.AGENT_CLI_HOME || os.homedir();
}

/** Format a 0..1 fraction as a percentage string (e.g. 0.85 → "85.0%"). */
function pct(x) {
	return `${(x * 100).toFixed(1)}%`;
}

function renderTable(results, { c, log }) {
	const rows = results.map((r) => ({
		name: r.name,
		runs: String(r.runs),
		roles: String(r.rolesActivated.length),
		success: pct(r.successRate),
		msTotal: String(r.msTotal),
		msPerRun: r.runs > 0 ? (r.msTotal / r.runs).toFixed(1) : "-",
	}));
	const headers = ["fixture", "runs", "roles", "success", "msTotal", "ms/runs"];
	// Column width = max(header label, widest value) so header and rows line up.
	const widths = headers.map((h) => h.length);
	for (const row of rows) {
		const cells = [
			row.name,
			row.runs,
			row.roles,
			row.success,
			row.msTotal,
			row.msPerRun,
		];
		cells.forEach((v, i) => {
			widths[i] = Math.max(widths[i], String(v).length);
		});
	}
	const pad = (i) => (i < headers.length - 1 ? widths[i] + 2 : widths[i]);
	const formatRow = (cells) =>
		cells
			.map((v, i) => String(v).padEnd(pad(i)))
			.join("")
			.trimEnd();
	log.raw(c.bold(formatRow(headers)));
	for (const row of rows) {
		log.raw(
			formatRow([
				row.name,
				row.runs,
				row.roles,
				row.success,
				row.msTotal,
				row.msPerRun,
			]),
		);
	}
}

function renderReport(summary, { c, log }) {
	log.raw(
		`${c.bold("team eval report")} ${summary.noLedger ? c.gray("(no dispatch ledger)") : c.gray(summary.sessionId)}`,
	);
	if (summary.noLedger) {
		log.raw(c.gray("· no dispatch ledger recorded for this session — run some dispatches first."));
		return;
	}
	log.kv("runs", String(summary.runs));
	log.kv("roles", summary.rolesActivated.join(", ") || "-");
	log.raw(
		`  ${c.gray("by role")}  ${Object.entries(summary.dispatchesByRole)
			.map(([r, n]) => `${r}=${n}`)
			.join(", ") || "-"}`,
	);
	const st = summary.dispatchesByStatus;
	log.raw(
		`  ${c.gray("by status")}  started=${st.started} succeeded=${st.succeeded} failed=${st.failed} cancelled=${st.cancelled}`,
	);
	log.kv("total ms", String(summary.msTotal));
	log.kv("success rate", pct(summary.successRate));
	log.kv("retro entries", String(summary.retroEntries));
	log.kv("verifier verdicts", String(summary.verifierVerdicts.length));
	if (summary.skippedLines > 0) log.warn(`${summary.skippedLines} malformed line(s) skipped`);
}

/** Register the `team eval` command. */
export function registerTeamEvalCommands(
	program,
	{ emit, log, c, isJson },
) {
	const team = program
		.command("team")
		.description("Team harness: the P6 team-KPI eval surface.");

	const evalCmd = team
		.command("eval")
		.description("Team KPI eval: run the benchmark or report a session.");

	evalCmd
		.command("run")
		.description(
			"Run the 5-fixture team benchmark under test/fixtures/team-eval/ and print a summary table (no real LLM calls — scaffold).",
		)
		.option("--home <path>", "base home for the temp .logs; defaults to a fresh temp dir")
		.action(async (opts) => {
			const { runBenchmark } = await import("../team-eval.js");
			const results = runBenchmark({ home: opts.home });
			emit({
				command: "team",
				action: "eval",
				op: "run",
				count: results.length,
				results,
			});
			if (!isJson()) {
				renderTable(results, { c, log });
			}
		});

	evalCmd
		.command("report")
		.description(
			"Summarise the current (or --session <id>) session's dispatch ledger into team KPIs.",
		)
		.option("--session <id>", "a specific session id; defaults to the most recent ledger")
		.action(async (opts) => {
			const { summarizeSession } = await import("../team-eval.js");
			const home = reportHome();
			let summary;
			if (opts.session) {
				summary = summarizeSession({ sessionId: opts.session, home });
			} else {
				const latest = latestLedgerPath(home);
				const sessionId = latest
					? path.basename(latest).replace(/\.dispatch\.log$/, "")
					: "";
				summary = summarizeSession({ sessionId, home });
			}
			emit({
				command: "team",
				action: "eval",
				op: "report",
				session: summary.sessionId,
				...summary,
			});
			if (!isJson()) renderReport(summary, { c, log });
		});
}
