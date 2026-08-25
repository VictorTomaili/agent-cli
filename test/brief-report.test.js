// Tests for src/brief-report.js#buildBriefPayload — the P1/F1 content-hash
// staleness signal. Sets an isolated AGENT_CLI_HOME (dynamic import so the
// util.js AGENTS_DIR freezes against the fixture), seeds the live dev-team tree
// from the bundled seed, mutates SKILL.md, and asserts the payload carries the
// drift warning line AND the divergent filename.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-brief-"));
process.env.AGENT_CLI_HOME = TMP;

const seed = await import("../src/seed.js");
const { buildBriefPayload } = await import("../src/brief-report.js");

/** Seed the live dev-team tree from the bundled seed (identical content → clean). */
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

/** A valid (if minimal) collected-state object buildBriefPayload accepts. */
function minState() {
	return {
		masterContent: "# AGENTS.md\n",
		archetypeNeeded: false,
		unresolvedModels: [],
		drift: [],
		pointerTargets: [],
		consG: { score: 0, recommend: false, reasons: [], metrics: {} },
		consP: { score: 0, recommend: false, reasons: [], metrics: {} },
		upd: { latest: null, upToDate: true, checkedAt: null, refreshed: false },
		stagedUpdates: [],
		inboxCount: 0,
		liveCatalogAge: null,
		cfg: { global: [] },
		installed: [],
		onboarding: {},
		sessionLoad: {},
		session: null,
		lessonsIndex: [],
		coreContent: null,
		coreScope: null,
		spect: null,
		spectHeadline: null,
	};
}

test("brief payload is clean when the live dev-team tree matches the seed", () => {
	seedLiveDevTeam();
	const p = buildBriefPayload(minState(), { version: "0.0.0" });
	assert.equal(p.liveDrift.drift, false);
	assert.equal(p.liveDrift.count, 0);
	assert.deepEqual(p.liveDrift.files, []);
	assert.equal(p.liveDrift.message, null);
	assert.ok(!p.warnings.some((w) => w.includes("dev-team")));
});

test("brief payload carries the drift warning + divergent filename when SKILL.md differs", () => {
	seedLiveDevTeam();
	writeFileSync(
		path.join(TMP, ".agents", "skills", "dev-team", "SKILL.md"),
		"# dev-team skill\n\n## Role\nLOCAL OVERRIDE\n",
	);
	const p = buildBriefPayload(minState(), { version: "0.0.0" });
	assert.equal(p.liveDrift.drift, true);
	assert.equal(p.liveDrift.count, 1);
	assert.deepEqual(p.liveDrift.files, ["skills/dev-team/SKILL.md"]);
	assert.match(
		p.liveDrift.message,
		/dev-team: live ~\/\.agents\/skills\/dev-team differs from seed \(1 files\) - run agent-cli upgrade/,
	);
	assert.ok(p.warnings.includes(p.liveDrift.message));
});
