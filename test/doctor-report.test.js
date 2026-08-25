// Tests for src/doctor-report.js#buildDoctorReport — the P1/F1 dev-team drift
// check (update group). Isolates AGENT_CLI_HOME (dynamic import so util.js
// freezes against the fixture) and seeds a sparse home; asserts only the
// dev-team-drift check, leaving the pre-existing missing-file/identity issues
// to the base report. (P11 alias-name checks live alongside in the P11 commit.)
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-doctor-"));
process.env.AGENT_CLI_HOME = TMP;

const seed = await import("../src/seed.js");
const { buildDoctorReport } = await import("../src/doctor-report.js");

function seedLiveDevTeam() {
	const live = path.join(TMP, ".agents", "skills", "dev-team");
	mkdirSync(live, { recursive: true });
	for (const f of ["SKILL.md", "WORKFLOW.md", "ROLES.md"]) {
		writeFileSync(
			path.join(live, f),
			readFileSync(path.join(seed.SEED_DIR, "skills", "dev-team", f), "utf8"),
		);
	}
	return live;
}

function baseOpts() {
	return {
		masterContent: "# AGENTS.md\n",
		upd: { latest: null, upToDate: true, checkedAt: null },
		version: "0.0.0",
		cwd: process.cwd(),
		installed: [],
	};
}

function checkFor(report, name) {
	return report.checks.find((c) => c.check === name);
}

test("doctor flags dev-team drift when the live skill differs from the seed (P1)", async () => {
	seedLiveDevTeam();
	writeFileSync(
		path.join(TMP, ".agents", "skills", "dev-team", "SKILL.md"),
		"# dev-team skill\n\n## Role\nLOCAL OVERRIDE\n",
	);
	const report = await buildDoctorReport({ global: [] }, baseOpts());
	const c = checkFor(report, "dev-team-drift");
	assert.ok(c, "doctor must emit a dev-team-drift check");
	assert.equal(c.ok, false);
	assert.match(c.detail, /1 file\(s\) diverge/);
	assert.ok(
		report.issues.some((i) => i.includes("dev-team: live ~/.agents/skills/dev-team differs from seed")),
		"doctor issue must carry the drift warning line",
	);
});

test("doctor reports a clean dev-team-drift check when live matches the seed", async () => {
	seedLiveDevTeam();
	const report = await buildDoctorReport({ global: [] }, baseOpts());
	assert.equal(checkFor(report, "dev-team-drift").ok, true);
});
