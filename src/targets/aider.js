// src/targets/aider.js — one-file target descriptor for "aider".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "aider",
		name: "Aider",
		docs: "https://aider.chat/docs/config/options.html",
		global: null,
		project: "CONVENTIONS.md",
		detect: ".aider",
		note:
			"CONVENTIONS.md is read into context; .aider.conf.yml is separate config.",
	};
