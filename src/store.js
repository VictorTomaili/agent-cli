// src/store.js — the canonical master file (~/AGENTS.md): seed, read, write.

import path from "node:path";
import {
	MASTER_FILE,
	HOME_POINTER_FILE,
	AGENTS_DIR,
	BACKUP_DIR,
	HOME,
	exists,
	readFile,
	readIfExists,
	writeFile,
	ensureDir,
	pretty,
	normalizeEndings,
	fsp,
} from "./util.js";
import { ensureBlocks } from "./blocks.js";

import {
	masterPointerContent,
	parseMasterPointer,
	POINTER_MARK,
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
> Edit it freely; no re-sync needed. Run \`agent-cli link\` to (re)deploy pointers.

## Conventions
- (describe your stack, structure, and conventions here)

## Sub-agents & delegation
- Prefer specialized sub-agents by default. Discover an existing role, reuse it; otherwise author a reusable role, then delegate. The main agent plans, orchestrates, and verifies.

## SPECT task-start guidance
- SPECT is optional. If the user explicitly requests specification-driven development, run agent-cli spect init in the project directory when it is absent.
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

/** Does this content look like a REAL master (headings + substance)? Never
 *  true for pointer stubs, empty templates, or corrupt fragments. */
function isRealMaster(content) {
	return (
		content != null && content.trim().length >= 40 && content.includes("## ")
	);
}

/** Write a timestamped backup copy of the pre-migration ~/AGENTS.md under
 *  ~/.agents/backups and return its absolute path. */
async function backupHomeCopy(content) {
	await ensureDir(BACKUP_DIR);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	let backup = path.join(BACKUP_DIR, `AGENTS-${stamp}.md`);
	for (let n = 2; await exists(backup); n++) {
		backup = path.join(BACKUP_DIR, `AGENTS-${stamp}-${n}.md`);
	}
	await writeFile(backup, content.endsWith("\n") ? content : content + "\n");
	return backup;
}

/**
 * One-shot layout migration, run inside ensureMaster BEFORE any other decision.
 * Pre-flip installs kept the real master at ~/AGENTS.md with a self-pointer
 * stub at ~/.agents/AGENTS.md; the canonical layout is the reverse. Cases:
 *
 *   - old layout (real ~/AGENTS.md, no real ~/.agents/AGENTS.md) → move the
 *     home content into ~/.agents/AGENTS.md (stripping any stray stub header
 *     a buggy old `link` prepended), keep a backup, and turn ~/AGENTS.md into
 *     the managed home pointer → { action: "migrated", backup }.
 *   - divergence (both files real, or junk next to a real master) → keep the
 *     canonical ~/.agents/AGENTS.md, back up + replace ~/AGENTS.md with the
 *     home pointer, warn → { action: "diverged", backup, warning }.
 *   - junk ~/AGENTS.md with no real master anywhere → refuse: never adopt or
 *     replace content we cannot classify → { skipped: "master-too-small" }.
 *
 * Returns null when ~/AGENTS.md is absent or already the managed pointer
 * (fresh install or the new layout) — the caller proceeds as before.
 */
async function migrateMasterLayout() {
	const home = await readIfExists(HOME_POINTER_FILE);
	if (home == null || parseMasterPointer(home)) return null;
	const master = await readIfExists(MASTER_FILE);
	const homeIsReal = isRealMaster(home);
	const masterIsReal = isRealMaster(master);
	if (homeIsReal && !masterIsReal) {
		const backup = await backupHomeCopy(home);
		await writeMaster(ensureBlocks(stripStrayPointerHeader(home)));
		await ensureMasterPointer({ force: true });
		return {
			action: "migrated",
			seed: null,
			changed: true,
			backup,
			from: HOME_POINTER_FILE,
		};
	}
	if (masterIsReal) {
		const backup = await backupHomeCopy(home);
		const merged = ensureBlocks(master);
		if (merged !== master) await writeMaster(merged);
		await ensureMasterPointer({ force: true });
		return {
			action: "diverged",
			seed: null,
			changed: true,
			backup,
			warning: homeIsReal
				? `Both ${pretty(HOME_POINTER_FILE)} and ${pretty(MASTER_FILE)} held real content — kept the canonical master and backed up the home copy at ${pretty(backup)}. Merge anything you need from the backup into the master.`
				: `${pretty(HOME_POINTER_FILE)} held unrecognized content next to the canonical master — kept the master and backed up the home copy at ${pretty(backup)}.`,
		};
	}
	return {
		action: "exists",
		seed: null,
		changed: false,
		skipped: "master-too-small",
	};
}

/**
 * Ensure the master exists, seeding from the richest existing source if possible.
 * Always guarantees both managed blocks (agent-cli + skill-cli) are present.
 * Returns { action: 'exists'|'seeded'|'starter'|'migrated'|'diverged', seed: rel|null, changed: bool }.
 */
export async function ensureMaster() {
	// Layout migration first: adopting/repairing an old-layout install must run
	// before any exists/seed decision, or the seed path would strand the user's
	// content at ~/AGENTS.md.
	const migration = await migrateMasterLayout();
	if (migration) return migration;
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

/** Re-merge managed blocks into the current master (used by `agent-cli skill refresh`). */
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
 * Ensure the agent-cli self-pointer stub at HOME_POINTER_FILE
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
	const existing = await readIfExists(HOME_POINTER_FILE);
	const desired = masterPointerContent({ masterAbs, masterTilde: tilde });
	if (existing == null) {
		await writeFile(HOME_POINTER_FILE, desired);
		return {
			path: HOME_POINTER_FILE,
			action: "created",
			masterAbs,
			masterTilde: tilde,
		};
	}
	const parsed = parseMasterPointer(existing);
	if (!parsed) {
		if (!force) {
			return {
				path: HOME_POINTER_FILE,
				skipped: "native-content",
				hint: "agent-cli init --force",
			};
		}
		await writeFile(HOME_POINTER_FILE, desired);
		return {
			path: HOME_POINTER_FILE,
			action: "overwritten",
			masterAbs,
			masterTilde: tilde,
		};
	}
	const same =
		normalizeEndings(existing).trim() === normalizeEndings(desired).trim();
	if (same) {
		return {
			path: HOME_POINTER_FILE,
			action: "skipped",
			masterAbs,
			masterTilde: tilde,
		};
	}
	await writeFile(HOME_POINTER_FILE, desired);
	return {
		path: HOME_POINTER_FILE,
		action: "updated",
		masterAbs,
		masterTilde: tilde,
	};
}

/** Classify the current state of the self-pointer stub. */
export async function classifyMasterPointer() {
	const existing = await readIfExists(HOME_POINTER_FILE);
	if (existing == null) return { path: HOME_POINTER_FILE, state: "missing" };
	const parsed = parseMasterPointer(existing);
	if (!parsed) return { path: HOME_POINTER_FILE, state: "native" };
	const desired = masterPointerContent({
		masterAbs: parsed.masterAbs,
		masterTilde: parsed.masterTilde,
	});
	return {
		path: HOME_POINTER_FILE,
		state:
			normalizeEndings(existing).trim() === normalizeEndings(desired).trim()
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
