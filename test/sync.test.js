// Sync tests: git-backed brain portability. Skipped when git is unavailable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_CLI_HOME = mkdtempSync(path.join(tmpdir(), "agent-sync-"));
const sync = await import("../src/sync.js");

function git(args) {
	const r = spawnSync("git", args, { encoding: "utf8", cwd: sync.AGENTS_DIR });
	return { ok: r.status === 0, stdout: (r.stdout || "").trim() };
}

const hasGit = sync.gitAvailable();

test("sync functions require git (repo present)", () => {
	// The test machine either has git (so tests run) or the suite is skipped.
	// We still verify the module loads and reports availability.
	assert.equal(typeof sync.syncInit, "function");
});

test("syncInit creates a repo and writes the exclusion .gitignore", { skip: !hasGit }, async () => {
	const r = await sync.syncInit();
	assert.equal(r.ok, true);
	assert.equal(git(["rev-parse", "--is-inside-work-tree"]).stdout, "true");
	const gi = readFileSync(path.join(sync.AGENTS_DIR, ".gitignore"), "utf8");
	assert.ok(gi.includes("config.json"));
	assert.ok(gi.includes(".secrets.json"));
	assert.ok(gi.includes("backups/"));
});

test("syncPush commits changes and excludes machine-local files", { skip: !hasGit }, async () => {
	await sync.syncInit();
	writeFileSync(path.join(sync.AGENTS_DIR, "AGENTS.md"), "# master\n", "utf8");
	writeFileSync(path.join(sync.AGENTS_DIR, ".secrets.json"), "{}", "utf8");
	writeFileSync(path.join(sync.AGENTS_DIR, "config.json"), "{}", "utf8");
	const r = await sync.syncPush({ message: "test commit" });
	assert.equal(r.ok, true);
	assert.equal(r.changed, true);
	const tracked = git(["ls-files"]).stdout.split("\n");
	assert.ok(tracked.includes("AGENTS.md"));
	assert.ok(!tracked.includes(".secrets.json"), "secrets must never be tracked");
	assert.ok(!tracked.includes("config.json"), "config.json must be excluded");
});

test("syncStatus reports a clean tree after push", { skip: !hasGit }, async () => {
	const s = await sync.syncStatus();
	assert.equal(s.ok, true);
	assert.ok(s.branch.length > 0);
	assert.ok(s.head);
	assert.deepEqual(s.dirtyFiles, []);
});

test("syncLog lists commit history", { skip: !hasGit }, async () => {
	const r = await sync.syncLog();
	assert.equal(r.ok, true);
	assert.ok(r.entries.length >= 1);
	assert.ok(r.entries[0].hash.length >= 7);
});

test("syncRollback restores a file to a previous commit", { skip: !hasGit }, async () => {
	await sync.syncInit();
	const target = path.join(sync.AGENTS_DIR, "brain.md");
	writeFileSync(target, "version one\n", "utf8");
	await sync.syncPush({ message: "v1" });
	const first = (await sync.syncLog()).entries[0].hash;
	writeFileSync(target, "version two\n", "utf8");
	await sync.syncPush({ message: "v2" });
	const rb = await sync.syncRollback({ commit: first });
	assert.equal(rb.ok, true);
	assert.equal(readFileSync(target, "utf8"), "version one\n");
});

test("syncDiff returns working changes when no commit given", { skip: !hasGit }, async () => {
	await sync.syncInit();
	writeFileSync(path.join(sync.AGENTS_DIR, "brain.md"), "dirty change\n", "utf8");
	const r = await sync.syncDiff();
	assert.equal(r.ok, true);
	assert.match(r.diff, /brain\.md/);
});

test("setAutoCommit toggles the config flag", () => {
	const cfg = {};
	assert.equal(sync.setAutoCommit(cfg, true), true);
	assert.equal(sync.autoCommitEnabled(cfg), true);
	assert.equal(sync.setAutoCommit(cfg, false), false);
	assert.equal(sync.autoCommitEnabled(cfg), false);
});
