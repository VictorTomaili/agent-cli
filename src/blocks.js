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

Priority order: correctness > quality > cost > speed.`;

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
