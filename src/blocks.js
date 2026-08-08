// src/blocks.js — managed instruction blocks inside the master AGENTS.md.
// The skill manager is integrated under src/skills; it is not a runtime or
// submodule dependency.

import { injectBlock as skillInjectBlock } from "./skills/lib/agents-md.js";

export const BEGIN_AGENT_CLI = "<!-- BEGIN agent-cli -->";
export const END_AGENT_CLI = "<!-- END agent-cli -->";

const AGENT_CLI_BODY = `## agent-cli (AGENTS.md manager)

This file is the **canonical, single source of truth** for your agent instructions.
It is shared across ALL your coding agents via pointer stubs (CLAUDE.md / AGENTS.md /
GEMINI.md / etc. each just redirect here). No copies, no drift.

Rules for any agent reading this:
- This is the ONLY instructions file to edit. Per-agent files are pointers — editing
  them has no effect. To open this file: \`agent edit\` (or read it directly).
- To inspect state machine-readably: \`agent status --json\` or \`agent brief --json\`.
- To deploy/refresh pointer stubs to agents: \`agent link\`.
- To enable a new agent target: \`agent target enable <id>\` then \`agent link\`.
- Diagnostics: \`agent doctor\`. AI session brief: \`agent brief\`.
- skill is integrated here; after changing skills run \`agent skill refresh\`.

Priority order: correctness > quality > cost > speed.

## Session start read order (MANDATORY)

\`agent brief\` emits a "Session start — read in this exact order" list. Read EVERY
file in that list in the EXACT order emitted — do NOT skip ahead, read out of
order, or parallelize the reads. Each file is interpreted through the prior files
in the chain, so the order is part of the contract (changing it is a spec-level
change, not a personal preference).

The canonical order is:

  1. AGENTS.md        — master contract (HOW to read the rest; governs behavior)
  2. SOUL.md          — personality / values / beliefs (what kind of being)
  3. IDENTITY.md      — name / role / archetype (which specific instance) — global only
  4. USER.md          — the human you serve (goals, preferences, context) — global only
  5. LESSONS.md       — accumulated rules (honor these; learned from past work)
  6. ENVIRONMENTS.md  — operating context (local / SSH / container / etc.)
  7. MODELS.md        — model aliases + catalog (tools — read LAST) — global only

Global-only kinds (identity / user / models) have NO project-scope override —
they describe characteristics of the agent, the operator, and the machine, which
don't vary per project. If a project-scope file with the same name exists, it is
ignored. The other four kinds (agents / soul / lessons / environments) DO have a
project override (loaded after the global entry).

Project LESSONS.md is OPTIONAL — a missing or empty project file is a legitimate
state meaning "no project-specific lessons yet". The global LESSONS.md carries
the system-wide lessons regardless. Don't treat a missing project LESSONS.md as
a gap; the brief output marks it "(no project lessons yet)" instead.

If a file is missing, skip it and proceed to the next. SPECT project files
(loaded after the canonical 7 when the project uses SPECT) follow the same rule:
read them in the order \`agent brief\` emits them.

This rule is enforced four ways: (a) this AGENTS.md instruction, (b) the
numbered list \`agent brief\` prints (with a "(global only)" annotation on
the relevant entries), (c) \`src/agents-lib.js → IDENTITY_FILES\` (locks both
the order AND the \`globalOnly\` flag), (d) a regression test that asserts the
session-start load list contains exactly ONE entry per global-only kind and TWO
per overridable kind. All four must agree.

## Lesson capture (MANDATORY)

When you hit something surprising, get corrected by the user, or confirm that
a non-obvious approach actually worked, capture it: \`agent lessons add
<topic/descriptive-name> [--body TEXT]\` (global scope by default; add \`-p\`
/ \`--project\` for a project-scoped lesson). Pick the topic yourself — there
is no fixed taxonomy; a short descriptive path like \`windows-path-quoting\`
or \`api/rate-limit-backoff\` is fine, including subfolders.

This is not optional busywork. LESSONS.md is read EVERY session — it is
entry 5 of the mandatory read order above — so a lesson captured once
prevents every future session from repeating the same mistake or re-deriving
the same non-obvious decision from scratch. A lesson you notice but don't
record is a lesson the next session pays for again.

If you're mid-task and don't want to interrupt flow to pick a final topic
name, use \`agent lessons add <topic> --inbox\` to drop a raw capture into
the inbox for later triage (\`agent lessons triage --plan\`, then \`agent
lessons triage --index <i> <topic>\`) — but prefer filing directly when the
topic is already obvious. Re-adding the same topic is not an error: it
increments an occurrence counter (recurrence signal) rather than
duplicating the file.

This rule is enforced three ways: (a) this AGENTS.md instruction, (b) the
"Session start read order" section above, which makes LESSONS.md a
mandatory read for every future session (so captured lessons are never
inert), (c) \`src/lessons-lib.js\` (the \`addLesson\`/\`addInboxCapture\`
primitives) plus \`src/commands/knowledge.js\` (the \`agent lessons\` command
surface), which are exercised by \`test/lessons-lib.test.js\`.

## Gap filling (MANDATORY)

\`agent brief\` reports unfilled fields in the brain files — IDENTITY.md,
USER.md, SOUL.md (structured \`<TAG>\` fields; see \`src/fields.js →
FIELD_TAGS\`), and ENVIRONMENTS.md (freeform \`- Field:\` gaps; see
\`ENVIRONMENT_FIELDS\`). When a gap is reported, do NOT silently ignore it
and do NOT guess a plausible-sounding value to fill it in. Surface the
specific missing field to the user as a question, via the onboarding/gap-fill
mechanism \`agent brief\` points at (today: \`agent onboard suggest\`, which
asks the one highest-priority question with options; write the user's answer
back with \`agent identity apply <choice>\`). A background task is
generalizing this mechanism beyond identity fields — if the command surface
has moved by the time you read this, use whatever \`agent brief\`'s own gap
output names as the next step, not a hardcoded guess.

A gap is a signal that the brain files don't yet know something true about
this agent, its user, or its environment. Filling it with an invented value
corrupts the record for every future session that trusts it; asking once
fixes it permanently.

This rule is enforced three ways: (a) this AGENTS.md instruction, (b)
\`src/agents-lib.js → computeOnboarding\`/\`identityInventory\` (computes the
gap report and the \`archetypeNeeded\`/\`gapRecommended\` flags from
\`src/fields.js\`'s tag schema, pure and unit-tested), (c) the \`agent onboard
suggest\` command (\`src/commands/edit.js\`, backed by \`src/identity.js →
onboardSuggest\`), which turns a gap into a single concrete question instead
of leaving it for the agent to paper over.

## Session report (MANDATORY)

At the natural end of a session or task, close the loop: run \`agent session
end\` (if a session was started) and \`agent session report\`. This is how
lesson candidates reach the inbox and how the brain stays current for
whichever coding tool — Claude Code, Codex, Gemini, or otherwise — picks up
the next session. Skipping it doesn't lose data catastrophically, but it
starves the next session of context this one already earned.

\`agent session report\` reads the active session and returns a suggested
lesson topic derived from the session's task (\`session/<slugified-task>\`)
plus the exact command to file it (\`agent lessons capture <topic>
--inbox\`) — use it as a checklist, not just a status dump. \`agent session
end\` archives the session to \`~/.agents/sessions/\` and clears the active
slot so the next \`agent session start\` doesn't collide with a stale one.

This rule is enforced two ways: (a) this AGENTS.md instruction, (b)
\`src/session.js\` (\`sessionEnd\`/\`sessionReport\`, exercised by
\`test/session.test.js\`) plus the \`agent session <action>\` command surface
that exposes them.

## Self-check (MANDATORY)

Before ending a turn, tick through this list:

- Read order followed — AGENTS.md → SOUL.md → IDENTITY.md → USER.md →
  LESSONS.md → ENVIRONMENTS.md → MODELS.md, in that exact order, nothing
  skipped or reordered.
- Gaps surfaced, not guessed — any \`agent brief\` gap became a question to
  the user, not an invented value.
- Lessons captured — anything surprising, corrected, or confirmed
  non-obvious got an \`agent lessons add\`, not just a mental note.
- Session reported — \`agent session end\` / \`agent session report\` ran so
  the next session inherits this one's context.`;

export const AGENT_CLI_BLOCK = `${BEGIN_AGENT_CLI}\n${AGENT_CLI_BODY}\n${END_AGENT_CLI}`;

/** Idempotently inject/refresh the agent-cli block (replace region, else append). */
export function injectAgentCliBlock(content) {
	if (content.includes(BEGIN_AGENT_CLI)) {
		return content.replace(
			new RegExp(`${BEGIN_AGENT_CLI}[\\s\\S]*?${END_AGENT_CLI}`),
			AGENT_CLI_BLOCK,
		);
	}
	return (
		(content ? content.replace(/\n*$/, "") + "\n\n" : "") +
		AGENT_CLI_BLOCK +
		"\n"
	);
}

/**
 * Ensure BOTH managed blocks (agent-cli + integrated skill) are present and fresh in the
 * master content. The integrated skill implementation owns its block text.
 */
export function ensureBlocks(masterContent) {
	let c = injectAgentCliBlock(masterContent ?? "");
	c = skillInjectBlock(c);
	return c;
}

/** True if content has the agent-cli managed block. */
export function hasAgentCliBlock(content) {
	return !!content && content.includes(BEGIN_AGENT_CLI);
}
