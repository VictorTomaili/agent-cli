// The contract's conflict-resolution rules, pinned.
//
// AGENTS.md ships to several harnesses whose system prompts contradict it. An
// adversarial read of the rewritten contract found the same conflict resolved
// several different ways in one file, which means the answer a model gives
// depends on which paragraph it read last rather than on the rule. Each
// assertion here pins one of those resolutions. They are cheap to keep and the
// failure they prevent is silent: the rule does not error, it just loses.

import { test } from "node:test";
import assert from "node:assert";
import { AGENT_CLI_BLOCK, COMMUNICATION_BLOCK } from "../src/blocks.js";
import { GATE_POLICY_TEXT } from "../src/skills/lib/gate-policy.js";

const CONTRACT = `${AGENT_CLI_BLOCK}\n${COMMUNICATION_BLOCK}\n${GATE_POLICY_TEXT}`;

test("the wait-or-proceed decision is stated once and deferred to everywhere else", () => {
	// Four places used to answer "may I block on a question": the sizing
	// section, the gate's parameters rule, the gate's fallback, and the
	// autonomy directive. Only one may hold the rule.
	assert.ok(
		AGENT_CLI_BLOCK.includes("**Asking versus proceeding.**"),
		"the single asking rule must exist",
	);
	assert.ok(
		AGENT_CLI_BLOCK.includes("Decide this once per task, not once per rule"),
		"the asking rule must claim to be the only one",
	);
	assert.ok(
		GATE_POLICY_TEXT.includes("this gate adds no separate waiting rule"),
		"the START GATE must defer rather than restate the rule",
	);
	// "end the turn" as a fallback for "the harness forbids blocking" is not a
	// fallback — it is the forbidden behaviour through another channel.
	assert.ok(
		!/end the turn/i.test(CONTRACT),
		"no rule may resolve a blocking conflict by ending the turn",
	);
	assert.ok(
		AGENT_CLI_BLOCK.includes(
			"Never end a\nturn for the sole purpose of asking something",
		),
		"the contract must forbid ending a turn just to ask",
	);
});

test("a spawned sub-agent is scoped out of the orchestration and session routines", () => {
	// This file ships as CLAUDE.md, which Claude Code injects into sub-agents
	// too. Without this carve-out a sub-agent delegates instead of working, and
	// runs `session end` on its own turn — archiving the parent's session
	// mid-task, which corrupts state rather than merely wasting a call.
	assert.ok(AGENT_CLI_BLOCK.includes("**Who this applies to.**"));
	assert.ok(
		AGENT_CLI_BLOCK.includes(
			"If another agent spawned you, you are the worker, not\nthe orchestrator",
		),
	);
	for (const forbidden of [
		"do not delegate further",
		"do not run the\nSTART GATE",
		"`agent-cli session end` or `session report`",
	]) {
		assert.ok(
			AGENT_CLI_BLOCK.includes(forbidden),
			`sub-agent carve-out must name: ${forbidden}`,
		);
	}
});

test("the priority order does not swallow the delegation cost test", () => {
	// `correctness > quality > cost > speed` plus "delegate unless it costs
	// more than it saves" lets a model argue that a cost argument can never
	// override the delegation mandate, so it delegates one-line answers.
	assert.ok(AGENT_CLI_BLOCK.includes("correctness > quality > cost > speed"));
	assert.ok(
		AGENT_CLI_BLOCK.includes("orders HOW the work\nis done, not WHO does it"),
		"the priority order must be scoped away from the delegation test",
	);
	assert.ok(
		AGENT_CLI_BLOCK.includes("That is a\n  judgement, not a closed list"),
		"the do-it-yourself cases must not read as an exhaustive enumeration",
	);
});

test("precedence is decided by category, not by how the harness phrases its rule", () => {
	// "the harness merely defaults differently" was unjudgeable from inside:
	// a harness that says "End git commit messages with: Co-Authored-By ..."
	// is instructing, not defaulting, so the carve-out lost to the general
	// rule it existed to escape.
	assert.ok(AGENT_CLI_BLOCK.includes("wins on capability and safety"));
	assert.ok(AGENT_CLI_BLOCK.includes("how the\nuser wants work done"));
	assert.ok(
		AGENT_CLI_BLOCK.includes(
			"whatever your harness calls them — a\ndefault, a convention, or a direct instruction",
		),
		"the carve-out must be phrasing-blind",
	);
	assert.ok(
		!/merely defaults differently/.test(AGENT_CLI_BLOCK),
		"the defeated defaults-vs-instructs wording must not come back",
	);
});

test("the self-check carries the same escape hatches as the prose it summarises", () => {
	// The checklist is the last thing read before a turn ends, so it becomes
	// the operative version. A stricter checklist silently overrides the rules.
	assert.ok(
		AGENT_CLI_BLOCK.includes("Skip this list for a trivial or conversational"),
		"the checklist must not apply to trivial replies",
	);
	assert.ok(
		AGENT_CLI_BLOCK.includes("If you started a session, you ended it"),
		"session close must stay conditional in the checklist",
	);
	assert.ok(
		AGENT_CLI_BLOCK.includes("Files that\n  do not exist were skipped"),
		"the read-order bullet must keep the missing-file allowance",
	);
	assert.ok(
		AGENT_CLI_BLOCK.includes("or you can say why delegating would have cost"),
		"the delegation bullet must keep the cost escape hatch",
	);
});

test("brief is ordered imperatively and parallel fetching is permitted", () => {
	// Every mention of `brief` used to be descriptive, so "no brief output was
	// provided, therefore no gaps" was true by default. And "without
	// parallelizing" contradicted harness guidance to batch independent calls,
	// for a requirement that is really about interpretation order.
	assert.ok(
		AGENT_CLI_BLOCK.includes("Run `agent-cli brief` at session start"),
		"brief must be an instruction, not a description",
	);
	assert.ok(
		!/without skipping ahead or parallelizing/.test(AGENT_CLI_BLOCK),
		"the parallel-fetch ban must not come back",
	);
	assert.ok(
		AGENT_CLI_BLOCK.includes("fetching in parallel does not break it"),
		"batched reads must stay explicitly allowed",
	);
});

test("no rule orders an unrequested global install mid-task", () => {
	assert.ok(
		AGENT_CLI_BLOCK.includes("Never run an update mid-task"),
		"the update check must not mandate self-updating before the user's task",
	);
	assert.ok(
		!/run the suggested update action before continuing/.test(AGENT_CLI_BLOCK),
		"the unconditional update instruction must not come back",
	);
});

test("delegation degrades instead of blocking when the harness cannot delegate", () => {
	assert.ok(
		AGENT_CLI_BLOCK.includes("Never block a task on setting up delegation"),
		"a machine with no configured runner must still get the task done",
	);
});

test("sub-agent results are verified against independent evidence", () => {
	assert.ok(
		AGENT_CLI_BLOCK.includes("evidence you produced yourself"),
		"verification must not be satisfiable by the sub-agent's own claim",
	);
	assert.ok(
		AGENT_CLI_BLOCK.includes('"Done" and "tests pass" are not evidence'),
		"the cheap reading of 'verify' must be closed explicitly",
	);
});

test("the banned-phrasing list is generalised beyond its five literals", () => {
	for (const literal of [
		"load-bearing",
		"worth stating plainly",
		"here's the honest truth",
		"the real tension",
		"carry the argument",
	]) {
		assert.ok(
			COMMUNICATION_BLOCK.includes(literal),
			`banned literal missing: ${literal}`,
		);
	}
	assert.ok(
		COMMUNICATION_BLOCK.includes("examples of one rule, not the whole rule"),
		"the list must not read as an exhaustive blocklist",
	);
	assert.ok(
		COMMUNICATION_BLOCK.includes("delete the clause"),
		"the rule needs a mechanical test the model can actually apply",
	);
	// Same rhetorical shape, not on the five-item list — named so the model
	// generalises instead of pattern-matching the literals.
	assert.ok(COMMUNICATION_BLOCK.includes("the key insight here"));
	assert.ok(COMMUNICATION_BLOCK.includes("crucially"));
});

test("verbatim reproduction is a fidelity rule with a stated ceiling", () => {
	// "reproduce them in full every time" and "give the shortest output" sat
	// twelve lines apart. Without a ceiling a 600-line stack gets pasted whole.
	assert.ok(COMMUNICATION_BLOCK.includes("fidelity rule, not a length quota"));
	assert.ok(COMMUNICATION_BLOCK.includes("frames elided"));
	// The carve-out must never reach the parts that matter for safety.
	assert.ok(
		COMMUNICATION_BLOCK.includes(
			"Never cut the error message\nitself, never trim a security finding, never abbreviate a command",
		),
		"eliding must stop short of the message, the finding and the command",
	);
});

test("the START GATE does not re-propose a declined skill forever", () => {
	assert.ok(
		GATE_POLICY_TEXT.includes(
			"Never re-propose a skill the user declined\nthis session",
		),
		"a decline must be durable for the session",
	);
	assert.ok(
		!/on every later message/.test(GATE_POLICY_TEXT),
		"per-message re-classification must not come back",
	);
	assert.ok(
		GATE_POLICY_TEXT.includes("or the task moves to a new surface"),
		"re-classification needs a trigger other than 'a message arrived'",
	);
});

test("the START GATE yields to a harness that expands slash commands itself", () => {
	// Claude Code, Codex CLI and Gemini CLI all consume `/X` before the model
	// gets a turn, so the skill body is already in context. Shelling out anyway
	// produces a second, possibly different set of instructions and no tiebreak.
	assert.ok(
		GATE_POLICY_TEXT.includes("if your harness expands `/X` itself"),
		"the trigger rule must check whether the harness already handled it",
	);
	assert.ok(GATE_POLICY_TEXT.includes("do not shell out"));
});
