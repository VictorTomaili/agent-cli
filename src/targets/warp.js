// src/targets/warp.js — one-file target descriptor for "warp".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "warp",
		name: "Warp",
		docs: "https://docs.warp.dev/features/agents-md",
		global: null,
		project: "AGENTS.md",
		detect: ".warp",
		note: "Warp uses the agents.md standard (project root).",
	};
