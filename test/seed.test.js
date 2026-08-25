import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	symlinkSync,
	readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const seed = await import("../src/seed.js");

function makeSeedDir() {
	const dir = mkdtempSync(path.join(tmpdir(), "agent-seed-src-"));
	mkdirSync(path.join(dir, "agents"), { recursive: true });
	writeFileSync(
		path.join(dir, "agents", "scout.md"),
		"---\nname: scout\n---\n## Role\nx\n",
	);
	writeFileSync(
		path.join(dir, "agents", "planner.md"),
		"---\nname: planner\n---\n## Role\nx\n",
	);
	return dir;
}

test("shipped seed dir contains the dev-team roster + skill", async () => {
	const rels = (await seed.listSeedFiles()).map((f) => f.rel).sort();
	assert.deepEqual(rels, [
		"agents/ai-ml-engineer.md",
		"agents/backend-dev.md",
		"agents/business-analyst.md",
		"agents/devops-engineer.md",
		"agents/frontend-dev.md",
		"agents/fullstack-dev.md",
		"agents/orchestrator-agent.md",
		"agents/product-manager.md",
		"agents/product-owner.md",
		"agents/project-manager.md",
		"agents/qa-engineer.md",
		"agents/scrum-master.md",
		"agents/software-architect.md",
		"agents/tech-lead.md",
		"agents/ux-ui-designer.md",
		"skills/dev-team/ROLES.md",
		"skills/dev-team/SKILL.md",
		"skills/dev-team/WORKFLOW.md",
	]);
});

test("planSeedAction: null→install, bump→stage, same→none", () => {
	assert.equal(seed.planSeedAction(null, "0.2.0").action, "install");
	assert.equal(seed.planSeedAction("0.1.0", "0.2.0").action, "stage");
	assert.equal(seed.planSeedAction("0.2.0", "0.2.0").action, "none");
});

test("installSeeds copies into home, skipping existing files", async () => {
	const seedDir = makeSeedDir();
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-home-"));
	mkdirSync(path.join(home, "agents"), { recursive: true });
	// user already has scout.md — must be preserved (never clobber)
	writeFileSync(path.join(home, "agents", "scout.md"), "USER OWNED\n");
	const r = await seed.installSeeds({ home, seedDir });
	assert.deepEqual(r.installed.sort(), ["agents/planner.md"]);
	assert.deepEqual(r.skipped.sort(), ["agents/scout.md"]);
	assert.equal(
		readFileSync(path.join(home, "agents", "scout.md"), "utf8"),
		"USER OWNED\n",
	);
	assert.ok(existsSync(path.join(home, "agents", "planner.md")));
});

test("installSeeds overwrite=true replaces existing files", async () => {
	const seedDir = makeSeedDir();
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-home2-"));
	await seed.installSeeds({ home, seedDir });
	const r2 = await seed.installSeeds({ home, seedDir, overwrite: true });
	assert.ok(r2.installed.length >= 2);
});

test("stageSeeds writes into update-<version>/ without touching real files", async () => {
	const seedDir = makeSeedDir();
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-home3-"));
	mkdirSync(path.join(home, "agents"), { recursive: true });
	writeFileSync(path.join(home, "agents", "scout.md"), "USER OWNED\n");
	const r = await seed.stageSeeds({
		home,
		seedDir,
		version: "0.2.0",
		previousFiles: ["agents/removed.md"],
	});
	assert.equal(r.version, "0.2.0");
	assert.deepEqual(r.removed, ["agents/removed.md"]);
	assert.ok(r.staged.includes("agents/scout.md"));
	assert.ok(existsSync(path.join(home, "update-0.2.0", "agents", "scout.md")));
	// real file untouched
	assert.equal(
		readFileSync(path.join(home, "agents", "scout.md"), "utf8"),
		"USER OWNED\n",
	);
});

test("stageSeeds rejects a pre-existing update-<version> symlink without writing outside", async (t) => {
	const seedDir = makeSeedDir();
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-home-symlink-"));
	const outside = mkdtempSync(path.join(tmpdir(), "agent-seed-outside-symlink-"));
	writeFileSync(path.join(outside, "victim.txt"), "keep me\n");
	const link = path.join(home, "update-0.2.0");
	try {
		symlinkSync(outside, link, "dir");
	} catch (e) {
		if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(e.code)) {
			t.skip(`dir symlink unsupported here: ${e.code}`);
			return;
		}
		throw e;
	}
	// staging must fail cleanly — never write through the link
	await assert.rejects(
		seed.stageSeeds({ home, seedDir, version: "0.2.0" }),
		/symlink|reparse|refus/i,
	);
	// outside target untouched: sentinel intact, no seed files written through
	assert.equal(
		readFileSync(path.join(outside, "victim.txt"), "utf8"),
		"keep me\n",
	);
	assert.deepEqual(readdirSync(outside).sort(), ["victim.txt"]);
	assert.equal(existsSync(path.join(outside, "agents")), false);
	assert.equal(existsSync(path.join(outside, "removed.json")), false);
});

test("stageSeeds rejects a pre-existing update-<version> junction without writing outside", async (t) => {
	if (process.platform !== "win32") {
		t.skip("Windows junctions only exist on Windows");
		return;
	}
	const seedDir = makeSeedDir();
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-home-junction-"));
	const outside = mkdtempSync(path.join(tmpdir(), "agent-seed-outside-junction-"));
	writeFileSync(path.join(outside, "victim.txt"), "keep me\n");
	const link = path.join(home, "update-0.2.0");
	try {
		symlinkSync(outside, link, "junction");
	} catch (e) {
		if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(e.code)) {
			t.skip(`junction unsupported here: ${e.code}`);
			return;
		}
		throw e;
	}
	await assert.rejects(
		seed.stageSeeds({ home, seedDir, version: "0.2.0" }),
		/symlink|reparse|refus/i,
	);
	// outside target untouched: sentinel intact, no seed files written through
	assert.equal(
		readFileSync(path.join(outside, "victim.txt"), "utf8"),
		"keep me\n",
	);
	assert.deepEqual(readdirSync(outside).sort(), ["victim.txt"]);
	assert.equal(existsSync(path.join(outside, "agents")), false);
	assert.equal(existsSync(path.join(outside, "removed.json")), false);
});

test("stageSeeds still reuses a pre-existing regular update-<version> directory", async () => {
	const seedDir = makeSeedDir();
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-home-regulardir-"));
	mkdirSync(path.join(home, "update-0.2.0"), { recursive: true });
	const r = await seed.stageSeeds({ home, seedDir, version: "0.2.0" });
	assert.equal(r.version, "0.2.0");
	assert.ok(existsSync(path.join(home, "update-0.2.0", "agents", "scout.md")));
	assert.ok(existsSync(path.join(home, "update-0.2.0", "removed.json")));
});

test("listStagedUpdates discovers staged payloads (newest last)", async () => {
	const seedDir = makeSeedDir();
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-home4-"));
	await seed.stageSeeds({ home, seedDir, version: "0.2.0" });
	await seed.stageSeeds({ home, seedDir, version: "0.3.0" });
	const list = await seed.listStagedUpdates({ home });
	assert.equal(list.length, 2);
	assert.equal(list[0].version, "0.2.0");
	assert.equal(list[1].version, "0.3.0");
	assert.ok(list[0].files.includes("agents/scout.md"));
	assert.deepEqual(list[0].removed, []);
});

test("readStagedFile returns content or null", async () => {
	const seedDir = makeSeedDir();
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-home5-"));
	await seed.stageSeeds({ home, seedDir, version: "0.2.0" });
	const c = await seed.readStagedFile("0.2.0", "agents/scout.md", { home });
	assert.ok(c && c.includes("name: scout"));
	assert.equal(
		await seed.readStagedFile("9.9.9", "agents/scout.md", { home }),
		null,
	);
});

test("readStagedFile rejects traversal paths", async () => {
	const seedDir = makeSeedDir();
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-home-traversal-"));
	await seed.stageSeeds({ home, seedDir, version: "0.2.0" });
	assert.equal(
		await seed.readStagedFile("0.2.0", "../../../outside", { home }),
		null,
	);
});

test("clearStaged removes a payload and reports not-found for others", async () => {
	const seedDir = makeSeedDir();
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-home6-"));
	await seed.stageSeeds({ home, seedDir, version: "0.2.0" });
	const r = await seed.clearStaged("0.2.0", { home });
	assert.equal(r.ok, true);
	assert.ok(!existsSync(path.join(home, "update-0.2.0")));
	const r2 = await seed.clearStaged("0.2.0", { home });
	assert.equal(r2.ok, false);
});

test("clearStaged rejects traversal versions without touching outside paths", async () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-home-clear-traversal-"));
	const outside = path.join(home, "escape.txt");
	writeFileSync(outside, "keep me\n");
	const r = await seed.clearStaged("../../escape.txt", { home });
	assert.equal(r.ok, false);
	assert.equal(r.reason, "invalid version");
	assert.equal(readFileSync(outside, "utf8"), "keep me\n");
});

test("diffLines marks live-only with '-' and staged-only with '+'", () => {
	const d = seed.diffLines("a\nb\nc", "a\nx\nc");
	const lines = d.split("\n");
	assert.ok(lines.includes("-b"));
	assert.ok(lines.includes("+x"));
	assert.ok(lines.includes(" a"));
	assert.ok(!lines.includes("-a"));
});

test("diffLines: identical content is all context (no +/-)", () => {
	assert.deepEqual(seed.diffLines("x\ny", "x\ny").split("\n"), [" x", " y"]);
});

test("diffLines treats null inputs as empty", () => {
	assert.deepEqual(seed.diffLines(null, "a").split("\n"), ["+a"]);
	assert.deepEqual(seed.diffLines("a", null).split("\n"), ["-a"]);
});

test("applyStaged applies matching files, backs up, refuses diverged, clears when clean", async () => {
	const seedDir = makeSeedDir();
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-apply-"));
	await seed.stageSeeds({ home, seedDir, version: "0.2.0" });
	mkdirSync(path.join(home, "agents"), { recursive: true });
	// clean apply for scout.md; diverge planner.md
	writeFileSync(
		path.join(home, "agents", "scout.md"),
		readFileSync(path.join(home, "update-0.2.0", "agents", "scout.md"), "utf8"),
	);
	writeFileSync(path.join(home, "agents", "planner.md"), "USER EDITED\n");
	const r = await seed.applyStaged("0.2.0", { home });
	assert.equal(r.ok, true);
	assert.ok(r.applied.includes("agents/scout.md"));
	assert.ok(r.backedUp.includes("agents/scout.md"));
	assert.ok(r.skipped.some((s) => s.rel === "agents/planner.md"));
	// divergence → staged payload NOT cleared
	assert.ok(existsSync(path.join(home, "update-0.2.0")));
	// now clear the divergence and apply again → cleared
	writeFileSync(
		path.join(home, "agents", "planner.md"),
		readFileSync(path.join(home, "update-0.2.0", "agents", "planner.md"), "utf8"),
	);
	const r2 = await seed.applyStaged("0.2.0", { home });
	assert.equal(r2.ok, true);
	assert.ok(!existsSync(path.join(home, "update-0.2.0")));
});

test("applyStaged rejects an unknown version", async () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-apply-none-"));
	const r = await seed.applyStaged("9.9.9", { home });
	assert.equal(r.ok, false);
	assert.match(r.reason, /no staged update/);
});

test("GAP-5: a malicious ../ rel cannot escape the home via readStagedFile/applyStaged", async () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-escape-"));
	const outside = mkdtempSync(path.join(tmpdir(), "agent-seed-outside-"));
	// plant a staged payload dir
	const stageDir = path.join(home, "update-0.2.0");
	mkdirSync(path.join(stageDir, "agents"), { recursive: true });
	writeFileSync(path.join(stageDir, "agents", "scout.md"), "# staged\n");
	writeFileSync(path.join(stageDir, "removed.json"), "[]\n");
	// readStagedFile must not resolve a traversal rel (returns null, no read)
	const evil = await seed.readStagedFile("0.2.0", "../../outside/victim.md", { home });
	assert.equal(evil, null);
	// a staged dir that itself escapes (symlinked update dir) is refused by guardStageDir
	const home2 = mkdtempSync(path.join(tmpdir(), "agent-seed-escape2-"));
	symlinkSync(outside, path.join(home2, "update-0.2.0"));
	await assert.rejects(
		() => seed.stageSeeds({ home: home2, version: "0.2.0" }),
		/symlink|escape|outside/i,
	);
	assert.equal(existsSync(path.join(outside, "agents")), false);
});

// --- P1 / F1: content-hash staleness helper -----------------------------------

/** A seed tree with the three dev-team markdown files (skill + workflow + roles). */
function makeDevTeamSeedDir() {
	const dir = mkdtempSync(path.join(tmpdir(), "agent-seed-devteam-"));
	mkdirSync(path.join(dir, "skills", "dev-team"), { recursive: true });
	writeFileSync(
		path.join(dir, "skills", "dev-team", "SKILL.md"),
		"# dev-team skill\n\n## Role\nx\n",
	);
	writeFileSync(
		path.join(dir, "skills", "dev-team", "WORKFLOW.md"),
		"# workflow\n\n1. plan\n",
	);
	writeFileSync(
		path.join(dir, "skills", "dev-team", "ROLES.md"),
		"# roles\n\norchestrator\n",
	);
	return dir;
}

/** The live counterpart: a `home` whose dev-team subtree can be seeded/inspected. */
function makeDevTeamHome({ seedDir }) {
	const home = mkdtempSync(path.join(tmpdir(), "agent-seed-devteam-home-"));
	const live = path.join(home, "skills", "dev-team");
	mkdirSync(live, { recursive: true });
	// seed the live copy straight from the seed (identical content → no drift)
	for (const f of ["SKILL.md", "WORKFLOW.md", "ROLES.md"]) {
		writeFileSync(
			path.join(live, f),
			readFileSync(path.join(seedDir, "skills", "dev-team", f), "utf8"),
		);
	}
	return home;
}

test("contentHashSync: identical content yields the same hash", () => {
	const a = seed.contentHashSync({ root: makeDevTeamSeedDir(), subdir: "skills/dev-team" });
	const b = seed.contentHashSync({ root: makeDevTeamSeedDir(), subdir: "skills/dev-team" });
	// different temp roots, same content → same digest (content-only, not path)
	assert.equal(a.hash, b.hash);
	assert.deepEqual(a.files.sort(), [
		"ROLES.md",
		"SKILL.md",
		"WORKFLOW.md",
	]);
});

test("contentHashSync: a content change changes the hash", () => {
	const dir = makeDevTeamSeedDir();
	const before = seed.contentHashSync({ root: dir, subdir: "skills/dev-team" });
	writeFileSync(
		path.join(dir, "skills", "dev-team", "SKILL.md"),
		"# dev-team skill\n\n## Role\nEDITED\n",
	);
	const after = seed.contentHashSync({ root: dir, subdir: "skills/dev-team" });
	assert.notEqual(before.hash, after.hash);
	// the file set is unchanged — only the content differs
	assert.deepEqual(before.files.sort(), after.files.sort());
});

test("contentHashSync: adding/removing a .md file changes the hash", () => {
	const dir = makeDevTeamSeedDir();
	const before = seed.contentHashSync({ root: dir, subdir: "skills/dev-team" });
	writeFileSync(path.join(dir, "skills", "dev-team", "EXTRA.md"), "# extra\n");
	const after = seed.contentHashSync({ root: dir, subdir: "skills/dev-team" });
	assert.notEqual(before.hash, after.hash);
	assert.ok(after.files.includes("EXTRA.md"));
});

test("contentHashSync: returns null hash + empty files when the tree has no .md files", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "agent-seed-devteam-empty-"));
	const r = seed.contentHashSync({ root: dir, subdir: "skills/dev-team" });
	assert.equal(r.hash, null);
	assert.deepEqual(r.files, []);
});

test("detectDevTeamDrift: no staged payload → live vs seed only (clean when identical)", () => {
	const seedDir = makeDevTeamSeedDir();
	const home = makeDevTeamHome({ seedDir });
	const r = seed.detectDevTeamDrift({ home, seedDir });
	assert.equal(r.drift, false);
	assert.equal(r.count, 0);
	assert.deepEqual(r.files, []);
	assert.equal(r.source, "seed");
	assert.equal(r.message, null);
});

test("detectDevTeamDrift: modified live file flags drift with the divergent filename", () => {
	const seedDir = makeDevTeamSeedDir();
	const home = makeDevTeamHome({ seedDir });
	writeFileSync(
		path.join(home, "skills", "dev-team", "SKILL.md"),
		"# dev-team skill\n\n## Role\nLOCAL OVERRIDE\n",
	);
	const r = seed.detectDevTeamDrift({ home, seedDir });
	assert.equal(r.drift, true);
	assert.equal(r.count, 1);
	assert.deepEqual(r.files, ["skills/dev-team/SKILL.md"]);
	assert.equal(r.source, "seed");
	assert.match(r.message, /dev-team: live ~\/\.agents\/skills\/dev-team differs from seed \(1 files\) - run agent-cli upgrade/);
});

test("detectDevTeamDrift: a staged payload supersedes the bundled seed as the expectation", () => {
	const seedDir = makeDevTeamSeedDir();
	const home = makeDevTeamHome({ seedDir });
	// a NEWER staged payload with different dev-team content, not yet applied
	const stageDir = path.join(home, "update-9.9.9", "skills", "dev-team");
	mkdirSync(stageDir, { recursive: true });
	writeFileSync(path.join(stageDir, "SKILL.md"), "# staged NEWER skill\n");
	writeFileSync(path.join(stageDir, "WORKFLOW.md"), "# staged NEWER workflow\n");
	writeFileSync(path.join(stageDir, "ROLES.md"), "# staged NEWER roles\n");
	// live matches the OLD seed → it lags the staged content → drift
	const r = seed.detectDevTeamDrift({ home, seedDir });
	assert.equal(r.drift, true);
	assert.equal(r.source, "staged");
	assert.equal(r.count, 3);
	assert.deepEqual(r.files.sort(), [
		"skills/dev-team/ROLES.md",
		"skills/dev-team/SKILL.md",
		"skills/dev-team/WORKFLOW.md",
	]);
});
