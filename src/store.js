// src/store.js — the canonical master file (~/AGENTS.md): seed, read, write.

import path from "node:path";
import {
	MASTER_FILE,
	POINTER_MASTER_FILE,
	AGENTS_DIR,
	HOME,
	exists,
	readFile,
	readIfExists,
	writeFile,
	ensureDir,
	pretty,
	normalizeEndings,
} from "./util.js";
import { ensureBlocks } from "./blocks.js";

import {
	masterPointerContent,
	parseMasterPointer,
} from "./pointer.js";


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
	await ensureDir(path.dirname(MASTER_FILE));
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
			// MIGRATION: ~/AGENTS.md holds only a pointer stub (the pre-0.3
			// layout), while the real master content still lives at
			// ~/.agents/AGENTS.md. Adopt the old master so upgrading an existing
			// install never strands the user's content.
			const old = await readIfExists(POINTER_MASTER_FILE);
			// Adopt only if the old file looks like a REAL master (headings +
			// substance), never a pointer stub or an empty template.
			if (old && old.trim().length >= 40 && old.includes("## ")) {
				// A buggy old `link` run may have prepended a pointer-stub header
				// onto the master itself; strip it so the adopted content is clean.
				const cleaned = stripStrayPointerHeader(old);
				const merged = ensureBlocks(cleaned);
				await writeMaster(merged);
				return {
					action: "migrated",
					seed: ".agents/AGENTS.md",
					changed: true,
					from: POINTER_MASTER_FILE,
				};
			}
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

/**
 * Remove a pointer-stub header that was mistakenly prepended onto a master
 * file (a buggy old `link` run wrote the stub block above the real content).
 * The stub block starts with `<!-- agent-cli-pointer -->` and contains the
 * "pointer stub" marker; anything before the first `## ` heading or
 * `<!-- BEGIN` is dropped when it looks like a stub, not real content.
 */
export function stripStrayPointerHeader(content) {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "<!-- agent-cli-pointer -->") return content;
	// Find the first line that begins real master content: a `## ` heading or a
	// managed-block marker. A `# ` title alone is ambiguous (the stub itself has
	// one), so we require a heading/block marker, not just any # line.
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i].trim();
		if (t.startsWith("## ") || t.startsWith("<!-- BEGIN")) {
			start = i;
			break;
		}
	}
	// Only strip if the block above actually contains the stub marker.
	if (start <= 0) return content;
	const stubBlock = lines.slice(0, start).join("\n");
	if (!/pointer stub/i.test(stubBlock)) return content;
	return lines.slice(start).join("\n");
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
/**
 * Ensure the agent-cli self-pointer stub at POINTER_MASTER_FILE
 * (~/.agents/AGENTS.md) exists and points at MASTER_FILE (~/AGENTS.md).
 *
 * - If the file is missing → write a fresh stub. Returns { action: "created" }.
 * - If the file IS a master-pointer stub but stale → overwrite. Returns { action: "updated" }.
 * - If the file IS a master-pointer stub and current → skip. Returns { action: "skipped" }.
 * - If the file exists and is NOT a master-pointer stub (native content) → refuse
 *   unless force=true. Returns { skipped: "native-content" } or { action: "overwritten" }.
 */
export async function ensureMasterPointer({
	masterAbs = MASTER_FILE,
	masterTilde: tilde = pretty(MASTER_FILE),
	force = false,
} = {}) {
	await ensureDir(AGENTS_DIR);
	const existing = await readIfExists(POINTER_MASTER_FILE);
	const desired = masterPointerContent({ masterAbs, masterTilde: tilde });
	if (existing == null) {
		await writeFile(POINTER_MASTER_FILE, desired);
		return {
			path: POINTER_MASTER_FILE,
			action: "created",
			masterAbs,
			masterTilde: tilde,
		};
	}
	const parsed = parseMasterPointer(existing);
	if (!parsed) {
		if (!force) {
			return {
				path: POINTER_MASTER_FILE,
				skipped: "native-content",
				hint: "agent init --force",
			};
		}
		await writeFile(POINTER_MASTER_FILE, desired);
		return {
			path: POINTER_MASTER_FILE,
			action: "overwritten",
			masterAbs,
			masterTilde: tilde,
		};
	}
	const same =
		normalizeEndings(existing).trim() === normalizeEndings(desired).trim();
	if (same) {
		return {
			path: POINTER_MASTER_FILE,
			action: "skipped",
			masterAbs,
			masterTilde: tilde,
		};
	}
	await writeFile(POINTER_MASTER_FILE, desired);
	return {
		path: POINTER_MASTER_FILE,
		action: "updated",
		masterAbs,
		masterTilde: tilde,
	};
}

/** Classify the current state of the self-pointer stub. */
export async function classifyMasterPointer() {
	const existing = await readIfExists(POINTER_MASTER_FILE);
	if (existing == null) return { path: POINTER_MASTER_FILE, state: "missing" };
	const parsed = parseMasterPointer(existing);
	if (!parsed) return { path: POINTER_MASTER_FILE, state: "native" };
	const desired = masterPointerContent({
		masterAbs: parsed.masterAbs,
		masterTilde: parsed.masterTilde,
	});
	return {
		path: POINTER_MASTER_FILE,
		state:
			normalizeEndings(existing).trim() ===
			normalizeEndings(desired).trim()
				? "pointer"
				: "pointer-stale",
	};
}

export function masterPath() {
	return MASTER_FILE;
}

export function masterTilde() {
	return pretty(MASTER_FILE);
}
