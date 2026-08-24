// src/commands/instructions.js — `agent-cli instructions [--json] [--md]`.
//
// The canonical LLM-facing guide to the CLI (see src/instructions.js). The
// output is short enough to paste into a system prompt and dense enough to
// navigate without rereading the README. Aliases: `prompt`, `for-llm`,
// `guide`.
//
// This command is registered BEFORE the catch-all bare `agent-cli` action so
// it wins the Commander matching; the bare action's "Unknown command" path
// (which suggests closest matches via levenshtein.js) covers the typos.

import {
	INSTRUCTIONS_MARKDOWN,
	INSTRUCTIONS_TOPICS,
	INSTRUCTIONS_BYTE_LENGTH,
	INSTRUCTIONS_CORE_COMMANDS,
} from "../instructions.js";

/** Lightweight Levenshtein distance — bounded input length to keep the
 *  suggestion pass O(n·m) cheap. Adapted from the classic Wagner-Fischer
 *  dynamic-programming row reduction; small enough to inline here so the
 *  CLI has no extra dependency for this one feature. */
export function levenshtein(a, b, cap = 5) {
	if (typeof a !== "string" || typeof b !== "string") return Infinity;
	const la = a.length;
	const lb = b.length;
	if (Math.abs(la - lb) > cap) return cap + 1;
	if (!la) return lb;
	if (!lb) return la;
	let prev = new Array(lb + 1);
	let curr = new Array(lb + 1);
	for (let j = 0; j <= lb; j++) prev[j] = j;
	for (let i = 1; i <= la; i++) {
		curr[0] = i;
		let rowMin = curr[0];
		for (let j = 1; j <= lb; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(
				curr[j - 1] + 1,
				prev[j] + 1,
				prev[j - 1] + cost,
			);
			if (curr[j] < rowMin) rowMin = curr[j];
		}
		if (rowMin > cap) return cap + 1;
		[prev, curr] = [curr, prev];
	}
	return prev[lb];
}

/** Find the closest match (or matches) to `query` among `candidates`, using
 *  Levenshtein distance. Returns up to `maxSuggestions` strings in order of
 *  closeness. Returns [] when no candidate is within `cap` edits. */
export function closestMatches(query, candidates, { maxSuggestions = 3, cap = 4 } = {}) {
	const ranked = candidates
		.map((c) => ({ name: c, d: levenshtein(query, c, cap) }))
		.filter((r) => r.d <= cap)
		.sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
	return ranked.slice(0, maxSuggestions).map((r) => r.name);
}

/** Register the `instructions` / `guide` / `for-llm` command.
 *  Note: `prompt` is NOT an alias — it's the dynamic, state-aware counterpart
 *  registered by src/commands/prompt.js. The static guide here is the
 *  reference; `prompt` is the per-session orientation message. */
export function registerInstructionsCommand(program, { emit, log, c, pretty, isJson, VERSION }) {
	const cmd = program
		.command("instructions")
		.description(
			"Print the canonical LLM-facing guide to agent-cli (Markdown). Aliases: guide, for-llm. Pass --json for the structured envelope.",
		)
		.alias("guide")
		.alias("for-llm")
		.option(
			"--md",
			"force Markdown output even under --json (default output is plain Markdown)",
		)
		.option(
			"--topics-only",
			"print only the topic list (one per line) — useful when you only need to know what the guide covers",
		)
		.option(
			"--commands-only",
			"print only the core-command quick-reference — useful when you only need the command list",
		)
		.action((opts) => {
			if (opts.topicsOnly) {
				if (isJson()) {
					emit({
						command: "instructions",
						topics: INSTRUCTIONS_TOPICS,
					});
				} else {
					process.stdout.write(INSTRUCTIONS_TOPICS.join("\n") + "\n");
				}
				return;
			}
			if (opts.commandsOnly) {
				if (isJson()) {
					emit({
						command: "instructions",
						coreCommands: INSTRUCTIONS_CORE_COMMANDS,
					});
				} else {
					process.stdout.write(INSTRUCTIONS_CORE_COMMANDS.join("\n") + "\n");
				}
				return;
			}
			const payload = {
				command: "instructions",
				content: INSTRUCTIONS_MARKDOWN,
				topics: INSTRUCTIONS_TOPICS,
				coreCommands: INSTRUCTIONS_CORE_COMMANDS,
				version: VERSION,
				byteLength: INSTRUCTIONS_BYTE_LENGTH,
			};
			if (isJson() && !opts.md) {
				emit(payload);
				return;
			}
			// Human mode (or --md under --json): just the Markdown.
			if (!isJson()) {
				log.info(
					`agent-cli v${VERSION} — canonical LLM guide (${INSTRUCTIONS_BYTE_LENGTH} bytes).`,
				);
				log.dim(
					`Pass --json for the structured envelope. Aliases: prompt, guide, for-llm.`,
				);
				log.raw("");
				process.stdout.write(INSTRUCTIONS_MARKDOWN);
				if (!INSTRUCTIONS_MARKDOWN.endsWith("\n")) process.stdout.write("\n");
				return;
			}
			// --json + --md: emit the Markdown as a string field on the envelope.
			emit(payload);
		});

	return cmd;
}

/** Surface a "Did you mean: …" suggestion when the user types an unknown
 *  command. Mutates the error message to include the closest match, when one
 *  is within `cap` edits. Pure helper — exported for tests. */
export function suggestCommand(name, candidates, { maxSuggestions = 3, cap = 4 } = {}) {
	const matches = closestMatches(name, candidates, { maxSuggestions, cap });
	if (!matches.length) return null;
	return `Did you mean: ${matches.map((m) => `\`agent-cli ${m}\``).join(", ")}?`;
}