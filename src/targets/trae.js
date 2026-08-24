// src/targets/trae.js — one-file target descriptor for "trae".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "trae",
		name: "Trae",
		docs: "https://docs.trae.ai/",
		global: null,
		project: ".trae/rules/agent-cli.md",
		detect: ".trae",
		hooks: { event: "SessionStart", configFile: ".trae/hooks/hooks.json" },
	};
