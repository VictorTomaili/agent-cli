// src/dev-team-retro.js — dev-team retro persistence (P8, ROADMAP Self-Improvement Loop).
//
// The Self-Improvement trigger is "5+ retro entries since the last loop" measured on an
// in-session log, which most sessions never accumulate. This module closes that gap by
// persisting each retro as a lesson-store inbox capture under a `dev-team` theme, so the
// EXISTING consolidation pipeline (lessons-lib .inbox → triage → consolidate) can promote
// recurring retros into the always-on core. It does NOT invent a new path scheme: it writes
// to `lessonsRoot('global')/.inbox/` — the exact directory consolidate()'s readers scan.
//
// Best-effort by design (mirrors src/dispatch-ledger.js): a failed write logs to stderr once
// per session/process and never throws, so a retro capture can never break the orchestrator
// that is calling it. `recordRetro` returns the written path (a truthy string) on success and
// `null` on failure; `countRetros` reads the same store and returns an integer.
//
// The Self-Improvement Loop trigger now reads this store: WORKFLOW.md's trigger is
// `agent-cli retro count --since-last-loop`, measured from the watermark `retro mark`
// stamps (markLoopRun/lastLoopRun below), and Stage 8 writes each entry via
// `agent-cli retro record`. The in-session log the trigger used to scan is gone.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { lessonsRoot, parseFM } from "./lessons-lib.js";
import { writeFileSync } from "./util.js";

const THEME = "dev-team";
const KIND = "retro";
const MAX_WORDS = 300;

/** Best-effort stderr guard: log a failed retro op once per session, then stay silent. */
let warned = false;
function warnOnce(prefix, err) {
	if (warned) return;
	warned = true;
	try {
		const msg = err && err.message ? err.message : String(err);
		console.error(`[dev-team-retro] ${prefix}: ${msg}`);
	} catch {
		/* never let logging throw either */
	}
}

/** Resolve the home the lessons store lives under (env-settable for tests). */
function homeDir() {
	return process.env.AGENT_CLI_HOME || os.homedir();
}

/** Derive a verdict enum from a P6 session summary when the caller doesn't supply one. */
function deriveOutcome(summary) {
	const rate = Number.isFinite(summary.successRate) ? summary.successRate : 0;
	if (rate >= 1) return "PASS";
	if (rate >= 0.7) return "PASS-WITH-NOTES";
	if (rate >= 0.4) return "LOW-CONFIDENCE";
	return "REFUTED";
}

/**
 * Clamp a lesson body to <= `maxWords` words. When exceeded, keep the first `maxWords`
 * and append `... [truncated, original <N> words]`. Pure string transform.
 */
function clampBody(text, maxWords = MAX_WORDS) {
	const s = String(text ?? "").trim();
	const words = s.split(/\s+/).filter(Boolean);
	if (words.length <= maxWords) return s;
	return `${words.slice(0, maxWords).join(" ")} ... [truncated, original ${words.length} words]`;
}

/**
 * Build the retro Markdown: YAML-style frontmatter (parseable by lessons-lib#parseFM) +
 * a fixed body template. When the lesson carries a `#` heading, that becomes the title and
 * the rest is the body; otherwise the entire supplied lesson is the body (so the 300-word
 * clamp always applies) and the title is its concise leading line.
 */
function buildRetroContent({
	session,
	lane,
	roles,
	rounds,
	escalations,
	outcome,
	runs,
	successRate,
	lesson,
	source,
}) {
	const lines = String(lesson ?? "").split(/\r?\n/);
	const headingIdx = lines.findIndex((l) => /^#\s+/.test(l.trim()));
	let title;
	let body;
	if (headingIdx >= 0) {
		title = lines[headingIdx].replace(/^#\s+/, "").trim().slice(0, 80);
		body = lines.slice(headingIdx + 1).join("\n").trim();
	} else {
		const first = lines.find((l) => l.trim());
		title = (first || "Retro lesson").trim().slice(0, 60);
		body = String(lesson ?? "").trim();
	}
	return [
		`---`,
		`theme: ${THEME}`,
		`kind: ${KIND}`,
		`session: ${session}`,
		`lane: ${lane}`,
		`roles: [${roles.join(", ")}]`,
		`rounds: ${rounds}`,
		`escalations: ${escalations}`,
		`outcome: ${outcome}`,
		`runs: ${runs}`,
		`successRate: ${successRate}`,
		`---`,
		`# ${title}`,
		``,
		clampBody(body),
		``,
		`## Source`,
		source,
	].join("\n");
}

/**
 * Write one dev-team retro as a lesson-store inbox capture. Best-effort: never throws.
 *
 * @param {object} opts
 * @param {object} [opts.sessionSummary] - a P6 `summarizeSession` result; contributes
 *   `sessionId`, `runs`, `successRate`, `rolesActivated` to the entry.
 * @param {string} [opts.lane] - 'fast' | 'full' (default 'full').
 * @param {string[]} [opts.rolesActivated] - roles that ran; overrides the summary's.
 * @param {number} [opts.rounds] - collaboration rounds (default 0).
 * @param {number} [opts.escalations] - escalations during the run (default 0).
 * @param {string} opts.lesson - the lesson body text the user/operator supplied (required).
 * @param {string} [opts.source] - provenance for the `## Source` line (default 'manual').
 * @param {string} [opts.outcome] - PASS|PASS-WITH-NOTES|REFUTED|LOW-CONFIDENCE; if absent,
 *   derived from the summary's successRate.
 * @returns {string|null} the absolute written path, or `null` on a best-effort failure.
 */
export function recordRetro({
	sessionSummary,
	lane,
	rolesActivated,
	rounds,
	escalations,
	lesson,
	source = "manual",
	outcome,
} = {}) {
	const summary = sessionSummary || {};
	const session = summary.sessionId || summary.session || "unknown";
	const roles = Array.isArray(rolesActivated)
		? rolesActivated
		: Array.isArray(summary.rolesActivated)
			? summary.rolesActivated
			: [];
	const runs = Number.isFinite(summary.runs) ? summary.runs : 0;
	const successRate = Number.isFinite(summary.successRate) ? summary.successRate : 0;
	const verdict = outcome || deriveOutcome(summary);
	const lanes = lane || "full";
	const rds = Number.isFinite(rounds) ? rounds : 0;
	const esc = Number.isFinite(escalations) ? escalations : 0;

	if (!String(lesson ?? "").trim()) {
		warnOnce("recordRetro", "lesson body required");
		return null;
	}

	const dir = path.join(lessonsRoot("global"), ".inbox");
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const rand = crypto.randomBytes(3).toString("hex");
	const file = path.join(dir, `dev-team-${ts}-${rand}.md`);
	const content = buildRetroContent({
		session,
		lane: lanes,
		roles,
		rounds: rds,
		escalations: esc,
		outcome: verdict,
		runs,
		successRate,
		lesson,
		source,
	});
	try {
		// util.writeFileSync is the atomic (exclusive-create → fsync → rename) write; it
		// also mkdirs the parent dir. Same discipline as consolidate/lessons-lib.
		writeFileSync(file, content);
		return file;
	} catch (err) {
		warnOnce("write failed", err);
		return null;
	}
}

/** Count `.md` files directly in `dir` whose theme + mtime match. Never throws. */
function scanDir(dir, theme, sinceTs) {
	let count = 0;
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return 0; // absent/unreadable dir is a healthy zero, not a failure
	}
	for (const name of names) {
		if (!name.endsWith(".md")) continue;
		const fp = path.join(dir, name);
		let content;
		try {
			content = fs.readFileSync(fp, "utf8");
		} catch {
			continue; // raced away
		}
		const { fm } = parseFM(content);
		if (fm.theme !== theme) continue;
		if (sinceTs !== null) {
			try {
				if (fs.statSync(fp).mtimeMs < sinceTs) continue;
			} catch {
				continue;
			}
		}
		count += 1;
	}
	return count;
}

/** Recursively count theme-matching lessons in the main (non-.inbox) store. */
function scanMain(root, theme, sinceTs) {
	let count = 0;
	let entries;
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const e of entries) {
		if (e.name.startsWith(".")) continue; // dotfiles / .inbox
		const p = path.join(root, e.name);
		if (e.isDirectory()) {
			count += scanMain(p, theme, sinceTs);
		} else if (e.name.endsWith(".md")) {
			let content;
			try {
				content = fs.readFileSync(p, "utf8");
			} catch {
				continue;
			}
			const { fm } = parseFM(content);
			if (fm.theme !== theme) continue;
			if (sinceTs !== null) {
				try {
					if (fs.statSync(p).mtimeMs < sinceTs) continue;
				} catch {
					continue;
				}
			}
			count += 1;
		}
	}
	return count;
}

/**
 * Count dev-team retro entries in the lessons store. Reads the `.inbox` dir (where
 * `recordRetro` writes); set `includeCore` to also count entries that have already been
 * filed into the main (non-.inbox) lessons store / promoted path.
 *
 * @param {object} opts
 * @param {string} [opts.home] - home to resolve `~/.agents/lessons` from; defaults to
 *   AGENT_CLI_HOME || os.homedir().
 * @param {string} [opts.theme] - theme to count (default 'dev-team').
 * @param {string} [opts.since] - ISO timestamp; only entries written at/after it count.
 * @param {boolean} [opts.includeCore] - also count filed/promoted dev-team lessons.
 * @returns {number} the count.
 */
export function countRetros({
	home,
	theme = THEME,
	since,
	includeCore = false,
} = {}) {
	const base = home || homeDir();
	const root = path.join(base, ".agents", "lessons");
	const sinceTs = since ? Date.parse(since) : null;
	let count = scanDir(path.join(root, ".inbox"), theme, sinceTs);
	if (includeCore) count += scanMain(root, theme, sinceTs);
	return count;
}

// --- Self-Improvement Loop watermark ----------------------------------------
// The trigger is "5+ retro entries SINCE THE LAST LOOP", which needs a
// persisted "last loop" instant. The obvious candidate — "entries still in the
// .inbox" — does not work: `agent-cli consolidate` never drains the inbox
// (src/consolidate.js's walkSync skips every dot-entry, so `.inbox` is outside
// its walk), so a pending-count would only ever grow. This is an explicit
// watermark instead: the loop stamps it on completion, and `countRetros`
// counts forward from the stamp.

/** Path of the loop watermark file. */
function markPath(base) {
	return path.join(base, ".agents", "lessons", ".dev-team-loop.json");
}

/**
 * Stamp "the Self-Improvement Loop ran now". Best-effort, like every other
 * write here. Returns the ISO timestamp written, or null on failure.
 */
export function markLoopRun({ home, at } = {}) {
	const base = home || homeDir();
	const ts = at || new Date().toISOString();
	try {
		writeFileSync(markPath(base), JSON.stringify({ lastRunAt: ts }, null, 2) + "\n");
		return ts;
	} catch (err) {
		warnOnce("mark failed", err);
		return null;
	}
}

/** The last stamped loop instant (ISO string), or null when never stamped. */
export function lastLoopRun({ home } = {}) {
	const base = home || homeDir();
	try {
		const parsed = JSON.parse(fs.readFileSync(markPath(base), "utf8"));
		const ts = parsed && parsed.lastRunAt;
		return typeof ts === "string" && Number.isFinite(Date.parse(ts)) ? ts : null;
	} catch {
		return null;
	}
}
