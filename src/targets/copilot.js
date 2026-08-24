// src/targets/copilot.js — one-file target descriptor for "copilot".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "copilot",
		name: "GitHub Copilot",
		docs:
			"https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot",
		global: null,
		project: ".github/copilot-instructions.md",
		detect: null,
		note:
			"Project-only. Copilot also reads AGENTS.md/CLAUDE.md/GEMINI.md natively.",
		hooks: { event: "sessionStart", configFile: ".copilot/hooks/hooks.json" },
	};
