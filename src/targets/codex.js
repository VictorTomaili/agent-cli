// src/targets/codex.js — one-file target descriptor for "codex".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "codex",
		name: "OpenAI Codex",
		docs: "https://developers.openai.com/codex/",
		global: ".codex/AGENTS.md",
		project: "AGENTS.md",
		detect: ".codex",
		share: { agents: ".codex/agents" },
		hooks: { event: "SessionStart", configFile: ".codex/hooks.json" },
	};
