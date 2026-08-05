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
per overridable kind. All four must agree.`;

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
