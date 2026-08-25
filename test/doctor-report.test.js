// Tests for src/doctor-report.js#buildDoctorReport — the P1/F1 dev-team drift
// check (update group) and the P11/F10 invalid-alias-name check. Isolates
// AGENT_CLI_HOME (dynamic import so util.js freezes against the fixture) and
// seeds a sparse home; asserts only the checks under test, leaving the
// pre-existing missing-file/identity issues to the base report.
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

test("doctor flags an alias key that fails the safe pattern (P11)", async () => {
	seedLiveDevTeam();
	const cfg = {
		global: [],
		models: {
			aliases: {
				"smart-model <!-- foo -->": { model: "openai/gpt", category: "smart" },
				"good-model": { model: "openai/gpt", category: "coding" },
			},
		},
	};
	const report = await buildDoctorReport(cfg, baseOpts());
	const c = checkFor(report, "model-alias-names");
	assert.ok(c, "doctor must emit a model-alias-names check");
	assert.equal(c.ok, false);
	assert.match(c.detail, /invalid alias name/);
	assert.ok(
		report.issues.some((i) => i.includes("smart-model <!-- foo -->")),
		"doctor issue must name the polluted alias",
	);
});

test("doctor reports a clean model-alias-names check when every key is valid", async () => {
	seedLiveDevTeam();
	const cfg = {
		global: [],
		models: { aliases: { "good-model": { model: "openai/gpt" } } },
	};
	const report = await buildDoctorReport(cfg, baseOpts());
	assert.equal(checkFor(report, "model-alias-names").ok, true);
});

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

