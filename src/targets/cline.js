// src/targets/cline.js — one-file target descriptor for "cline".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "cline",
		name: "Cline / Roo Code",
		docs: "https://docs.cline.bot/prompting/cline-rules",
		global: ".cline/rules/agent-cli.md",
		project: ".clinerules/agent-cli.md",
		detect: ".cline",
		note: "Reads all .md/.txt in the rules dir. Roo Code uses the same format.",
		hooks: { event: "SessionStart", configFile: ".clinerules/hooks/hooks.json" },
	};
