// Unit tests for the team KPI harness (src/team-eval.js) and the additive
// team scorer (scoreTeamRun in src/evaluate.js). Each test uses an isolated
// AGENT_CLI_HOME / temp home so no real ~/.agents is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { summarizeSession, runBenchmark } from "../src/team-eval.js";
import { scoreTeamRun, scoreSession } from "../src/evaluate.js";

function freshHome() {
	return mkdtempSync(path.join(tmpdir(), "agent-cli-team-eval-"));
}

function writeLedger(home, sessionId, lines) {
	const dir = path.join(home, ".agents", ".logs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, `${sessionId}.dispatch.log`), lines, "utf8");
}

function line({ role, task, model, status, ms, note }) {
	const e = {
		ts: "2026-08-01T00:00:00.000Z",
		session: "sess",
		role,
		task,
		model: model || "unknown",
		status,
		ms,
	};
	if (note) e.note = note;
	return JSON.stringify(e);
}

test("summarizeSession aggregates a real ledger into per-role/status counts", () => {
	const home = freshHome();
	const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	const lines = [
		line({ role: "dev", task: "a", model: "m", status: "succeeded", ms: 100 }),
		line({ role: "dev", task: "b", model: "m", status: "succeeded", ms: 150 }),
		line({ role: "qa", task: "c", model: "m", status: "failed", ms: 50 }),
	].join("\n");
	writeLedger(home, sid, lines + "\n");

	const s = summarizeSession({ sessionId: sid, home });
	assert.equal(s.sessionId, sid);
	assert.equal(s.runs, 3);
	assert.deepEqual(s.rolesActivated.sort(), ["dev", "qa"]);
	assert.deepEqual(s.dispatchesByRole, { dev: 2, qa: 1 });
	assert.deepEqual(s.dispatchesByStatus, {
		started: 0,
		succeeded: 2,
		failed: 1,
		cancelled: 0,
	});
	assert.equal(s.msTotal, 300);
	assert.deepEqual(s.msByRole, { dev: 250, qa: 50 });
	assert.equal(s.successRate, 2 / 3);
	assert.equal(s.retroEntries, 0);
	assert.deepEqual(s.verifierVerdicts, []);
	assert.equal(s.noLedger, false);
	assert.equal(s.skippedLines, 0);
});

test("summarizeSession on a missing ledger returns a zeroed noLedger summary", () => {
	const home = freshHome();
	const s = summarizeSession({ sessionId: "missing-session", home });
	assert.equal(s.noLedger, true);
	assert.equal(s.runs, 0);
	assert.equal(s.successRate, 0);
	assert.deepEqual(s.dispatchesByStatus, {
		started: 0,
		succeeded: 0,
		failed: 0,
		cancelled: 0,
	});
});

test("summarizeSession skips malformed lines and reports skippedLines", () => {
	const home = freshHome();
	const sid = "sess-malformed";
	const good = line({ role: "dev", task: "x", status: "succeeded", ms: 10 });
	writeLedger(home, sid, `${good}\nTHIS IS NOT JSON\n{"role": "qa", "status": "failed", "ms": 20}\nnot json either\n`);
	const s = summarizeSession({ sessionId: sid, home });
	assert.ok(s.skippedLines >= 2, `expected >= 2 skipped, got ${s.skippedLines}`);
	assert.equal(s.runs, 2);
	assert.equal(s.dispatchesByStatus.failed, 1);
});

test("summarizeSession never throws on an unreadable/absent file", () => {
	// A totally absent session id (file never written) must return, not throw.
	const home = freshHome();
	const s = summarizeSession({ sessionId: "", home });
	assert.equal(s.noLedger, true);
});

test("runBenchmark walks all 5 fixtures and returns 5 summaries", () => {
	const results = runBenchmark({ home: freshHome() });
	assert.equal(results.length, 5);
	const byName = Object.fromEntries(results.map((r) => [r.name, r]));
	assert.deepEqual(
		Object.keys(byName).sort(),
		["complex-1", "medium-1", "medium-2", "trivial-1", "trivial-2"],
	);
	// Spot-check the fixture arithmetic against the spec.
	assert.equal(byName["trivial-1"].runs, 1);
	assert.equal(byName["trivial-1"].rolesActivated.length, 1);
	assert.equal(byName["trivial-1"].dispatchesByStatus.succeeded, 1);
	assert.equal(byName["trivial-1"].successRate, 1);

	assert.equal(byName["medium-1"].runs, 5);
	assert.equal(byName["medium-1"].rolesActivated.length, 3);
	assert.equal(byName["medium-1"].dispatchesByStatus.succeeded, 4);
	assert.equal(byName["medium-1"].dispatchesByStatus.failed, 1);
	assert.ok(Math.abs(byName["medium-1"].successRate - 0.8) < 1e-9);

	assert.equal(byName["medium-2"].runs, 8);
	assert.equal(byName["medium-2"].rolesActivated.length, 4);
	assert.equal(byName["medium-2"].dispatchesByStatus.succeeded, 6);
	assert.equal(byName["medium-2"].dispatchesByStatus.failed, 1);
	assert.equal(byName["medium-2"].dispatchesByStatus.cancelled, 1);

	assert.equal(byName["complex-1"].runs, 20);
	assert.equal(byName["complex-1"].rolesActivated.length, 6);
	assert.equal(byName["complex-1"].dispatchesByStatus.succeeded, 17);
	assert.equal(byName["complex-1"].dispatchesByStatus.failed, 2);
	assert.equal(byName["complex-1"].dispatchesByStatus.cancelled, 1);
	assert.ok(Math.abs(byName["complex-1"].successRate - 0.85) < 1e-9);
});

test("scoreTeamRun returns routingAccuracy null and computed ratios when no expected table", () => {
	const summary = {
		runs: 5,
		rolesActivated: ["dev", "qa", "sm"],
		dispatchesByStatus: { started: 0, succeeded: 4, failed: 1, cancelled: 0 },
	};
	const r = scoreTeamRun({ sessionSummary: summary });
	assert.equal(r.routingAccuracy, null);
	assert.equal(r.validationCatchRate, 1 / 5); // failed / total
	assert.equal(r.delegationRatio, 3 / 5); // unique roles / total
	assert.equal(typeof r.comment, "string");
	assert.match(r.comment, /expected-role table/);
});

test("scoreTeamRun treats a zeroed/empty session as 0, not NaN", () => {
	const r = scoreTeamRun({ sessionSummary: { runs: 0, rolesActivated: [] } });
	assert.equal(r.routingAccuracy, null);
	assert.equal(r.validationCatchRate, 0);
	assert.equal(r.delegationRatio, 0);
});

test("scoreTeamRun reports the 1.0 placeholder once an expected-role table exists", () => {
	const summary = {
		runs: 2,
		rolesActivated: ["dev", "qa"],
		dispatchesByStatus: { started: 0, succeeded: 2, failed: 0, cancelled: 0 },
		expectedRoles: { dev: "parser", qa: "gate" },
	};
	const r = scoreTeamRun({ sessionSummary: summary });
	assert.equal(r.routingAccuracy, 1.0);
	assert.equal(r.validationCatchRate, 0);
	assert.equal(r.delegationRatio, 1);
});

test("scoreTeamRun does not disturb the existing scoreSession export", () => {
	// Additive-only guarantee: scoreSession is unchanged and still works.
	const s = scoreSession({ endedAt: "2026-08-01T01:00:00.000Z", reported: true, lessonsCaptured: [{}] });
	assert.equal(s.score, s.max);
});
