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

## Install & update

- The CLI ships as the npm package \`@tomaili/agent\`. Install or update it
  globally: \`npm i -g @tomaili/agent\`.
- \`agent brief\` (already mandated at session start) surfaces a cached npm
  update check. When it reports a newer version, run the suggested update
  action before continuing.
- If the \`agent\` command is missing entirely, tell the user and offer to
  install it. Never reimplement its functions by hand.

## Sub-agent dispatch (agent run)

- Delegate bounded sub-tasks to external coding-agent CLIs via
  \`agent run "<task>"\` (options: \`--tool <pi|codex>\`, \`--read-only\`,
  \`--timeout <seconds>\`). The configured fallback chain is applied
  automatically; failures report per-attempt tool/model/kind.
- Configure runners once per machine: \`agent configure run pi --provider zai
  --model glm-5.3 --thinking high --fallback codex:gpt-5.6-luna\` (spec
  format \`tool:provider/model[:thinking]\`); bare \`agent configure run\`
  prints the current chain.
- A coding agent (Claude Code, Codex, Gemini, ...) arriving on a machine
  where runners are NOT configured should propose a configuration to the
  user and apply it only after the user confirms — never silently.
- When a provider is capped or degraded, prefer switching tools (the
  fallback chain or \`--tool\`) over retrying the capped provider.

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
specific missing field to the user as a question, via \`agent onboard
suggest\` — it picks the single highest-priority unresolved gap (identity
archetype > identity name > user > soul > environments) and returns one
concrete question. For the identity-archetype case it returns options and
a default; write the user's answer back with \`agent identity apply
<choice>\`. For every other case (identity name, user, soul, environments)
it returns an open-ended question plus the exact fix command (e.g.
\`agent user set <field> "<value>"\`, \`agent soul set <field> "<value>"\`,
\`agent env set <field> "<value>"\`) — use that command verbatim, never
guess one.

A gap is a signal that the brain files don't yet know something true about
this agent, its user, or its environment. Filling it with an invented value
corrupts the record for every future session that trusts it; asking once
fixes it permanently.

This rule is enforced three ways: (a) this AGENTS.md instruction, (b)
\`src/agents-lib.js → computeOnboarding\`/\`nextGapSuggestion\` (computes the
gap report and picks the single ranked next question, from
\`src/fields.js\`'s tag schema, pure and unit-tested), (c) the \`agent onboard
suggest\` command (\`src/commands/edit.js\`), which turns a gap into a
single concrete question and fix command instead of leaving it for the
agent to paper over.

## Session report (MANDATORY)

At the natural end of a session or task, close the loop: run \`agent
session end\` (if a session was started). It returns a suggested lesson
topic derived from the session's task (\`session/<slugified-task>\`) plus
the exact command to file it (\`agent lessons capture <topic> --inbox\`)
directly in its own output — ending already surfaces the next step, no
separate call needed. This is how lesson candidates reach the inbox and
how the brain stays current for whichever coding tool — Claude Code,
Codex, Gemini, or otherwise — picks up the next session. Skipping it
doesn't lose data catastrophically, but it starves the next session of
context this one already earned.

\`agent session report\` is the mid-session variant of the same checklist —
run it BEFORE \`agent session end\` if you want the lesson-suggestion
without closing the session yet (e.g. a natural checkpoint partway through
a long task). Do NOT run it after \`agent session end\`: ending clears the
active session, so a report call afterward has nothing to report and
returns an error. \`agent session end\` archives the session to
\`~/.agents/sessions/\` and clears the active slot so the next \`agent
session start\` doesn't collide with a stale one.

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
- Session reported — \`agent session end\` ran (or \`agent session report\`
  mid-session, never after \`end\`) so the next session inherits this one's
  context.`;

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
  (content ? content.replace(/\n*$/, "") + "\n\n" : "") + AGENT_CLI_BLOCK + "\n"
 );
}

export const BEGIN_COMMUNICATION = "<!-- BEGIN communication -->";
export const END_COMMUNICATION = "<!-- END communication -->";

// Token-efficient communication contract — injected into every master right
// after the agent-cli block. Kept verbatim (only the top heading depth is
// adjusted to the block convention: `##`).
const COMMUNICATION_BODY = `## Communication Contract

No-BS, clear, concise, actionable. We are here to solve problems and create value; every reply reflects that.

## Style

- The last line is read first: end with the most important information.
- Plain, specific language. Use the simplest domain term that compresses the idea; avoid overloaded terms.
- State each fact once. Repeat only when a later query needs it.
- Match the level of detail to the size of the request.
- Challenge incorrect assumptions directly and say why.
- Prefer one sentence over two, one paragraph over two, when nothing of value is lost.
- No analogies. Discuss what is in front of us.
- No flattery, praise, validation, or agreement without reason.
- No decorative headings, emoji, or motivational language.
- No em-dash chains, semicolons, fragments, or non-standard punctuation.
- Never use: "load-bearing", "worth stating plainly", "here's the honest truth", "the real tension", "carry the argument".

## Reference codes

When presenting three or more items of one kind, give every item a short stable code and keep it for the whole conversation: \`D1..\` decisions, \`O1..\` options, \`F1..\` findings, \`R1..\` risks, \`Q1..\` questions, \`A1..\` actions. Invent codes for kinds not listed. Skip codes for short simple answers. Use numbered lists and headings only when they improve navigation.

## Boundaries

- Deliver exactly what was requested at the requested scope. No adjacent cleanup, refactoring, documentation, or features.
- No speculative abstractions for future requirements.
- No completion claims without evidence.
- Never add a co-author to a commit message.
- Restate completed work concisely; do not pad the report.

## Aliases

These exact standalone tokens expand to instructions. Inside a longer string they are not aliases.

- \`xsimple\` = Simplify, compress, and repeat your response.
- \`xexplain\` = Explain this like I'm 18. Simpler language, shorter response.
- \`xfocus\` = Reduce your response to the single most important thing here.
- \`xref\` = Rewrite your response using reference codes.

## Example

Q: "Is legacy-config.json still referenced?"
Right: "No. The only match is the file itself."
Wrong: preamble, offers of adjacent work, restating the question, closing summary.`;

export const COMMUNICATION_BLOCK = `${BEGIN_COMMUNICATION}\n${COMMUNICATION_BODY}\n${END_COMMUNICATION}`;

/**
 * Idempotently inject/refresh the communication block. When the agent-cli
 * block is present the communication block is placed directly AFTER it
 * (before anything that follows, e.g. the skill-cli block); otherwise it is
 * appended at the end.
 */
export function injectCommunicationBlock(content) {
 if (content.includes(BEGIN_COMMUNICATION)) {
  return content.replace(
   new RegExp(`${BEGIN_COMMUNICATION}[\\s\\S]*?${END_COMMUNICATION}`),
   COMMUNICATION_BLOCK,
  );
 }
 if (content.includes(END_AGENT_CLI)) {
  const end = content.indexOf(END_AGENT_CLI) + END_AGENT_CLI.length;
  const head = content.slice(0, end);
  const tail = content.slice(end).replace(/^\r?\n+/, "");
  return head + "\n\n" + COMMUNICATION_BLOCK + (tail ? "\n\n" + tail : "\n");
 }
 return (
  (content ? content.replace(/\n*$/, "") + "\n\n" : "") +
  COMMUNICATION_BLOCK +
  "\n"
 );
}

/** True if content has the communication managed block. */
export function hasCommunicationBlock(content) {
 return !!content && content.includes(BEGIN_COMMUNICATION);
}

/**
 * Ensure ALL managed blocks (agent-cli + communication + integrated skill) are
 * present and fresh in the master content, in that order. The integrated skill
 * implementation owns its block text.
 */
export function ensureBlocks(masterContent) {
 let c = injectAgentCliBlock(masterContent ?? "");
 c = injectCommunicationBlock(c);
 c = skillInjectBlock(c);
 return c;
}

/** True if content has the agent-cli managed block. */
export function hasAgentCliBlock(content) {
 return !!content && content.includes(BEGIN_AGENT_CLI);
}
