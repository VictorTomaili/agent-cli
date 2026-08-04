import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
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

test("shipped seed dir contains the 4 default personalities", async () => {
	const rels = (await seed.listSeedFiles()).map((f) => f.rel).sort();
	assert.deepEqual(rels, [
		"agents/planner.md",
		"agents/reviewer.md",
		"agents/scout.md",
		"agents/worker.md",
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
	const r = await seed.stageSeeds({ home, seedDir, version: "0.2.0" });
	assert.equal(r.version, "0.2.0");
	assert.ok(r.staged.includes("agents/scout.md"));
	assert.ok(existsSync(path.join(home, "update-0.2.0", "agents", "scout.md")));
	// real file untouched
	assert.equal(
		readFileSync(path.join(home, "agents", "scout.md"), "utf8"),
		"USER OWNED\n",
	);
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
