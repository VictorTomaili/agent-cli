// src/targets/cursor.js — one-file target descriptor for "cursor".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.
//
// Cursor .mdc rules need YAML frontmatter with alwaysApply so the rule is
// always loaded by the IDE — that wrapping is the only thing this target
// contributes that the standard pointer stub doesn't.

/** Wrap a master pointer stub with the .mdc frontmatter Cursor requires. */
export function cursorTransform(content) {
	return [
		"---",
		"description: Synced by agent-cli from ~/.agents/AGENTS.md",
		"alwaysApply: true",
		"---",
		"",
		content,
	].join("\n");
}

export default {
	id: "cursor",
	name: "Cursor",
	docs: "https://docs.cursor.com/context/rules",
	global: null,
	project: ".cursor/rules/agent-cli.mdc",
	detect: ".cursor",
	note: "Writes an alwaysApply .mdc rule. Cursor has no user-level rules file.",
	transform: cursorTransform,
	// Cursor user-level subagents (docs: ~/.cursor/agents). Cursor ALSO reads
	// ~/.claude/agents + ~/.codex/agents for compatibility, so the claude/codex
	// links cover Cursor even without this one.
	share: { agents: ".cursor/agents" },
	hooks: { event: "sessionStart", configFile: ".cursor/hooks.json" },
};