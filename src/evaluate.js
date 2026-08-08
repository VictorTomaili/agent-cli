// src/evaluate.js — compliance scoring for a session (ROADMAP Phase 2:
// "did the agent read the mandatory files, verify its actions, capture
// lessons?"). Pure, no I/O — the command layer (commands/evaluate.js) loads
// the session object and calls scoreSession().
//
// Deliberately scores only what's honestly measurable from data the session
// object actually carries — no heuristics/guessing about what an agent
// "really" did (same philosophy as lessons-lib.js: no fabricated signals).
//
// Future extension (documented, not implemented): a "gaps addressed" signal
// comparing brief/gap state at session-start vs session-end would need a
// snapshot of gap state captured at both ends of the session — that data
// isn't recorded anywhere today, so it's left out rather than faked.

const MAX_PER_SIGNAL = { closed: 34, reported: 33, lessons: 33 };
const MAX = MAX_PER_SIGNAL.closed + MAX_PER_SIGNAL.reported + MAX_PER_SIGNAL.lessons;

/**
 * Score an archived-or-active session object against three signals:
 *   - closed: session.endedAt is set (not abandoned/orphaned)
 *   - reported: session.reported === true (agent session report was run)
 *   - lessons: session.lessonsCaptured has at least one entry
 *
 * Returns { score, max, breakdown, feedback }.
 */
export function scoreSession(session) {
	const breakdown = [];
	const feedback = [];

	const closed = !!session?.endedAt;
	breakdown.push({
		signal: "closed",
		points: closed ? MAX_PER_SIGNAL.closed : 0,
		max: MAX_PER_SIGNAL.closed,
		detail: closed
			? `ended at ${session.endedAt}`
			: "no endedAt — session is still open or was abandoned",
	});
	if (!closed) feedback.push("session was never ended — run `agent session end`");

	const reported = session?.reported === true;
	breakdown.push({
		signal: "reported",
		points: reported ? MAX_PER_SIGNAL.reported : 0,
		max: MAX_PER_SIGNAL.reported,
		detail: reported ? "reported === true" : "session was never reported",
	});
	if (!reported)
		feedback.push(
			"session was never reported — run `agent session report` before/at close",
		);

	const lessonsCount = Array.isArray(session?.lessonsCaptured)
		? session.lessonsCaptured.length
		: 0;
	const lessons = lessonsCount > 0;
	breakdown.push({
		signal: "lessons",
		points: lessons ? MAX_PER_SIGNAL.lessons : 0,
		max: MAX_PER_SIGNAL.lessons,
		detail: lessons
			? `${lessonsCount} lesson(s) captured`
			: "no lessons captured this session",
	});
	if (!lessons)
		feedback.push(
			"no lessons captured — if anything surprising or corrected happened, run `agent lessons add <topic>`",
		);

	const score = breakdown.reduce((sum, b) => sum + b.points, 0);
	return { score, max: MAX, breakdown, feedback };
}
