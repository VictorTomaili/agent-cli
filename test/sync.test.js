// Sync tests: git-backed brain portability. Skipped when git is unavailable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
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

// --- secrets must not reach the remote -------------------------------------
// The "secrets are never synced" guarantee used to rest entirely on a .gitignore
// written once at init. .gitignore is tracked, so syncPull merges the remote's
// version of it — meaning the remote controlled whether the local secrets stayed
// local. These three tests pin the layered defense that replaced that.

const secretsPath = () => path.join(sync.AGENTS_DIR, ".secrets.json");
const keyPath = () => path.join(sync.AGENTS_DIR, ".secrets.key");
const gitignorePath = () => path.join(sync.AGENTS_DIR, ".gitignore");

test("syncPush writes .git/info/exclude, which a remote cannot rewrite", { skip: !hasGit }, async () => {
	await sync.syncInit();
	writeFileSync(path.join(sync.AGENTS_DIR, "AGENTS.md"), "# x\n", "utf8");
	await sync.syncPush({ message: "seed" });
	const ex = readFileSync(
		path.join(sync.AGENTS_DIR, ".git", "info", "exclude"),
		"utf8",
	);
	assert.ok(ex.includes(".secrets.json"), ".secrets.json must be in info/exclude");
	assert.ok(ex.includes(".secrets.key"), ".secrets.key must be in info/exclude");
});

test("a .gitignore that lost its .secrets lines does not leak them", { skip: !hasGit }, async () => {
	await sync.syncInit();
	writeFileSync(secretsPath(), '{"secrets":{"T":"ct"}}', "utf8");
	writeFileSync(keyPath(), "k".repeat(32), "utf8");
	// The accidental case: someone tidied .gitignore, or the brain became a repo
	// by hand and never had one. info/exclude still covers it, so the push
	// proceeds — but must not carry the secrets.
	writeFileSync(gitignorePath(), "config.json\nbackups/\n", "utf8");
	writeFileSync(path.join(sync.AGENTS_DIR, "AGENTS.md"), "# y\n", "utf8");
	const r = await sync.syncPush({ message: "after gitignore was tidied" });
	assert.equal(r.ok, true, r.reason);
	const tracked = git(["ls-files"]).stdout.split("\n");
	assert.ok(!tracked.includes(".secrets.json"), "store must not be tracked");
	assert.ok(!tracked.includes(".secrets.key"), "key must not be tracked");
});

test("syncPush refuses when .gitignore negates the secret exclusion", { skip: !hasGit }, async () => {
	await sync.syncInit();
	writeFileSync(secretsPath(), '{"secrets":{"T":"ct"}}', "utf8");
	// The adversarial case. A negation in .gitignore OUTRANKS .git/info/exclude,
	// so the untracked-file defense alone would not hold here; only asking git
	// itself (check-ignore) sees this coming.
	writeFileSync(gitignorePath(), ".secrets.json\n!.secrets.json\n", "utf8");
	const r = await sync.syncPush({ message: "should never happen" });
	assert.equal(r.ok, false, "push must refuse rather than commit the store");
	assert.match(r.reason, /refusing to push/);
	assert.deepEqual(
		r.exposedSecrets.map((e) => e.why),
		["not-ignored"],
	);
	assert.ok(!git(["ls-files"]).stdout.includes(".secrets.json"));
	writeFileSync(gitignorePath(), sync.SYNC_EXCLUDES.join("\n") + "\n", "utf8");
});

test("syncPush refuses when a secret is already tracked, and says to rotate", { skip: !hasGit }, async () => {
	await sync.syncInit();
	writeFileSync(secretsPath(), '{"secrets":{"T":"ct"}}', "utf8");
	// Simulates a brain that leaked on an earlier push: no ignore rule can undo
	// a commit, so refusing plus telling the user to rotate is the only honest
	// outcome. -f is how it gets into this state in the first place.
	git(["add", "-f", "--", ".secrets.json"]);
	const r = await sync.syncPush({ message: "already leaked" });
	assert.equal(r.ok, false);
	assert.match(r.reason, /already tracked/);
	assert.match(r.reason, /rotate/);
	assert.deepEqual(
		r.exposedSecrets.map((e) => e.why),
		["tracked"],
	);
	git(["rm", "--cached", "-q", "--", ".secrets.json"]);
});
