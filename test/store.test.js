import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	writeFileSync,
	mkdirSync,
	existsSync,
	readFileSync,
	unlinkSync,
	rmSync,
	readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-store-"));
process.env.AGENT_CLI_HOME = TMP;
mkdirSync(path.join(TMP, ".agents"), { recursive: true });

const store = await import("../src/store.js");
const master = () => path.join(TMP, ".agents", "AGENTS.md");
const homePointer = () => path.join(TMP, "AGENTS.md");

test("readMaster is null when the master is absent", async () => {
	assert.equal(await store.readMaster(), null);
});

test("masterPath / masterTilde point under ~/.agents", () => {
	assert.equal(store.masterPath(), master());
	assert.equal(store.masterTilde(), "~/.agents/AGENTS.md");
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

// ---------------------------------------------------------------------------
// Layout migration — old (~/AGENTS.md master + ~/.agents/AGENTS.md self-pointer
// stub) → new (~/.agents/AGENTS.md master + ~/AGENTS.md home pointer stub)
// ---------------------------------------------------------------------------

/** A hand-written pre-flip self-pointer stub at ~/.agents/AGENTS.md. */
const OLD_SELF_POINTER = [
	"<!-- agent-cli-pointer -->",
	"<!-- target: agent-cli-master-pointer -->",
	"<!-- scope: agent-cli -->",
	"<!-- native: AGENTS.md -->",
	`<!-- master-abs: ${path.join(TMP, "AGENTS.md")} -->`,
	"<!-- master-tilde: ~/AGENTS.md -->",
	"",
	"# AGENTS.md (agent-cli's local copy) → redirected by agent-cli",
	"",
	"This file is a **pointer stub**. Read the master instead.",
].join("\n");

const REAL_MASTER = (marker) =>
	`# ${marker}\n\n## Real user content\n\n` +
	"padding padding padding padding padding padding padding padding padding padding\n";

function resetLayout() {
	rmSync(master(), { force: true });
	rmSync(homePointer(), { force: true });
	rmSync(path.join(TMP, ".agents", "backups"), { recursive: true, force: true });
}

test("ensureMaster migrates an old-layout ~/AGENTS.md master into ~/.agents/AGENTS.md", async () => {
	resetLayout();
	writeFileSync(homePointer(), REAL_MASTER("OLD MASTER"));
	writeFileSync(master(), OLD_SELF_POINTER);
	const r = await store.ensureMaster();
	assert.equal(r.action, "migrated");
	// content moved to the new master location
	assert.match(readFileSync(master(), "utf8"), /OLD MASTER/);
	// the old master location is now the managed home pointer stub
	assert.match(readFileSync(homePointer(), "utf8"), /agent-cli-master-pointer/);
	assert.match(readFileSync(homePointer(), "utf8"), /master-tilde: ~\/\.agents\/AGENTS\.md/);
	// a backup of the pre-migration copy exists
	assert.ok(r.backup && existsSync(r.backup));
	assert.match(readFileSync(r.backup, "utf8"), /OLD MASTER/);
});

test("ensureMaster migrates even when ~/.agents/AGENTS.md is absent", async () => {
	resetLayout();
	writeFileSync(homePointer(), REAL_MASTER("ONLY HOME MASTER"));
	const r = await store.ensureMaster();
	assert.equal(r.action, "migrated");
	assert.match(readFileSync(master(), "utf8"), /ONLY HOME MASTER/);
	assert.match(readFileSync(homePointer(), "utf8"), /agent-cli-master-pointer/);
});

test("migration is idempotent — a second run is a plain exists", async () => {
	const r = await store.ensureMaster();
	assert.equal(r.action, "exists");
	assert.equal(r.changed, false);
});

test("divergence: both files real → keep ~/.agents/AGENTS.md, back up ~/AGENTS.md, warn", async () => {
	resetLayout();
	writeFileSync(homePointer(), REAL_MASTER("HOME COPY"));
	writeFileSync(master(), REAL_MASTER("AGENTS-DIR COPY"));
	const r = await store.ensureMaster();
	assert.equal(r.action, "diverged");
	// the canonical master keeps ITS content
	assert.match(readFileSync(master(), "utf8"), /AGENTS-DIR COPY/);
	assert.doesNotMatch(readFileSync(master(), "utf8"), /HOME COPY/);
	// home became the pointer; the home copy survives only in the backup
	assert.match(readFileSync(homePointer(), "utf8"), /agent-cli-master-pointer/);
	assert.ok(r.warning && /backed up/.test(r.warning));
	assert.ok(r.backup && existsSync(r.backup));
	assert.match(readFileSync(r.backup, "utf8"), /HOME COPY/);
});

test("a too-small/corrupt ~/AGENTS.md with no master is never adopted or replaced", async () => {
	resetLayout();
	writeFileSync(homePointer(), "x");
	const r = await store.ensureMaster();
	assert.equal(r.action, "exists");
	assert.equal(r.skipped, "master-too-small");
	assert.equal(readFileSync(homePointer(), "utf8"), "x"); // untouched
	assert.equal(existsSync(master()), false);
});

test("a too-small ~/AGENTS.md next to a real master is a divergence, not a failure", async () => {
	resetLayout();
	writeFileSync(homePointer(), "junk");
	writeFileSync(master(), REAL_MASTER("REAL MASTER"));
	const r = await store.ensureMaster();
	assert.equal(r.action, "diverged");
	assert.match(readFileSync(master(), "utf8"), /REAL MASTER/);
	assert.match(readFileSync(homePointer(), "utf8"), /agent-cli-master-pointer/);
});

test("stripStrayPointerHeader removes a stub header above real content", () => {
	const stray =
		"<!-- agent-cli-pointer -->\n" +
		"# AGENTS.md → redirected by agent-cli\n\n" +
		"This file is a **pointer stub**.\n\n" +
		"<!-- BEGIN agent-cli -->\n## agent-cli (AGENTS.md manager)\nReal content\n";
	const cleaned = store.stripStrayPointerHeader(stray);
	assert.doesNotMatch(cleaned, /pointer stub/);
	assert.match(cleaned, /Real content/);
});

test("ensureMasterPointer manages ~/AGENTS.md, never the master", async () => {
	resetLayout();
	writeFileSync(master(), REAL_MASTER("POINTER TEST MASTER"));
	const created = await store.ensureMasterPointer();
	assert.equal(created.action, "created");
	assert.equal(created.path, homePointer());
	assert.match(readFileSync(homePointer(), "utf8"), /agent-cli-master-pointer/);
	// idempotent
	const skipped = await store.ensureMasterPointer();
	assert.equal(skipped.action, "skipped");
	// refuses native content without force
	writeFileSync(homePointer(), "# native notes\n");
	const refused = await store.ensureMasterPointer();
	assert.equal(refused.skipped, "native-content");
	assert.equal(readFileSync(homePointer(), "utf8"), "# native notes\n");
	const forced = await store.ensureMasterPointer({ force: true });
	assert.equal(forced.action, "overwritten");
	assert.match(readFileSync(homePointer(), "utf8"), /agent-cli-master-pointer/);
});

test("classifyMasterPointer reports missing/pointer/native for ~/AGENTS.md", async () => {
	resetLayout();
	assert.equal((await store.classifyMasterPointer()).state, "missing");
	await store.ensureMasterPointer();
	assert.equal((await store.classifyMasterPointer()).state, "pointer");
	writeFileSync(homePointer(), "# native\n");
	assert.equal((await store.classifyMasterPointer()).state, "native");
});

test("backups land in ~/.agents/backups with a timestamped name", async () => {
	resetLayout();
	writeFileSync(homePointer(), REAL_MASTER("BACKUP NAME TEST"));
	const r = await store.ensureMaster();
	assert.equal(r.action, "migrated");
	const dir = path.join(TMP, ".agents", "backups");
	assert.ok(existsSync(dir));
	const names = readdirSync(dir).filter((f) => f.startsWith("AGENTS-"));
	assert.ok(names.length >= 1, "expected an AGENTS-<stamp>.md backup");
});
