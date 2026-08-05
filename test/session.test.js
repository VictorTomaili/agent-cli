// Session lifecycle tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_CLI_HOME = mkdtempSync(path.join(tmpdir(), "agent-sess-"));
const session = await import("../src/session.js");

test("sessionStart records a session; currentSession reads it", async () => {
	const r = await session.sessionStart({ task: "fix the parser" });
	assert.equal(r.ok, true);
	assert.equal(r.session.task, "fix the parser");
	assert.ok(r.session.startedAt);
	const cur = session.currentSession();
	assert.equal(cur.task, "fix the parser");
});

test("sessionEnd computes duration", async () => {
	const r = await session.sessionEnd();
	assert.equal(r.ok, true);
	assert.ok(r.durationMs >= 0);
	assert.ok(r.session.endedAt);
});

test("sessionEnd with no active session reports a reason", async () => {
	// overwrite the session file with an empty/invalid state
	const { readFileSync, writeFileSync } = await import("node:fs");
	writeFileSync(session.sessionFilePath(), "{}", "utf8");
	const r = await session.sessionEnd();
	assert.equal(r.ok, false);
});

test("sessionReport proposes a lesson candidate", async () => {
	await session.sessionStart({ task: "merge feature branches" });
	const r = await session.sessionReport();
	assert.equal(r.ok, true);
	assert.match(r.lesson.topic, /session\/merge-feature-branches/);
	assert.match(r.lesson.suggestion, /lessons capture/);
});
