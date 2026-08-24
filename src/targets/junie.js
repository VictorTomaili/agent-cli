// src/targets/junie.js — one-file target descriptor for "junie".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "junie",
		name: "JetBrains Junie",
		docs: "https://www.jetbrains.com/junie/",
		global: null,
		project: ".junie/guidelines.md",
		detect: ".junie",
		hooks: { event: "SessionStart", configFile: ".junie/config.json" },
	};
