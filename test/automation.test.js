// Automation layer tests: jobs (add/list/remove/run), git hooks, watcher.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-auto-"));
process.env.AGENT_CLI_HOME = TMP;

const auto = await import("../src/automation.js");

function resetJobs() {
	rmSync(auto.AUTOMATION_FILE, { recursive: true, force: true });
}

test("addJob creates a job; readJobs lists it", () => {
	resetJobs();
	const job = auto.addJob({ name: "greet", event: "session-start", command: "echo hi" });
	assert.equal(job.name, "greet");
	assert.equal(job.event, "session-start");
	const jobs = auto.readJobs();
	assert.equal(jobs.length, 1);
	assert.equal(jobs[0].command, "echo hi");
});

test("addJob rejects duplicate names", () => {
	resetJobs();
	auto.addJob({ name: "dup", event: "sync", command: "echo" });
	assert.throws(() => auto.addJob({ name: "dup", event: "sync", command: "echo2" }), /already exists/);
});

test("runJobs executes matching event only", () => {
	resetJobs();
	auto.addJob({ name: "a", event: "session-start", command: "echo A" });
	auto.addJob({ name: "b", event: "sync", command: "echo B" });
	const r = auto.runJobs({ event: "session-start" });
	assert.equal(r.length, 1);
	assert.equal(r[0].name, "a");
	assert.equal(r[0].status, "ok");
	// "*" runs all
	const all = auto.runJobs({ event: "*" });
	assert.equal(all.length, 2);
});

test("removeJob deletes by name", () => {
	resetJobs();
	auto.addJob({ name: "x", event: "snapshot", command: "echo" });
	assert.equal(auto.removeJob("x"), 1);
	assert.equal(auto.readJobs().length, 0);
	assert.equal(auto.removeJob("missing"), 0);
});

test("installGitHooks writes agent-managed hooks; removeGitHooks cleans them", () => {
	const repo = mkdtempSync(path.join(tmpdir(), "agent-gitrepo-"));
	mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
	const installed = auto.installGitHooks({ cwd: repo });
	assert.deepEqual(installed, ["post-merge", "post-checkout"]);
	for (const h of installed) {
		const p = path.join(repo, ".git", "hooks", h);
		assert.ok(existsSync(p));
		assert.ok(readFileSync(p, "utf8").includes("Managed by agent-cli"));
		assert.ok(readFileSync(p, "utf8").includes("agent-cli link"));
	}
	assert.equal(auto.removeGitHooks({ cwd: repo }), 2);
	assert.ok(!existsSync(path.join(repo, ".git", "hooks", "post-merge")));
});

test("installGitHooks refuses non-git dir", () => {
	const plain = mkdtempSync(path.join(tmpdir(), "agent-nogit-"));
	assert.throws(() => auto.installGitHooks({ cwd: plain }), /not a git repository/);
});

test("watch fingerprint detects a changed file", async () => {
	const { utimesSync } = await import("node:fs");
	mkdirSync(auto.AGENTS_DIR, { recursive: true });
	const md = path.join(auto.AGENTS_DIR, "AGENTS.md");
	writeFileSync(md, "# v1\n");
	// Force a distinctly-old mtime so the next write is always detectable
	// (NTFS mtime granularity can otherwise alias two rapid writes).
	utimesSync(md, new Date(0), new Date(0));
	// scope to the isolated home so only our controlled master is fingerprinted
	const targets = auto.watchTargets(TMP);
	assert.ok(targets.some((t) => t.type === "master"));
	const before = auto.fingerprintAll(targets);
	writeFileSync(md, "# v2\n");
	const after = auto.fingerprintAll(targets);
	const events = auto.diffFingerprints(before, after);
	assert.ok(events.some((e) => e.type === "changed"));
	// no change → no events
	const same = auto.diffFingerprints(after, auto.fingerprintAll(targets));
	assert.equal(same.length, 0);
});
