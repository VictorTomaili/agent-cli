// src/targets/qwen.js — one-file target descriptor for "qwen".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "qwen",
		name: "Qwen Code",
		docs: "https://qwenlm.github.io/qwen-code-docs/",
		global: ".qwen/QWEN.md",
		project: "QWEN.md",
		detect: ".qwen",
	};
