// src/targets/pi.js — one-file target descriptor for "pi".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "pi",
		name: "pi coding agent",
		docs: "https://github.com/earendil-works/pi",
		global: ".pi/agent/AGENTS.md",
		project: "AGENTS.md",
		detect: ".pi",
		// pi reads skills natively from ~/.agents/skills (the hub share.js links
		// to the skill store); its sub-agents live in ~/.pi/agent/agents.
		share: { agents: ".pi/agent/agents" },
		hooks: {
			event: "SessionStart",
			configFile: ".pi/agent/hooks.json",
			note: "Requires the @hsingjui/pi-hooks adapter; install it separately.",
		},
	};
