// src/commands/prompt.js — `agent-cli prompt [--json] [--for "<task>"]`.
//
// The DYNAMIC counterpart to `agent-cli instructions`. While `instructions`
// prints a static guide for any reader, `prompt` inspects the user's actual
// state and emits a concise system-prompt block tailored to:
//   - which tools are detected / enabled / linked
//   - what's missing in the brain (identity archetype, USER/SOUL/ENV fields)
//   - what actions are pending (the same ordered list `brief --plan` reports)
//   - what skills and capabilities are available
//
// Goal: an LLM starting a session runs `agent-cli --json prompt` ONCE, pastes
// the result into its system prompt, and is fully oriented. Subsequent
// `brief --json` calls (per turn) keep it current.

// isSkillAvailable: removed (unused in this command's surface; the function
// is referenced indirectly via the brief's suggestedStrings path).
// import { isSkillAvailable } from "../skill.js";

/** Register the `prompt` command. */
export function registerPromptCommand(program, { emit, fail, log, c, pretty, isJson, VERSION }) {
	program
		.command("prompt")
		.description(
			"Dynamic system-prompt recommendation for AI agents driving this CLI. Inspects your installed tools, brain state, and pending actions; outputs a Markdown block ready for a system-prompt slot. Use --json for the structured envelope; ----for <task> for task-aware retrieval.",
		)
		.option(
			"--for <task>",
			"task-aware retrieval: bias the prompt toward relevant tools/commands and include matching lessons/master excerpts",
		)
		.option("--md", "force Markdown output under --json (default under --json is the structured envelope)")
		.action(async (opts) => {
			// Collect state the same way brief/run do, so the prompt and the
			// brief agree on what's installed and what's pending. Offline by
			// default — prompt rendering must never block on the network.
			const actionsMod = await import("../actions.js");
			const s = await actionsMod.collectState({
				cwd: process.cwd(),
				offline: true,
				pkgName: "@victortomaili/agent-cli",
			});

			// Task-aware: pull relevant hits from the brain.
			let forTaskHits = null;
			const taskQuery = opts.for || null;
			if (taskQuery) {
				const searchMod = await import("../search.js");
				const sr = await searchMod.searchAll(taskQuery, { project: true });
				forTaskHits = sr.results.slice(0, 5).map((r) => ({
					path: r.path,
					title: r.title || null,
					snippet: r.snippet || null,
					score: r.score,
				}));
			}

			const { buildPromptPayload } = await import("../prompt-report.js");
			const payload = buildPromptPayload(s, {
				version: VERSION,
				forTask: taskQuery,
				forTaskHits,
			});

			if (isJson() && !opts.md) {
				emit({
					command: "prompt",
					content: payload.content,
					sections: payload.sections,
					metadata: payload.metadata,
				});
				return;
			}
			if (!isJson()) {
				log.info(
					`agent-cli v${VERSION} — dynamic prompt (${payload.content.length} bytes, ${payload.metadata.pendingActions.length} pending actions)`,
				);
				if (taskQuery) log.dim(`task: ${taskQuery}`);
				log.raw("");
				process.stdout.write(payload.content);
				return;
			}
			// --json + --md: include the Markdown as the structured `content` field.
			emit({
				command: "prompt",
				content: payload.content,
				metadata: payload.metadata,
			});
		});
}