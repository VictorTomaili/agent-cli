// src/targets/opencode.js — one-file target descriptor for "opencode".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "opencode",
		name: "OpenCode",
		docs: "https://opencode.ai/",
		global: null,
		project: "AGENTS.md",
		detect: ".opencode",
		note: "OpenCode reads AGENTS.md.",
		// OpenCode global custom agents (docs: ~/.config/opencode/agents).
		share: { agents: ".config/opencode/agents" },
		hooks: { event: "session_start", configFile: "opencode.json" },
	};
