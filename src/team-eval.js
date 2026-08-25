// src/team-eval.js — team KPI harness (P6, ROADMAP Self-Improvement Loop).
//
// Reads the P7 session dispatch ledger (~/.agents/.logs/<session>.dispatch.log)
// and turns it into the per-run KPIs the dev-team role cards promised on
// Aug-20 (routing accuracy, validation catch rate, delegation ratio) so the
// Self-Improvement Loop gets a number instead of a before/after feeling.
//
// Coarse by design, and honest about what it does NOT measure:
//   - It is an aggregation scaffold, not a scorer. `summarizeSession` reduces
//     a ledger to counts/ratios; the actual *scoring* is `scoreTeamRun` in
//     evaluate.js, which keeps `routingAccuracy` as an explicit `null` until
//     P8/P11 land the expected-role table.
//   - It makes no real LLM calls. `runBenchmark` walks the fixtures under
//     test/fixtures/team-eval/ and emits ledger lines through a tiny
//     in-process simulator, then summarises each — a benchmark scaffold that
//     real benchmarks can be wired into later.
//
// Failures are tolerated, never thrown: a missing ledger yields a zeroed
// summary flagged `noLedger: true`, and a malformed line is skipped and
// counted in `skippedLines` so downstream aggregation never chokes.

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolve the home the ledger lives under. `home` param wins; otherwise the
 *  AGENT_CLI_HOME override (testable), then the real home. */
function resolveHome(home) {
	return home || process.env.AGENT_CLI_HOME || os.homedir();
}

const STATUSES = ["started", "succeeded", "failed", "cancelled"];

function zeroSummary(sessionId, noLedger) {
	return {
		sessionId,
		runs: 0,
		rolesActivated: [],
		dispatchesByRole: {},
		dispatchesByStatus: { started: 0, succeeded: 0, failed: 0, cancelled: 0 },
		msTotal: 0,
		msByRole: {},
		successRate: 0,
		// Future-proof placeholders (P8/P11 fill these; never left undefined).
		retroEntries: 0,
		verifierVerdicts: [],
		noLedger: !!noLedger,
		skippedLines: 0,
	};
}

/**
 * Summarise one session's dispatch ledger into per-role counts, status counts,
 * success rate, and elapsed time. Coarse by design; never throws.
 *
 * @param {object} opts
 * @param {string} opts.sessionId - the session UUID whose ledger to read.
 * @param {string} [opts.home] - home to resolve ~/.agents/.logs from; defaults
 *   to AGENT_CLI_HOME || os.homedir().
 * @returns {object} the summary described in the file header.
 */
export function summarizeSession({ sessionId, home } = {}) {
	const sid = String(sessionId ?? "");
	const base = resolveHome(home);
	const p = path.join(base, ".agents", ".logs", `${sid}.dispatch.log`);

	let content = null;
	if (sid) {
		try {
			content = fs.readFileSync(p, "utf8");
		} catch {
			content = null; // missing/unreadable → zeroed + noLedger
		}
	}

	const summary = zeroSummary(sid, content === null);

	if (content === null) return summary;

	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			summary.skippedLines += 1;
			continue;
		}
		summary.runs += 1;

		const role = String(entry.role ?? "orchestrator");
		summary.dispatchesByRole[role] = (summary.dispatchesByRole[role] ?? 0) + 1;
		if (!summary.rolesActivated.includes(role)) summary.rolesActivated.push(role);

		const status = STATUSES.includes(entry.status) ? entry.status : "failed";
		summary.dispatchesByStatus[status] += 1;

		const ms = Number.isFinite(entry.ms) && entry.ms >= 0 ? Math.round(entry.ms) : 0;
		summary.msTotal += ms;
		summary.msByRole[role] = (summary.msByRole[role] ?? 0) + ms;
	}

	const { succeeded, failed, cancelled } = summary.dispatchesByStatus;
	const terminal = succeeded + failed + cancelled;
	summary.successRate = terminal > 0 ? succeeded / terminal : 0;

	return summary;
}

/** The repo-relative fixtures directory runBenchmark reads. */
function fixturesDir() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, "..", "test", "fixtures", "team-eval");
}

/** Build one ledger line, mirroring dispatch-ledger's buildEntry schema. */
function buildSimulatedLine({ sessionId, role, task, model, status, note, ms }) {
	const entry = {
		ts: new Date().toISOString(),
		session: sessionId,
		role: String(role ?? "orchestrator"),
		task: String(task ?? ""),
		model: String(model && String(model).trim() ? model : "unknown"),
		status: STATUSES.includes(status) ? status : "failed",
		ms: typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0,
	};
	if (note != null && String(note).trim() !== "") entry.note = String(note);
	return JSON.stringify(entry);
}

/**
 * Run the 5-fixture benchmark. Emits each fixture's ledger lines into a temp
 * `~/.agents/.logs` (mkdtempSync unless `home` is given, in which case that
 * home's .logs dir is used) and summarises each with `summarizeSession`. No
 * real LLM calls — a scaffold for real benchmarks to be wired in later.
 *
 * @param {object} opts
 * @param {string} [opts.home] - base home for the temp .logs; defaults to a
 *   fresh mkdtemp dir so the benchmark never touches a real ledger.
 * @returns {Array<object>} one summary per fixture, each augmented with `name`.
 */
export function runBenchmark({ home } = {}) {
	const dir = fixturesDir();
	const base = home || fs.mkdtempSync(path.join(os.tmpdir(), "agent-cli-team-eval-"));
	const logsDir = path.join(base, ".agents", ".logs");
	fs.mkdirSync(logsDir, { recursive: true });

	const files = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort();

	const results = [];
	for (const file of files) {
		let fixture;
		try {
			fixture = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
		} catch {
			continue; // skip an unparseable fixture, never throw
		}
		const name = String(fixture.name || path.basename(file, ".json"));
		const sessionId = crypto.randomUUID();
		const lines = (fixture.dispatches || []).map((d) =>
			buildSimulatedLine({ sessionId, ...d }),
		);
		fs.writeFileSync(
			path.join(logsDir, `${sessionId}.dispatch.log`),
			lines.length ? lines.join("\n") + "\n" : "",
			"utf8",
		);
		const summary = summarizeSession({ sessionId, home: base });
		results.push({ name, ...summary });
	}
	return results;
}
