// src/store.js — the canonical master file (~/.agents/AGENTS.md): seed, read, write.

import path from "node:path";
import {
	MASTER_FILE,
	AGENTS_DIR,
	HOME,
	exists,
	readFile,
	readIfExists,
	writeFile,
	ensureDir,
	pretty,
} from "./util.js";
import { ensureBlocks } from "./blocks.js";

// Candidate sources to seed the master from (home-relative), richest first.
const SEED_CANDIDATES = [
	".pi/agent/AGENTS.md",
	".codex/AGENTS.md",
	".claude/CLAUDE.md",
	".gemini/GEMINI.md",
	".qwen/QWEN.md",
];

export async function masterExists() {
	return exists(MASTER_FILE);
}

export async function readMaster() {
	return readIfExists(MASTER_FILE);
}

export async function writeMaster(content) {
	await ensureDir(AGENTS_DIR);
	const out = content.endsWith("\n") ? content : content + "\n";
	await writeFile(MASTER_FILE, out);
}

/** Find the richest existing source file and return {rel, content} or null. */
export async function findSeedSource() {
	for (const rel of SEED_CANDIDATES) {
		const full = path.join(HOME, rel);
		if (await exists(full)) {
			const content = await readFile(full);
			if (content && content.trim().length > 20) {
				return { rel, content };
			}
		}
	}
	return null;
}

const STARTER = `# AGENTS.md — canonical source (managed by agent-cli)

> This single file is shared with all your coding agents via pointer stubs.
> Edit it freely; no re-sync needed. Run \`agent link\` to (re)deploy pointers.

## Conventions
- (describe your stack, structure, and conventions here)

## Sub-agents & delegation
- Prefer specialized sub-agents by default. Discover an existing role, reuse it; otherwise author a reusable role, then delegate. The main agent plans, orchestrates, and verifies.

## SPECT task-start guidance
- SPECT is optional. If the user explicitly requests specification-driven development, run agent spect init in the project directory when it is absent.
- If the project already has .spect, read its README, constitution, and relevant spec/plan/task files and follow its loop.
- For ordinary tasks, do not initialize SPECT or create .spect automatically. If SPECT would materially help, explain the option and ask the user before initializing it.
- When SPECT is active, use this loop: specify → plan → decompose → implement one task → verify acceptance criteria → review for bugs → refactor → re-verify. Failed checks return to implementation.

## Tool-call mediation (host/orchestrator guidance)
- The host executes tools; agent-cli provides no model runtime. Call the tool directly first.
- On failure, apply deterministic fixes first: validate the schema, normalize safe paths/arguments, and retry only transient errors with a strict limit (normally one or two retries).
- If deterministic repair fails, an agent may ask its cheap repair model to propose corrected arguments from a structured envelope containing the tool name, arguments, error, and relevant context. Validate the proposal before retrying; never let it bypass permissions, confirmations, or path/input safety.
- For large successful output, an agent may use a cheap summarizer. Preserve the raw output, state what was omitted, and keep errors/identifiers/actionable details verbatim.
- Never expose secrets unnecessarily, never retry indefinitely, and do not use a model for deterministic errors. Record the final tool result and any repair attempt in the task context.

## Model aliases
- Personalities use aliases (\`model: coding-model\`), not provider IDs. \`MODELS.md\` stores tagged <ALIAS> entries with ordered fallbacks for transient API outage, rate limits, and usage limits. The using agent decides when to fail over; avoid infinite retries.

## Build & test
- Build:
- Test:
- Lint:
`;

/**
 * Ensure the master exists, seeding from the richest existing source if possible.
 * Always guarantees both managed blocks (agent-cli + skill-cli) are present.
 * Returns { action: 'exists'|'seeded'|'starter', seed: rel|null, changed: bool }.
 */
export async function ensureMaster() {
	if (await masterExists()) {
		const c = await readMaster();
		// Guard: never inject blocks into an empty/corrupt master — that would wipe it
		// to blocks-only. A real master always has headings + substance.
		if (!c || c.trim().length < 200 || !c.includes("## ")) {
			return {
				action: "exists",
				seed: null,
				changed: false,
				skipped: "master-too-small",
			};
		}
		const merged = ensureBlocks(c);
		const changed = merged !== c;
		if (changed) await writeMaster(merged);
		return { action: "exists", seed: null, changed };
	}
	const found = await findSeedSource();
	if (found) {
		const merged = ensureBlocks(found.content);
		await writeMaster(merged);
		return { action: "seeded", seed: found.rel, changed: true };
	}
	await writeMaster(ensureBlocks(STARTER));
	return { action: "starter", seed: null, changed: true };
}

/** Re-merge managed blocks into the current master (used by `agent skill refresh`). */
export async function refreshBlocks() {
	const c = await readMaster();
	if (c == null) return { changed: false, reason: "no-master" };
	// Guard: skip if the master looks empty/corrupt (avoid blocks-only wipe).
	if (c.trim().length < 200 || !c.includes("## ")) {
		return { changed: false, reason: "master-too-small-skipped" };
	}
	const merged = ensureBlocks(c);
	if (merged !== c) {
		await writeMaster(merged);
		return { changed: true };
	}
	return { changed: false };
}

export function masterPath() {
	return MASTER_FILE;
}

export function masterTilde() {
	return pretty(MASTER_FILE);
}
