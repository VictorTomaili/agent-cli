// src/targets/deepseek.js — one-file target descriptor for "deepseek".
// Adding a new target? Drop a similar file in src/targets/ and add one line to
// src/targets/index.js — see that file's header for the recipe.

export default {
		id: "deepseek",
		name: "DeepSeek Harness",
		docs: "https://github.com/deepseek-ai/deepseek-harness",
		global: ".dsh/AGENTS.md",
		project: "AGENTS.md",
		detect: ".dsh",
		// DSH's agent-instructions plugin reads `$DSH_HOME/AGENTS.md`
		// (default `~/.dsh/AGENTS.md`; $DSH_HOME is its single source of truth
		// per @deepseek-ai/dsh-home-paths), then walks from the project root
		// (nearest .git ancestor) to cwd reading AGENTS.md and CLAUDE.md.
		// No native SessionStart hook — DSH is plugin-based, and the optional
		// Codex/Claude hooks bridges consume the Claude/Codex JSON configs
		// (already covered by their own targets). The pointer stub IS the
		// session-start integration: DSH picks the brief up through its own
		// instruction loader on the first agent/pre-step.
		note:
			"DSH home defaults to ~/.dsh; honors $DSH_HOME. Reads CLAUDE.md too. No native SessionStart hook — use `agent-cli link skills` for cross-tool sharing instead.",
		// Cross-tool sharing (agent-cli `link skills`):
		//   ~/.dsh/skills      DSH's user skill root (skill-filesystem user-dsh).
		//                       Link to ~/.skill-cli/store so every installed
		//                       skill appears in DSH immediately. DSH also
		//                       reads the shared ~/.agents/skills user-agents
		//                       root (the skill hub `link skills` always
		//                       maintains), so no separate `share.skills` for
		//                       that path is needed.
		// No `share.agents`: DSH sub-agents are runtime Agent objects, not
		// on-disk persona files; there is no DSH-native directory to link.
		share: { skills: ".dsh/skills" },
	};
