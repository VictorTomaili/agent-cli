// src/handoff.js — delegation artifacts for sub-agents.
// Real wire format for the `## Handoff` template section: an artifact under
// ~/.agents/handoffs/ with stable ids and a status lifecycle (open → accepted → closed).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	HOME,
	AGENTS_DIR,
	exists,
	ensureDir,
	writeFile,
	sanitizePathSegment,
} from "./util.js";
import { gitInfo } from "./memory.js";
import { summarizeSession } from "./team-eval.js";

export const HANDOFF_DIR = path.join(HOME, ".agents", "handoffs");

function slug(s) {
	return String(s || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

export async function createHandoff({
	to,
	from = "agent-cli",
	task,
	context = "",
	cwd = process.cwd(),
} = {}) {
	if (!to) return { ok: false, reason: "handoff requires a target agent (--to <name>)" };
	if (!task) return { ok: false, reason: "handoff requires a task (--task <text>)" };
	await ensureDir(HANDOFF_DIR);
	const info = gitInfo(cwd);
	const id = `h-${Date.now()}-${slug(task)}`;
	const file = path.join(HANDOFF_DIR, `${id}.md`);
	const content = `---
id: ${id}
to: ${to}
from: ${from}
task: ${task}
status: open
createdAt: ${new Date().toISOString()}
repo: ${info.repo ?? ""}
branch: ${info.branch ?? ""}
---

## Context
${context || "(none)"}

## Handoff
${task}
`;
	await writeFile(file, content);
	return { ok: true, id, to, task, file, status: "open" };
}

export async function listHandoffs({ status = null } = {}) {
	if (!(await exists(HANDOFF_DIR))) return [];
	const entries = fs
		.readdirSync(HANDOFF_DIR, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".md"));
	const out = [];
	for (const e of entries) {
		const file = path.join(HANDOFF_DIR, e.name);
		const content = fs.readFileSync(file, "utf8");
		const fm = parseFm(content);
		if (status && fm.status !== status) continue;
		out.push({ id: fm.id ?? e.name, to: fm.to, from: fm.from, task: fm.task, status: fm.status ?? "open", file });
	}
	return out.sort((a, b) => a.file.localeCompare(b.file));
}

function parseFm(content) {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
	if (!m) return {};
	const fm = {};
	for (const line of m[1].split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return fm;
}

function findFile(id) {
	// Shared chokepoint for showHandoff (read) and setHandoffStatus (WRITE), so
	// the id is folded to one segment here rather than at each call site. Every
	// id this module mints already lives in the safe set — `h-<ts>-<slug>` and
	// `<task>-from-<pred>` — so this is lossless for real ids and only rejects
	// a crafted one.
	const safe = sanitizePathSegment(id);
	if (!safe) return null;
	const file = path.join(HANDOFF_DIR, `${safe}.md`);
	return fs.existsSync(file) ? file : null;
}

export async function showHandoff(id) {
	const file = findFile(id);
	if (!file) return { ok: false, reason: `no such handoff: ${id}` };
	return { ok: true, id, file, content: fs.readFileSync(file, "utf8") };
}

export async function setHandoffStatus(id, status) {
	const file = findFile(id);
	if (!file) return { ok: false, reason: `no such handoff: ${id}` };
	const content = fs.readFileSync(file, "utf8");
	const next = content.replace(
		/^status: .*$/m,
		`status: ${status}`,
	);
	fs.writeFileSync(file, next, "utf8");
	return { ok: true, id, status, file };
}

export async function acceptHandoff(id) {
	return setHandoffStatus(id, "accepted");
}

export async function closeHandoff(id, { lesson = null, cwd = process.cwd() } = {}) {
	const r = await setHandoffStatus(id, "closed");
	if (!r.ok) return r;
	let lessonResult = null;
	if (lesson) {
		const lessonsLib = await import("./lessons-lib.js");
		lessonResult = await lessonsLib.addLesson(lesson, { body: `Learned while closing handoff ${id}`, cwd });
	}
	return { ok: true, id, status: "closed", file: r.file, lesson: lessonResult };
}

// --- P8: per-task handoff reader surface (NEW, additive — the open/accepted/closed
// lifecycle above is owned elsewhere and is NOT touched). -------------------------------
//
// `attachContextForTask` READS the existing handoff artifacts dir + the P7 dispatch ledger
// (+ the P6 session summary for verifier verdicts) and assembles ONE handoff doc per task,
// so dependent-task context travels as a structured handoff artifact instead of
// re-explained prose in each dispatch prompt. It writes to `HANDOFF_DIR` so the existing
// `showHandoff`/`listHandoffs` readers can open the artifact unchanged.

/** Resolve the home the ledger/handoffs live under (call-time, env-settable for tests). */
function handoffHome(home) {
	return home || process.env.AGENT_CLI_HOME || os.homedir();
}

/** Most-recent `<session>.dispatch.log` session id under <home>/.agents/.logs (or null). */
function latestLedgerSession(home) {
	const dir = path.join(home, ".agents", ".logs");
	let entries;
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return null;
	}
	let best = null;
	let bestM = -1;
	for (const name of entries) {
		if (!name.endsWith(".dispatch.log")) continue;
		const full = path.join(dir, name);
		try {
			const m = fs.statSync(full).mtimeMs;
			if (m > bestM) {
				bestM = m;
				best = full;
			}
		} catch {
			/* raced away — skip */
		}
	}
	return best ? path.basename(best).replace(/\.dispatch\.log$/, "") : null;
}

/** Read and parse one session's dispatch ledger. Malformed lines are skipped. */
function readSessionLedger(sessionId, home) {
	const p = path.join(home, ".agents", ".logs", `${sessionId}.dispatch.log`);
	let content;
	try {
		content = fs.readFileSync(p, "utf8");
	} catch {
		return [];
	}
	const entries = [];
	for (const line of content.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			entries.push(JSON.parse(t));
		} catch {
			/* skip a malformed line — P6/P7 aggregation never chokes on one */
		}
	}
	return entries;
}

/** Latest ledger entry whose `task` matches `taskId` exactly (else null). */
function findTaskEntry(entries, taskId) {
	let found = null;
	for (const e of entries) {
		if (String(e.task ?? "") === String(taskId)) found = e;
	}
	return found;
}

/** Extract a `dependsOn` array from a task's ledger `note`, when it is JSON. */
function extractDependsFromTask(entries, taskId) {
	const e = findTaskEntry(entries, taskId);
	if (!e || typeof e.note !== "string") return [];
	try {
		const parsed = JSON.parse(e.note);
		if (parsed && Array.isArray(parsed.dependsOn)) {
			return parsed.dependsOn.filter(Boolean).map(String);
		}
	} catch {
		/* note is not JSON — no dependency info */
	}
	return [];
}

/** Collapse a string to a single line, trimmed, capped for a one-line summary. */
function oneLine(s) {
	return String(s ?? "")
		.replace(/\s*\r?\n\s*/g, " ")
		.trim()
		.slice(0, 160);
}

/** Find a verifier verdict (P6 `summary.verifierVerdicts`) for a predecessor, or null. */
function findVerdict(summary, predId) {
	const verdicts = Array.isArray(summary?.verifierVerdicts) ? summary.verifierVerdicts : [];
	for (const v of verdicts) {
		if (v && String(v.task ?? v.id ?? "") === String(predId)) return v;
	}
	return null;
}

/** Build one `## <predecessor>` block for the handoff doc. */
function buildHandoffBlock(predId, entry, summary) {
	const verdict = findVerdict(summary, predId);
	const summaryText = verdict ? oneLine(verdict.summary ?? verdict.note ?? "") : oneLine(entry.note);
	return [
		`## ${predId}`,
		`- role: ${entry.role ?? "orchestrator"}`,
		`- ts: ${entry.ts ?? ""}`,
		`- status: ${entry.status ?? "unknown"}`,
		`- ms: ${Number.isFinite(entry.ms) ? entry.ms : 0}`,
		`- summary: ${summaryText}`,
		`- ledger line: ${JSON.stringify(entry)}`,
	].join("\n");
}

/** Assemble the per-task handoff doc (fixed template — the executor needs structure). */
function buildHandoffDoc({ taskId, session, deps, blocks }) {
	return [
		`# Handoff for ${taskId}`,
		`session: ${session}`,
		`predecessors: [${deps.join(", ")}],`,
		``,
		blocks.join("\n\n"),
	].join("\n");
}

/**
 * Assemble a per-task handoff artifact from the P7 dispatch ledger (+ P6 summary
 * verdicts) and write it to `~/.agents/handoffs/<taskId>-from-<primaryPredecessor>.md`.
 *
 * @param {object} opts
 * @param {string} opts.taskId - the task this handoff is being assembled for.
 * @param {string[]} [opts.dependsOn] - predecessor task ids. When omitted, read from the
 *   task's ledger `note` (`{"dependsOn": [...]}`) if present.
 * @param {string} [opts.session] - session id whose ledger to read. When omitted, uses the
 *   most-recent ledger under <home>/.agents/.logs.
 * @param {string} [opts.home] - home to resolve handoffs + ledger from.
 * @returns {{ok: true, artifactPath: string, summary: object}|{ok: false, reason: string}}
 *   `ok:false` when a required predecessor has no ledger record, or when the artifact cannot
 *   be written (best-effort).
 */
export function attachContextForTask({ taskId, dependsOn, session, home } = {}) {
	const tid = String(taskId ?? "").trim();
	if (!tid) return { ok: false, reason: "handoff requires a task id" };

	const base = handoffHome(home);
	const sessionId = session || latestLedgerSession(base);
	if (!sessionId) return { ok: false, reason: "no dispatch ledger to read" };

	const entries = readSessionLedger(sessionId, base);
	let deps = Array.isArray(dependsOn) ? dependsOn.filter(Boolean).map(String) : [];
	if (!deps.length) deps = extractDependsFromTask(entries, tid);

	const summary = summarizeSession({ sessionId, home: base });

	const blocks = [];
	for (const pred of deps) {
		const entry = findTaskEntry(entries, pred);
		if (!entry) return { ok: false, reason: `no ledger record for predecessor ${pred}` };
		blocks.push(buildHandoffBlock(pred, entry, summary));
	}

	// `tid` and the predecessor id are interpolated into a FILENAME, and both
	// originate in the orchestrator's task DAG rather than in this process — so
	// each is folded to one safe segment before it touches the path. Without
	// this, a task id of `../../../PWNED` writes the artifact three levels above
	// HANDOFF_DIR. The raw ids still go into the document body, which is inert.
	const safeTid = sanitizePathSegment(tid) ?? "task";
	const safePred = sanitizePathSegment(deps[0] || tid) ?? safeTid;
	const fileName = `${safeTid}-from-${safePred}.md`;
	const file = path.join(HANDOFF_DIR, fileName);
	const content = buildHandoffDoc({ taskId: tid, session: sessionId, deps, blocks });

	try {
		fs.mkdirSync(HANDOFF_DIR, { recursive: true });
		// Atomic write (exclusive-create → fsync → rename), same as every lesson-store write.
		fs.writeFileSync(file, content);
	} catch (err) {
		return { ok: false, reason: "handoff write failed" };
	}

	return { ok: true, artifactPath: file, summary };
}

export { AGENTS_DIR };
