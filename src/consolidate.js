// src/consolidate.js — memory consolidation. Purely occurrence-based (NO heuristics/regex):
// promotes recurring lessons to the always-on core, prunes single-occurrence-unrepeated
// lessons after a two-pass grace (mark → delete if still unrepeated). Works on global or
// project scope. The agent decides paths/topics; this only counts & moves.
//
// Cross-cutting invariants this module honors (see ARCHITECTURE.md):
//   - Atomic writes: every file written by this module goes through util.writeFileSync
//     (exclusive-create → fsync → rename-over-existing). No raw fs.writeFileSync /
//     fs.copyFileSync for lesson-dir content.
//   - Cross-process operation lock: consolidate() is wrapped in
//     withOperationLock("consolidate", ...) so the conflict matrix in operation-lock.js
//     (consolidate conflicts with lesson_capture and brain_write LESSONS kind) serializes
//     concurrent compound mutations. planConsolidation() and applyPlanAction() are NOT
//     locked: pure-read and single-action paths.
//   - Sanitized errors (A15 least-disclosure): MCP-shaped callers (opts.surface === "mcp")
//     never receive error.message / error.stack — only the stable { ok:false, code,
//     reason, scope } envelope. Internal CLI callers default to "internal" and get a
//     `detail` field carrying error.message for human-readable output.
//   - Symlink-safe traversal: walkSync refuses any directory entry whose
//     isSymbolicLink() is true. A malicious `lessons/foo -> /etc/passwd` symlink
//     cannot leak into the consolidation surface (read or write).
//   - Contained paths: lesson paths come exclusively through lessons-lib.js#lessonsRoot /
//     coreFile / resolveLessonFile, which already enforce the HOME / cwd root bound.
//     consolidate() never constructs a path under a caller-controlled component.
//   - Transactional backup (P0-5): before any mutation, the entire lessons dir is
//     snapshotted into ~/.agents/backups/consolidate-tx-<scope>-<...> via
//     util.writeFileSync per file (no fs.cpSync). The staging dir lives under a
//     mkdtempSync ancestor so a collision cannot merge into a half-written backup.
//     Staging is verified (count match, non-empty) before being renamed into the
//     final backups location.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, writeFileSync } from "./util.js";
import { withOperationLock } from "./operation-lock.js";
import { lessonsRoot, coreFile, parseFM, buildFM } from "./lessons-lib.js";

const BACKUP_DIR_GLOBAL = path.join(HOME, ".agents", "backups");

const CONSOLIDATE_DEFAULTS = {
	promoteThreshold: 2,
	scoreThreshold: 70,
	tokenBudget: 20000,
	lessonSoftCap: 50,
	coreBudget: 4000,
	promotableFull: 5,
	markedFull: 10,
	inboxFull: 10,
};
function loadConsolidateConfig() {
	try {
		const raw = fs.readFileSync(
			path.join(HOME, ".agents", "config.json"),
			"utf8",
		);
		const p = JSON.parse(raw);
		return { ...CONSOLIDATE_DEFAULTS, ...(p.consolidate || {}) };
	} catch {
		return { ...CONSOLIDATE_DEFAULTS };
	}
}
function clamp(x, lo = 0, hi = 1) {
	return Math.max(lo, Math.min(hi, x));
}
function readLastRun(scope, cwd) {
	const sp = path.join(
		scope === "project" ? cwd : HOME,
		".agents",
		".consolidate-state.json",
	);
	try {
		const s = JSON.parse(fs.readFileSync(sp, "utf8"));
		return s.lastRun ? new Date(s.lastRun) : null;
	} catch {
		return null;
	}
}
function approxTokens(s) {
	return Math.round((s || "").length / 4);
}

/**
 * Build a failure envelope. `code` is the stable, machine-readable identifier; `reason`
 * is the short human-readable summary. `detail` (error.message) is only attached when
 * the caller's `surface` is "internal" — MCP-shaped callers must never receive it.
 */
export function fail(scope, surface, code, reason, error) {
	const out = { ok: false, code, reason, scope };
	if (error && surface !== "mcp") {
		out.detail = error.message || String(error);
	}
	return out;
}

/**
 * Recursively list .md files in a lessons dir (relative POSIX paths not needed —
 * callers want absolute paths). Symlink entries are explicitly refused: a malicious
 * `lessons/foo -> /etc/passwd` must not leak into the consolidation surface. The
 * `e.isDirectory()` check is safe after the symlink skip because Dirent reports the
 * symlink itself (not the target) when readdir is called with withFileTypes:true.
 */
function walkSync(dir) {
	const out = [];
	let entries = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.name.startsWith(".")) continue;
		if (e.isSymbolicLink()) continue; // symlink refusal
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walkSync(p));
		else if (e.name.endsWith(".md")) out.push(p);
	}
	return out;
}

/**
 * Hybrid consolidation score (E): max(cost-pressure, value-opportunity) → 0..100. */
export function assess({ scope = "global", cwd = process.cwd() } = {}) {
	const cfg = loadConsolidateConfig();
	const dir = lessonsRoot(scope, cwd);
	const corePath = coreFile(scope, cwd);
	const files = fs.existsSync(dir) ? walkSync(dir) : [];
	let inbox = 0;
	try {
		inbox = fs
			.readdirSync(path.join(dir, ".inbox"))
			.filter((n) => n.endsWith(".md")).length;
	} catch {
		inbox = 0;
	}
	let lessons = 0;
	let marked = 0;
	let promotable = 0;
	let singletons = 0;
	let fileChars = 0;
	for (const fp of files) {
		const raw = fs.readFileSync(fp, "utf8");
		fileChars += raw.length;
		const { fm } = parseFM(raw);
		const occ = parseInt(fm.occurrences || "1", 10) || 1;
		lessons++;
		if (occ === 1) singletons++;
		if (String(fm.marked || "false") === "true") marked++;
		if (occ >= cfg.promoteThreshold) promotable++;
	}
	const coreText = fs.existsSync(corePath)
		? fs.readFileSync(corePath, "utf8")
		: "";
	const coreTokens = approxTokens(coreText);
	const tokens = coreTokens + Math.round(fileChars / 4);
	const last = readLastRun(scope, cwd);
	const ageDays = last
		? Math.round((Date.now() - last.getTime()) / 86400000)
		: null;

	const tokenPressure = clamp(tokens / cfg.tokenBudget);
	const lessonPressure = clamp(lessons / cfg.lessonSoftCap);
	const corePressure = clamp(coreTokens / cfg.coreBudget);
	const costPressure = clamp(
		0.5 * tokenPressure + 0.3 * lessonPressure + 0.2 * corePressure,
	);
	const promotablePressure = clamp(promotable / cfg.promotableFull);
	const markedPressure = clamp(marked / cfg.markedFull);
	const inboxPressure = clamp(inbox / cfg.inboxFull);
	const valueOpportunity = clamp(
		0.5 * promotablePressure + 0.3 * markedPressure + 0.2 * inboxPressure,
	);
	const score = Math.round(100 * Math.max(costPressure, valueOpportunity));
	const recommend = score >= cfg.scoreThreshold;

	const reasons = [];
	if (tokenPressure > 0.6)
		reasons.push(`tokens ${tokens} near ${cfg.tokenBudget} budget`);
	if (lessonPressure > 0.6)
		reasons.push(`${lessons} lessons (soft cap ${cfg.lessonSoftCap})`);
	if (corePressure > 0.6)
		reasons.push(`core ${coreTokens} tokens near ${cfg.coreBudget}`);
	if (promotablePressure > 0.5) reasons.push(`${promotable} promotable`);
	if (markedPressure > 0.5) reasons.push(`${marked} marked prunable`);
	if (inboxPressure > 0.5) reasons.push(`${inbox} inbox backlog`);

	return {
		ok: true,
		scope,
		score,
		recommend,
		threshold: cfg.scoreThreshold,
		reasons,
		metrics: {
			lessons,
			inbox,
			tokens,
			coreTokens,
			marked,
			promotable,
			singletons,
			singletonRatio: lessons ? Number((singletons / lessons).toFixed(2)) : 0,
			ageDays,
			costPressure: Number(costPressure.toFixed(2)),
			valueOpportunity: Number(valueOpportunity.toFixed(2)),
		},
		config: cfg,
	};
}

// Canonical pointer reference: core entries are recognized by their
// `lessons/<relative-path>` reference, NOT by prose formatting, so any pointer
// format (legacy `- **Lesson:** ...` or new `- <summary> — \`lessons/<rel>\``)
// containing a `lessons/<rel>` reference is recognized and deduplicated.
const LESSON_REF = /lessons\/[A-Za-z0-9._\/-]+/;

function readCore(file) {
	if (!fs.existsSync(file)) return [];
	const c = fs.readFileSync(file, "utf8");
	const idx = c.indexOf("## Core");
	const seg = idx >= 0 ? c.slice(idx) : c;
	const entries = [];
	let cur = null;
	for (const line of seg.split("\n")) {
		// A top-level list item starts a new entry: consolidation pointers AND
		// user-authored bullets. This keeps every pointer format parseable so
		// re-consolidation deduplicates instead of appending duplicates, while
		// preserving user content that does not reference a lesson.
		if (/^-\s/.test(line)) {
			if (cur) entries.push(cur);
			cur = [line];
		} else if (cur && (/^[ \t]+/.test(line) || line.trim() === "")) {
			cur.push(line);
		} else if (cur) {
			entries.push(cur);
			cur = null;
			if (line.trim() && !/^[#>]/.test(line)) entries.push([line]);
		} else if (line.trim() && !/^[#>]/.test(line)) {
			entries.push([line]);
		}
	}
	if (cur) entries.push(cur);
	return entries.map((e) => e.join("\n").trim()).filter(Boolean);
}

/** True when any core entry references exactly `lessons/<rel>`. */
function hasPointer(entries, rel) {
	const ref = `lessons/${rel}`;
	for (const entry of entries) {
		const m = LESSON_REF.exec(entry);
		if (m && m[0] === ref) return true;
	}
	return false;
}

/**
 * P0-5: copy the whole lessons dir into backups as a transaction snapshot, via
 * util.writeFileSync per file (no fs.cpSync). The staging dir lives under a
 * mkdtempSync ancestor so a collision cannot merge into a half-written backup.
 * On verify failure (count mismatch, empty source, or any write error) the
 * staging dir is removed and the error re-thrown — caller must abort.
 */
function snapshotLessonsDir(srcDir, backupDir, scope) {
	const staging = fs.mkdtempSync(
		path.join(os.tmpdir(), `consolidate-tx-${scope}-`),
	);
	const cleanup = () => {
		try {
			fs.rmSync(staging, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	};
	try {
		const srcFiles = walkSync(srcDir); // already skips symlinks
		if (srcFiles.length === 0) {
			// Empty lessons dir is a healthy no-op; no backup to keep.
			cleanup();
			return null;
		}
		for (const fp of srcFiles) {
			const rel = path
				.relative(srcDir, fp)
				.split(path.sep)
				.join("/");
			const dst = path.join(staging, rel);
			writeFileSync(dst, fs.readFileSync(fp));
		}
		const stagedFiles = walkSync(staging);
		if (stagedFiles.length !== srcFiles.length) {
			throw new Error(
				`staged file count mismatch: source=${srcFiles.length} staged=${stagedFiles.length}`,
			);
		}
		fs.mkdirSync(backupDir, { recursive: true });
		// mkdtempSync's basename is already unique; place it directly under
		// backupDir. rename-over-existing is atomic on POSIX and replaces the
		// target on Windows. A vanishingly rare collision (lock failure case)
		// would surface as EEXIST — treat it as a backup failure, do not retry.
		const finalDir = path.join(backupDir, path.basename(staging));
		fs.renameSync(staging, finalDir);
		return finalDir;
	} catch (e) {
		cleanup();
		throw e;
	}
}

/**
 * Copy the previous core file (if any) into backups/LESSONS-<ts>.md BEFORE
 * overwriting it. Uses util.writeFileSync per file instead of fs.copyFileSync
 * — same atomic-rename guarantee, no raw fs.copyFileSync for lesson-dir
 * content. No-op when the core doesn't exist yet (first consolidation).
 */
function ensureBackup(file, scope, cwd) {
	if (!fs.existsSync(file)) return; // nothing to back up on the first consolidation
	const dir =
		scope === "project"
			? path.join(cwd, ".agents", "backups")
			: BACKUP_DIR_GLOBAL;
	fs.mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(
			dir,
			`LESSONS-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
		),
		fs.readFileSync(file),
	);
}

function writeCore(file, entries, scope) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const body = entries.length
		? entries.join("\n\n")
		: "<!-- promoted by consolidation -->";
	const loc =
		scope === "project" ? "[project]/.agents/lessons" : "~/.agents/lessons";
	const out = `# LESSONS.md — always-on core${scope === "project" ? " (project)" : " (system-wide)"}

> Most important, high-signal lessons — loaded every session. Consolidation promotes recurring lessons here from ${loc}.

## Core
 ${body}
`;
	writeFileSync(file, out);
}

/**
 * Run a full consolidation pass: transactional backup → per-file promote / mark /
 * delete → core write → state-file write. Wrapped in withOperationLock("consolidate",
 * ...) so the conflict matrix serializes against lesson_capture and brain_write
 * (LESSONS kind). planConsolidation / applyPlanAction are NOT locked — pure-read
 * and single-action respectively.
 *
 * @param opts.surface  "internal" (default; includes error.message in `detail`)
 *                      or "mcp" (omits error.message / stack — A15).
 */
export async function consolidate({
	scope = "global",
	cwd = process.cwd(),
	dryRun = false,
	promoteThreshold,
	surface = "internal",
} = {}) {
	return withOperationLock(
		"consolidate",
		() => doConsolidate({ scope, cwd, dryRun, promoteThreshold, surface }),
		{ operation: `consolidate:${scope}`, timeoutMs: 5000 },
	);
}

function doConsolidate({ scope, cwd, dryRun, promoteThreshold, surface }) {
	const cfg = loadConsolidateConfig();
	const pt = promoteThreshold ?? cfg.promoteThreshold;
	const dir = lessonsRoot(scope, cwd);
	const corePath = coreFile(scope, cwd);
	// No lessons dir = a healthy empty state, not a failure: cron/monitor loops
	// must treat "nothing to do" as exit 0 (see docs/contract.md).
	if (!fs.existsSync(dir))
		return {
			ok: true,
			nothingToDo: true,
			reason: "no lessons dir",
			scope,
			dir,
		};

	const files = walkSync(dir);
	let promoted = 0;
	let deleted = 0;
	let marked = 0;
	let kept = 0;
	const core = [...readCore(corePath)];

	// P0-5: transactional safety — snapshot the ENTIRE lessons dir BEFORE any
	// mutation, so an interrupted consolidation never loses lessons. If the
	// snapshot fails (creation OR verification) we abort: mutating without a
	// restore point is worse.
	const backupDir =
		scope === "project"
			? path.join(cwd, ".agents", "backups")
			: BACKUP_DIR_GLOBAL;
	let txDir = null;
	if (!dryRun && fs.existsSync(dir)) {
		try {
			txDir = snapshotLessonsDir(dir, backupDir, scope);
		} catch (error) {
			if (
				error &&
				typeof error.message === "string" &&
				error.message.includes("staged file count mismatch")
			) {
				return fail(
					scope,
					surface,
					"BACKUP_VERIFY_FAILED",
					"transaction backup verify failed",
					error,
				);
			}
			return fail(
				scope,
				surface,
				"BACKUP_FAILED",
				"transaction backup failed",
				error,
			);
		}
	}

	for (const fp of files) {
		const raw = fs.readFileSync(fp, "utf8");
		const { fm, body } = parseFM(raw);
		const occ = parseInt(fm.occurrences || "1", 10) || 1;
		const isMarked = String(fm.marked || "false") === "true";

		if (String(fm.promoted || "false") === "true") {
			kept++;
			continue;
		}
		if (occ >= pt) {
			promoted++;
			if (!dryRun) {
				const rel = path.relative(dir, fp).split(path.sep).join("/");
				const summary = (
					body.trim().split(/\r?\n/)[0] || path.basename(rel, ".md")
				).replace(/^[-*]\s+/, "");
				const pointer = `- ${summary} — \`lessons/${rel}\``;
				if (!hasPointer(core, rel)) core.push(pointer);
				const nfm = { ...fm, promoted: "true", marked: "false" };
				writeFileSync(fp, `${buildFM(nfm)}${body}`);
			}
		} else if (isMarked) {
			deleted++; // grace expired, still single-occurrence → prune
			if (!dryRun) fs.unlinkSync(fp);
		} else {
			marked++; // first pass: start grace
			kept++;
			if (!dryRun) {
				const nfm = { ...fm, marked: "true" };
				writeFileSync(fp, `${buildFM(nfm)}${body}`);
			}
		}
	}

	if (!dryRun) {
		try {
			ensureBackup(corePath, scope, cwd);
		} catch (error) {
			return fail(scope, surface, "BACKUP_FAILED", "backup failed", error);
		}
		writeCore(corePath, core, scope);
		try {
			writeFileSync(
				path.join(
					scope === "project" ? cwd : HOME,
					".agents",
					".consolidate-state.json",
				),
				JSON.stringify({ lastRun: new Date().toISOString() }, null, 2),
			);
		} catch {
			/* ignore — bookkeeping is non-critical */
		}
	}
	return {
		ok: true,
		dryRun,
		scope,
		dir,
		...(txDir ? { txBackup: txDir } : {}),
		stats: {
			files: files.length,
			promoted,
			deleted,
			marked,
			kept,
			core: core.length,
		},
	};
}

/**
 * Per-file consolidation plan (no writes) with stable plan-action ids.
 * Pure read; NOT wrapped in withOperationLock — the caller serializes if needed.
 */
export function planConsolidation({
	scope = "global",
	cwd = process.cwd(),
	promoteThreshold,
} = {}) {
	const cfg = loadConsolidateConfig();
	const pt = promoteThreshold ?? cfg.promoteThreshold;
	const dir = lessonsRoot(scope, cwd);
	if (!fs.existsSync(dir)) return { ok: true, nothingToDo: true, scope, actions: [] };
	const files = walkSync(dir);
	const actions = [];
	for (const fp of files) {
		const raw = fs.readFileSync(fp, "utf8");
		const { fm, body } = parseFM(raw);
		const occ = parseInt(fm.occurrences || "1", 10) || 1;
		const isMarked = String(fm.marked || "false") === "true";
		const rel = path.relative(dir, fp).split(path.sep).join("/");
		let action;
		let reason;
		if (String(fm.promoted || "false") === "true") {
			action = "keep";
			reason = "already promoted";
		} else if (occ >= pt) {
			action = "promote";
			reason = `occurrences ${occ} >= ${pt}`;
		} else if (isMarked) {
			action = "delete";
			reason = "marked, still single-occurrence";
		} else {
			action = "mark";
			reason = "start grace (single occurrence)";
		}
		actions.push({
			id: `plan-${String(actions.length + 1).padStart(3, "0")}`,
			path: fp,
			rel,
			action,
			reason,
			occurrences: occ,
		});
	}
	return { ok: true, scope, promoteThreshold: pt, actions };
}

/**
 * Apply ONE planned action by id (targeted; mirrors the full consolidation rules).
 * Single-action; NOT wrapped in withOperationLock — callers serialize if needed.
 * Writes still go through util.writeFileSync (atomic-rename), so the partial-write
 * guarantee holds even without the lock.
 */
export function applyPlanAction(
	scope,
	cwd,
	planId,
	{ surface = "internal" } = {},
) {
	const plan = planConsolidation({ scope, cwd });
	const action = plan.actions.find((a) => a.id === planId);
	if (!action) {
		// planId is caller-controlled; surface="mcp" must not receive it.
		const detail = surface === "mcp" ? undefined : String(planId);
		const out = fail(
			scope,
			surface,
			"NO_SUCH_PLAN_ACTION",
			"no such plan action",
			detail ? new Error(`plan id: ${detail}`) : undefined,
		);
		return out;
	}
	if (action.action === "keep")
		return { ok: true, applied: action, changed: false };
	const raw = fs.readFileSync(action.path, "utf8");
	const { fm, body } = parseFM(raw);
	if (action.action === "promote") {
		const core = [...readCore(coreFile(scope, cwd))];
		if (!hasPointer(core, action.rel)) {
			const summary = (
				body.trim().split(/\r?\n/)[0] ||
				path.basename(action.rel, ".md")
			).replace(/^[-*]\s+/, "");
			core.push(`- ${summary} — \`lessons/${action.rel}\``);
		}
		writeCore(coreFile(scope, cwd), core, scope);
		writeFileSync(
			action.path,
			buildFM({ ...fm, promoted: "true", marked: "false" }) + body,
		);
	} else if (action.action === "mark") {
		writeFileSync(
			action.path,
			buildFM({ ...fm, marked: "true" }) + body,
		);
	} else if (action.action === "delete") {
		fs.unlinkSync(action.path);
	}
	return { ok: true, applied: action, changed: true };
}
