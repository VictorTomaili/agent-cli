// Unit tests for the pure compliance scorer (src/evaluate.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreSession } from "../src/evaluate.js";

test("scoreSession: all signals met scores full marks with no feedback", () => {
	const session = {
		startedAt: "2026-08-01T00:00:00.000Z",
		endedAt: "2026-08-01T01:00:00.000Z",
		reported: true,
		lessonsCaptured: [{ topic: "session/foo", at: "2026-08-01T00:30:00.000Z" }],
	};
	const r = scoreSession(session);
	assert.equal(r.score, r.max);
	assert.equal(r.max, 100);
	assert.equal(r.feedback.length, 0);
	assert.equal(r.breakdown.length, 3);
	for (const b of r.breakdown) assert.equal(b.points, b.max);
});

test("scoreSession: all signals missing scores zero with three feedback items", () => {
	const session = {
		startedAt: "2026-08-01T00:00:00.000Z",
	};
	const r = scoreSession(session);
	assert.equal(r.score, 0);
	assert.equal(r.feedback.length, 3);
	for (const b of r.breakdown) assert.equal(b.points, 0);
	assert.ok(r.feedback.some((f) => /session end/.test(f)));
	assert.ok(r.feedback.some((f) => /session report/.test(f)));
	assert.ok(r.feedback.some((f) => /lessons add/.test(f)));
});

test("scoreSession: partial — closed only", () => {
	const session = {
		startedAt: "2026-08-01T00:00:00.000Z",
		endedAt: "2026-08-01T01:00:00.000Z",
		reported: false,
		lessonsCaptured: [],
	};
	const r = scoreSession(session);
	const closed = r.breakdown.find((b) => b.signal === "closed");
	const reported = r.breakdown.find((b) => b.signal === "reported");
	const lessons = r.breakdown.find((b) => b.signal === "lessons");
	assert.equal(closed.points, closed.max);
	assert.equal(reported.points, 0);
	assert.equal(lessons.points, 0);
	assert.equal(r.score, closed.max);
	assert.equal(r.feedback.length, 2);
});

test("scoreSession: tolerates a null/undefined session without throwing", () => {
	const r = scoreSession(null);
	assert.equal(r.score, 0);
	assert.equal(r.feedback.length, 3);
});
