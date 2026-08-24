// src/targets/zed.js — one-file target descriptor for "zed".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "zed",
		name: "Zed AI",
		docs: "https://zed.dev/docs/ai/overview",
		global: null,
		project: "AGENTS.md",
		detect: ".zed",
		note: "Zed reads the standard AGENTS.md.",
	};
