// src/prompt-report.js — dynamic system-prompt recommendation for an LLM driving
// the CLI.
//
// `agent-cli instructions` (src/instructions.js) prints a STATIC guide: the
// same Markdown every run, regardless of which tools are installed, what's
// missing in the brain, or what actions are pending. Useful as a reference;
// not as a session-startup message.
//
// This module builds the COMPLEMENT: a DYNAMIC prompt tailored to the user's
// actual setup. It consumes the same `collectState()` payload that
// brief-report.js consumes, so the picture is consistent across all surfaces.
// The output is short enough to fit at the top of a system-prompt slot
// (~600–1,200 tokens depending on state) and only mentions commands the LLM
// actually needs.

import { buildActions, suggestedStrings } from "./actions.js";
import { isSkillAvailable } from "./skill.js";
import { pretty } from "./util.js";

/**
 * @param {object} s - state from actions.js#collectState(...)
 * @param {object} [opts]
 * @param {string} opts.version - installed agent-cli version string
 * @param {string|null} [opts.forTask] - optional task description; biases the
 *   prompt toward tools/commands relevant to the task via searchSearch.
 * @param {object} [opts.forTaskHits] - search hits when forTask is set
 * @returns {{ content: string, sections: string[], metadata: object }}
 *   - content: the prompt-ready Markdown block
 *   - sections: each rendered heading (for JSON consumers who want to inspect
 *     a specific section without parsing Markdown)
 *   - metadata: structured facts the agent can reference (state version,
 *     installed tools, pending actions, etc.)
 */
export function buildPromptPayload(s, { version, forTask = null, forTaskHits = null } = {}) {
	const actions = buildActions(s);
	const suggested = suggestedStrings(actions);

	const sections = [];
	const metadata = {
		version,
		health: s.masterContent == null ? "degraded" : "ready",
		tools: {
			enabled: s.cfg.global,
			installed: s.installed,
		},
		pendingActions: actions.map((a) => ({
			id: a.id,
			command: a.command === "agent-cli" ? `agent-cli ${a.args.join(" ")}` : `${a.command} ${a.args.join(" ")}`,
			severity: a.severity,
			safeToAutomate: !!a.safeToAutomate,
			reason: a.reason,
		})),
		warnings: [],
		missingBrainFields: s.onboarding?.gaps || {},
	};

	// Section 1: Identity. Tells the LLM who they are and which tool they drive.
	{
		const installed = s.installed ?? [];
		const enabled = s.cfg.global ?? [];
		const installedList =
			installed.length === 0
				? "(none detected — see `agent-cli targets` for the catalog)"
				: installed.join(", ");
		const enabledList = enabled.length === 0 ? "(none enabled)" : enabled.join(", ");
		const toolCount = installed.length;
		const section = `# agent-cli system prompt (v${version})

You are driving an end-user's AI tooling through \`agent-cli\`. The user's master
instructions file lives at \`~/.agents/AGENTS.md\` (project scope: \`[cwd]/.agents/AGENTS.md\`)
and is mirrored via pointer stubs to every AI coding tool they have installed.

## Your environment

- **Detected coding tools** (${toolCount}): ${installedList}
- **Enabled + linked tools** (${enabled.length}): ${enabledList}
- **Skill manager**: ${isSkillAvailable() ? "available (`agent-cli skill ...`)" : "not installed"}
- **Brain health**: ${metadata.health}${s.archetypeNeeded ? " (identity onboarding incomplete)" : ""}`;
		sections.push(section);
	}

	// Section 2: Hard rules. Same as the static instructions doc — non-negotiable.
	{
		const section = `## Hard rules

1. **Always pass \`--json\`.** Treat the envelope as the contract.
2. **Never edit \`~/.agents/\` files by hand.** Use the per-file \`set\` commands.
3. **Never bypass the locked config write.** Use \`target enable/disable\`.
4. **Treat secrets as secrets.** Use \`agent-cli secret set/get/list/rm\`.
5. **Never clobber user prose.** If a tag is empty but the surrounding prose has
   the same content, leave the prose; just add the tag.
6. **Read the envelope's \`updateNotice\` field every time.** When the installed
   version is below latest, tell the user and offer to run
   \`npm i -g @victortomaili/agent-cli@latest\`.`;
		sections.push(section);
	}

	// Section 3: Pending actions. Only emitted when there ARE pending actions.
	if (actions.length > 0) {
		const top = actions.slice(0, 5); // cap to top 5; further detail via --json
		const lines = top.map((a) => {
			const cmd =
				a.command === "agent-cli"
					? `\`agent-cli ${a.args.join(" ")}\``
					: `\`${a.command} ${a.args.join(" ")}\``;
			const tag = a.safeToAutomate ? "safe-to-automate" : "user-action";
			return `- ${a.severity} (${tag}) — ${a.reason} → ${cmd}`;
		});
		sections.push(`## Pending actions (top ${top.length})

${lines.join("\n")}

For the full ordered list with preconditions and verifications:
\`\`\`bash
agent-cli --json brief --plan
\`\`\``);
		metadata.warnings.push(`${actions.length} pending action(s)`);
	}

	// Section 4: Missing brain fields. Only when archetype/gaps exist.
	const gaps = s.onboarding?.gaps || {};
	const gapKeys = Object.keys(gaps);
	if (gapKeys.length > 0) {
		const lines = gapKeys.map((kind) => {
			const fields = gaps[kind];
			return `- **${kind}.md**: missing ${fields.join(", ")}`;
		});
		sections.push(`## Brain gaps

${lines.join("\n")}

Ask the user one gap at at time. Never invent values. Use the per-field
\`set\` commands to fill them: \`agent-cli identity/soul/user/env set <FIELD> "<value>"\`.`);
	}

	// Section 5: Optional task-aware context. Helps the LLM pick the right tool.
	if (forTask) {
		const hits = forTaskHits ?? [];
		const hitLines =
			hits.length === 0
				? ["(no matching lessons/master content for this task)"]
				: hits.slice(0, 3).map((h) => `- \`${h.path}\`: ${h.title || h.snippet || "(hit)"}`);
		sections.push(`## Task-aware context

Task: \`${forTask}\`

${hitLines.join("\n")}

\`agent-cli --json brief --for "${forTask}"\` re-prints this with fresh retrieval.`);
	}

	// Section 6: Common commands cheat sheet — only the ones relevant to this user.
	{
		const installedSet = new Set(s.installed ?? []);
		const cmds = [
			"`agent-cli --json brief` — start every turn with this; it returns the canonical state",
			"`agent-cli --json doctor` — full diagnostic with issues + checks",
			"`agent-cli instructions` — full static reference (the long-form version of this prompt)",
		];
		if (!isSkillAvailable()) cmds.push("`agent-cli skill setup` — install the skill manager");
		if (actions.some((a) => a.id.startsWith("link:"))) {
			cmds.push("`agent-cli link` — repair pointer stubs for drifted tools");
		}
		if (actions.some((a) => a.id === "init")) cmds.push("`agent-cli init` — bootstrap");
		if (s.onboarding?.nextSuggestion) {
			cmds.push(
				`\`agent-cli onboard suggest\` — next gap question: ${s.onboarding?.nextSuggestion?.question || "(see brief)"}`,
			);
		}
		if (installedSet.has("claude") || installedSet.has("codex")) {
			cmds.push("`agent-cli brief-hooks install` — wire SessionStart so each tool calls `brief` on open");
		}
		cmds.push("`agent-cli --json manifest` — full command tree");
		sections.push(`## Common commands for this setup

${cmds.map((c) => `- ${c}`).join("\n")}`);
	}

	const content = sections.join("\n\n") + "\n";
	return { content, sections, metadata };
}