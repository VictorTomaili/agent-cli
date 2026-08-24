// src/targets/windsurf.js — one-file target descriptor for "windsurf".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "windsurf",
		name: "Windsurf",
		docs: "https://docs.windsurf.com/windsurf/cascade/rules",
		global: null,
		project: ".windsurf/rules/agent-cli.md",
		detect: ".windsurf",
		note: "Also writes legacy .windsurfrules for older versions.",
		legacyProject: ".windsurfrules",
		hooks: {
			event: "pre_user_prompt",
			configFile: ".codeium/windsurf/hooks.json",
			note:
				"Cascade lacks SessionStart; we use pre_user_prompt as the nearest lifecycle hook.",
		},
	};
