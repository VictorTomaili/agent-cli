// src/targets.js — the registry of supported AI coding agents and their config-file locations.
//
// Sources: agents.md standard (Linux Foundation), official docs per tool, and the
// cross-tool comparison at https://amux.io/guides/agent-config-files-compared (2026).
//
// Each target describes:
//   id            short stable id (cli-facing)
//   name          human label
//   docs          canonical docs url
//   global        home-relative path for the user-level file, or null if unsupported
//   project       cwd-relative path for the project-level file, or null
//   detect        home-relative marker (dir/file) whose presence implies the agent is
//                 installed; null if detection is unreliable
//   note          short caveats (shared paths, frontmatter, legacy files)
//   transform     optional (content, ctx) => string  to adapt master content to native format

/** Cursor .mdc needs YAML frontmatter with alwaysApply so the rule is always loaded. */
function cursorTransform(content) {
	return [
		"---",
		"description: Synced by agent-cli from ~/.agents/AGENTS.md",
		"alwaysApply: true",
		"---",
		"",
		content,
	].join("\n");
}

export const TARGETS = [
	{
		id: "claude",
		name: "Claude Code",
		docs: "https://docs.claude.com/en/docs/claude-code/memory",
		global: ".claude/CLAUDE.md",
		project: "CLAUDE.md",
		detect: ".claude",
	},
	{
		id: "codex",
		name: "OpenAI Codex",
		docs: "https://developers.openai.com/codex/",
		global: ".codex/AGENTS.md",
		project: "AGENTS.md",
		detect: ".codex",
	},
	{
		id: "pi",
		name: "pi coding agent",
		docs: "https://github.com/earendil-works/pi",
		global: ".pi/agent/AGENTS.md",
		project: "AGENTS.md",
		detect: ".pi",
	},
	{
		id: "gemini",
		name: "Gemini CLI / Code Assist / Antigravity",
		docs: "https://developers.google.com/gemini-code-assist/docs",
		global: ".gemini/GEMINI.md",
		project: "GEMINI.md",
		detect: ".gemini",
		note: "Shared by Gemini CLI, Gemini Code Assist, and Google Antigravity IDE.",
	},
	{
		id: "qwen",
		name: "Qwen Code",
		docs: "https://qwenlm.github.io/qwen-code-docs/",
		global: ".qwen/QWEN.md",
		project: "QWEN.md",
		detect: ".qwen",
	},
	{
		id: "cursor",
		name: "Cursor",
		docs: "https://docs.cursor.com/context/rules",
		global: null,
		project: ".cursor/rules/agent-cli.mdc",
		detect: ".cursor",
		note: "Writes an alwaysApply .mdc rule. Cursor has no user-level rules file.",
		transform: cursorTransform,
	},
	{
		id: "windsurf",
		name: "Windsurf",
		docs: "https://docs.windsurf.com/windsurf/cascade/rules",
		global: null,
		project: ".windsurf/rules/agent-cli.md",
		detect: ".windsurf",
		note: "Also writes legacy .windsurfrules for older versions.",
		legacyProject: ".windsurfrules",
	},
	{
		id: "cline",
		name: "Cline / Roo Code",
		docs: "https://docs.cline.bot/prompting/cline-rules",
		global: ".cline/rules/agent-cli.md",
		project: ".clinerules/agent-cli.md",
		detect: ".cline",
		note: "Reads all .md/.txt in the rules dir. Roo Code uses the same format.",
	},
	{
		id: "copilot",
		name: "GitHub Copilot",
		docs: "https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot",
		global: null,
		project: ".github/copilot-instructions.md",
		detect: null,
		note: "Project-only. Copilot also reads AGENTS.md/CLAUDE.md/GEMINI.md natively.",
	},
	{
		id: "aider",
		name: "Aider",
		docs: "https://aider.chat/docs/config/options.html",
		global: null,
		project: "CONVENTIONS.md",
		detect: ".aider",
		note: "CONVENTIONS.md is read into context; .aider.conf.yml is separate config.",
	},
	{
		id: "junie",
		name: "JetBrains Junie",
		docs: "https://www.jetbrains.com/junie/",
		global: null,
		project: ".junie/guidelines.md",
		detect: ".junie",
	},
	{
		id: "trae",
		name: "Trae",
		docs: "https://docs.trae.ai/",
		global: null,
		project: ".trae/rules/agent-cli.md",
		detect: ".trae",
	},
	{
		id: "zed",
		name: "Zed AI",
		docs: "https://zed.dev/docs/ai/overview",
		global: null,
		project: "AGENTS.md",
		detect: ".zed",
		note: "Zed reads the standard AGENTS.md.",
	},
	{
		id: "warp",
		name: "Warp",
		docs: "https://docs.warp.dev/features/agents-md",
		global: null,
		project: "AGENTS.md",
		detect: ".warp",
		note: "Warp uses the agents.md standard (project root).",
	},
	{
		id: "opencode",
		name: "OpenCode",
		docs: "https://opencode.ai/",
		global: null,
		project: "AGENTS.md",
		detect: ".opencode",
		note: "OpenCode reads AGENTS.md.",
	},
	{
		id: "goose",
		name: "Goose (Block)",
		docs: "https://block.github.io/goose/",
		global: null,
		project: ".goose/hints",
		detect: ".goose",
		note: "Goose reads .goose/hints and AGENTS.md.",
	},
];

/** Quick id -> target lookup. */
export const TARGET_MAP = Object.fromEntries(TARGETS.map((t) => [t.id, t]));

export function getTarget(id) {
	return TARGET_MAP[id] ?? null;
}

export function knownIds() {
	return TARGETS.map((t) => t.id);
}

/** Native path for a target in a given scope, or null if unsupported. */
export function pathFor(target, scope) {
	if (scope === "global") return target.global ?? null;
	if (scope === "project") return target.project ?? null;
	return null;
}

/** All scopes a target supports. */
export function scopesFor(target) {
	const scopes = [];
	if (target.global) scopes.push("global");
	if (target.project) scopes.push("project");
	return scopes;
}

/** Targets that support a given scope. */
export function targetsWithScope(scope) {
	return TARGETS.filter((t) => pathFor(t, scope));
}

/**
 * Adapt master content to a target's native format (e.g. Cursor frontmatter).
 * ctx = { scope }.
 */
export function adaptContent(target, content, ctx) {
	if (typeof target.transform === "function") {
		return target.transform(content, ctx);
	}
	return content;
}
