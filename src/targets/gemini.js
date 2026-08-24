// src/targets/gemini.js — one-file target descriptor for "gemini".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "gemini",
		name: "Gemini CLI / Code Assist / Antigravity",
		docs: "https://developers.google.com/gemini-code-assist/docs",
		global: ".gemini/GEMINI.md",
		project: "GEMINI.md",
		detect: ".gemini",
		note: "Shared by Gemini CLI, Gemini Code Assist, and Google Antigravity IDE.",
		hooks: { event: "SessionStart", configFile: ".gemini/settings.json" },
	};
