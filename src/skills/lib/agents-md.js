import { GATE_POLICY_TEXT } from './gate-policy.js'

const BEGIN = '<!-- BEGIN skill-cli -->'
const END = '<!-- END skill-cli -->'

// Global instruction block — injected into each agent's global instruction file.
// `agent skill active` (alias: `status`) is a description-only CATALOG of ACTIVE skills;
// decides per skill: functional → `agent skill cat`, context-altering → propose. No flag
// or fixed list — detection is the agent's judgment from the description, so it
// covers any skill (including ones installed later). The gate policy text comes
// from gate-policy.js (single source of truth, shared with `skill active`).
export const AGENTS_BLOCK = `## skill-cli

This machine uses the \`agent skill\` command to manage skills (instruction /
workflow packages). Skills live in a single global store (\`~/.skill-cli/store\`)
and are NOT copied into agent directories (\`~/.claude\`, \`~/.codex\`, etc.) — so
they won't appear here.

Usage:
- \`agent skill list\` — skills installed + active in the current project (with triggers)
- \`agent skill show <name>\` — skill summary (path, triggers, version)
- \`agent skill cat <name>\` — load skill content into context
- \`agent skill default <name>\` — mark a skill as a global default (active + auto-load)

${GATE_POLICY_TEXT}`

export function injectBlock(content) {
	const wrapped = `${BEGIN}\n${AGENTS_BLOCK}\n${END}`
	if (content.includes(BEGIN)) {
		return content.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), wrapped)
	}
	return (content ? content.replace(/\n*$/, '') + '\n\n' : '') + wrapped + '\n'
}
