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

test("sessionEnd returns a lesson candidate suggestion", async () => {
	await session.sessionStart({ task: "refactor the router" });
	const r = await session.sessionEnd();
	assert.equal(r.ok, true);
	assert.ok(r.lesson);
	assert.match(r.lesson.topic, /session\/refactor-the-router/);
	assert.match(r.lesson.suggestion, /lessons capture/);
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

test("sessionStart refuses to overwrite an active session", async () => {
	await session.sessionEnd(); // clear any prior session
	const first = await session.sessionStart({ task: "keep me" });
	assert.equal(first.ok, true);
	const second = await session.sessionStart({ task: "do not clobber" });
	assert.equal(second.ok, false);
	assert.match(second.reason, /already active/);
	// the original session is preserved
	assert.equal(session.currentSession().task, "keep me");
	await session.sessionEnd();
});

test("recordLessonCapture appends to lessonsCaptured when a session is active", async () => {
	await session.sessionStart({ task: "capture some lessons" });
	assert.deepEqual(session.currentSession().lessonsCaptured, []);
	const r = session.recordLessonCapture("session/some-topic");
	assert.equal(r.ok, true);
	assert.equal(r.session.lessonsCaptured.length, 1);
	assert.equal(r.session.lessonsCaptured[0].topic, "session/some-topic");
	assert.ok(r.session.lessonsCaptured[0].at);
	// persisted, not just returned
	assert.equal(session.currentSession().lessonsCaptured.length, 1);
	session.recordLessonCapture("session/another-topic");
	assert.equal(session.currentSession().lessonsCaptured.length, 2);
	await session.sessionEnd();
});

test("recordLessonCapture is a silent no-op when no session is active", async () => {
	await session.sessionEnd(); // clear any prior session (idempotent-ish for this test)
	assert.equal(session.currentSession(), null);
	const r = session.recordLessonCapture("session/orphan-topic");
	assert.equal(r.ok, false);
	assert.equal(session.currentSession(), null);
});

test("markReported sets reported:true on the active session and persists it", async () => {
	await session.sessionStart({ task: "mark me reported" });
	assert.notEqual(session.currentSession().reported, true);
	const r = session.markReported();
	assert.equal(r.ok, true);
	assert.equal(r.session.reported, true);
	assert.equal(session.currentSession().reported, true);
	await session.sessionEnd();
});

test("markReported is a silent no-op when no session is active", async () => {
	await session.sessionEnd(); // clear any prior session
	const r = session.markReported();
	assert.equal(r.ok, false);
	assert.equal(session.currentSession(), null);
});

test("sessionReport marks the session as reported", async () => {
	await session.sessionStart({ task: "report me" });
	assert.notEqual(session.currentSession().reported, true);
	const r = await session.sessionReport();
	assert.equal(r.ok, true);
	assert.equal(r.session.reported, true);
	assert.equal(session.currentSession().reported, true);
	await session.sessionEnd();
});
