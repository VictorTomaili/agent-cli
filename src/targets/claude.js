// src/targets/claude.js — one-file target descriptor for "claude".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "claude",
		name: "Claude Code",
		docs: "https://code.claude.com/docs/en/hooks",
		global: ".claude/CLAUDE.md",
		project: "CLAUDE.md",
		detect: ".claude",
		hooks: { event: "SessionStart", configFile: ".claude/settings.json" },
		// Cross-tool sharing (agent-cli link agents|skills): home-relative dirs
		// this tool natively reads. Cursor also reads ~/.claude/agents for
		// Claude compatibility, so linking here covers it too.
		share: { agents: ".claude/agents", skills: ".claude/skills" },
	};
