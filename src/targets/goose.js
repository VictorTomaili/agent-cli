// src/targets/goose.js — one-file target descriptor for "goose".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "goose",
		name: "Goose (Block)",
		docs: "https://block.github.io/goose/",
		global: null,
		project: ".goose/hints",
		detect: ".goose",
		note: "Goose reads .goose/hints and AGENTS.md.",
		hooks: { event: "SessionStart", configFile: ".config/goose/config.yaml" },
	};
