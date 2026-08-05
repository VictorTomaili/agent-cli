import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	writeFileSync,
	mkdirSync,
	existsSync,
	readFileSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-store-"));
process.env.AGENT_CLI_HOME = TMP;

const store = await import("../src/store.js");
const master = () => path.join(TMP, "AGENTS.md");

test("readMaster is null when the master is absent", async () => {
	assert.equal(await store.readMaster(), null);
});

test("masterPath / masterTilde point under HOME", () => {
	assert.equal(store.masterPath(), master());
	assert.equal(store.masterTilde(), "~/AGENTS.md");
});

test("findSeedSource is null when no candidate exists", async () => {
	assert.equal(await store.findSeedSource(), null);
});

test("findSeedSource ignores a candidate with too little content (<20 chars)", async () => {
	mkdirSync(path.join(TMP, ".claude"), { recursive: true });
	writeFileSync(path.join(TMP, ".claude", "CLAUDE.md"), "short");
	assert.equal(await store.findSeedSource(), null);
});

test("ensureMaster seeds a starter when no master and no candidates", async () => {
	const r = await store.ensureMaster();
	assert.equal(r.action, "starter");
	assert.equal(r.changed, true);
	assert.ok(
		readFileSync(master(), "utf8").includes("## Tool-call mediation"),
	);
});

test("ensureMaster is idempotent on a valid master", async () => {
	const r = await store.ensureMaster();
	assert.equal(r.action, "exists");
});

test("ensureMaster does NOT wipe a too-small/corrupt master", async () => {
	const tiny = "# tiny\n\nno headings here";
	writeFileSync(master(), tiny);
	const r = await store.ensureMaster();
	assert.equal(r.action, "exists");
	assert.equal(r.skipped, "master-too-small");
	assert.equal(readFileSync(master(), "utf8"), tiny); // unchanged
});

test("refreshBlocks skips a too-small master", async () => {
	writeFileSync(master(), "# tiny\n\nno headings");
	const r = await store.refreshBlocks();
	assert.equal(r.changed, false);
	assert.equal(r.reason, "master-too-small-skipped");
});

test("refreshBlocks reports no-master when the master is absent", async () => {
	unlinkSync(master());
	const r = await store.refreshBlocks();
	assert.equal(r.changed, false);
	assert.equal(r.reason, "no-master");
});

test("writeMaster appends a trailing newline", async () => {
	await store.writeMaster("# Title\n\n## Section\nbody");
	assert.ok(readFileSync(master(), "utf8").endsWith("\n"));
});

test("findSeedSource returns the richest existing candidate", async () => {
	mkdirSync(path.join(TMP, ".codex"), { recursive: true });
	writeFileSync(
		path.join(TMP, ".codex", "AGENTS.md"),
		"# Seeded\n\n## Real content here, enough to pass the length gate padding x x x x x\n",
	);
	const found = await store.findSeedSource();
	assert.ok(found);
	assert.equal(found.rel, ".codex/AGENTS.md");
});

test("ensureMaster seeds from the richest candidate when master is absent", async () => {
	unlinkSync(master());
	const r = await store.ensureMaster();
	assert.equal(r.action, "seeded");
	assert.equal(r.seed, ".codex/AGENTS.md");
});
