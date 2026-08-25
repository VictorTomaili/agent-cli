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
 *   - reported: session.reported === true (agent-cli session report was run)
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
	if (!closed) feedback.push("session was never ended — run `agent-cli session end`");

	const reported = session?.reported === true;
	breakdown.push({
		signal: "reported",
		points: reported ? MAX_PER_SIGNAL.reported : 0,
		max: MAX_PER_SIGNAL.reported,
		detail: reported ? "reported === true" : "session was never reported",
	});
	if (!reported)
		feedback.push(
			"session was never reported — run `agent-cli session report` before/at close",
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
			"no lessons captured — if anything surprising or corrected happened, run `agent-cli lessons add <topic>`",
		);

	const score = breakdown.reduce((sum, b) => sum + b.points, 0);
	return { score, max: MAX, breakdown, feedback };
}

/**
 * Score a team-run summary (produced by src/team-eval.js `summarizeSession`)
 * against the Aug-20 dev-team KPIs: routing accuracy, validation catch rate,
 * and delegation ratio.
 *
 * Honesty rules (this is a scaffold, not a scorer):
 *   - `routingAccuracy` is `null` when the expected-role table is absent or
 *     empty — the honest "not yet measured" state. P8/P11 fill that table; only
 *     once it exists is a non-null routing accuracy meaningful. (This function
 *     does not look up expected roles itself; it only consults
 *     `sessionSummary.expectedRoles`, which the summary carries once the table
 *     lands.)
 *   - `validationCatchRate` (failed / total dispatches) and `delegationRatio`
 *     (unique roles / total dispatches) always compute from the summary, even
 *     for a zeroed/empty-session summary (they return 0, never a NaN).
 *
 * Returned shape:
 *   { routingAccuracy, validationCatchRate, delegationRatio, comment }
 */
export function scoreTeamRun({ sessionSummary } = {}) {
	const s = sessionSummary || {};
	const total = Number(s.runs ?? 0);
	const status = s.dispatchesByStatus || {};
	const failed = Number(status.failed ?? 0);
	const uniqueRoles = Array.isArray(s.rolesActivated) ? s.rolesActivated.length : 0;

	const validationCatchRate = total > 0 ? failed / total : 0;
	const delegationRatio = total > 0 ? uniqueRoles / total : 0;

	// expectedRoles is a table the harness has not filled yet. Present and
	// non-empty → report the default 1.0 placeholder (real matching lands with
	// P8/P11). Absent or empty → null, the honest "not yet measured" state.
	const expected = s.expectedRoles;
	const hasExpected =
		expected &&
		typeof expected === "object" &&
		Array.isArray(expected) === false &&
		Object.keys(expected).length > 0;
	const routingAccuracy = hasExpected ? 1.0 : null;

	const comment =
		routingAccuracy === null
			? "routingAccuracy is null: the expected-role table is empty (P8/P11); validationCatchRate and delegationRatio are measured."
			: "routingAccuracy is a placeholder 1.0; the expected-role table exists but per-dispatch matching is not wired yet (P8/P11).";

	return { routingAccuracy, validationCatchRate, delegationRatio, comment };
}
