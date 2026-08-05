// src/consolidate.js — memory consolidation. Purely occurrence-based (NO heuristics/regex):
// promotes recurring lessons to the always-on core, prunes single-occurrence-unrepeated
// lessons after a two-pass grace (mark → delete if still unrepeated). Works on global or
// project scope. The agent decides paths/topics; this only counts & moves.

import fs from "node:fs";
import path from "node:path";
import { ensureDir, HOME } from "./util.js";
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
function scopeBase(scope, cwd) {
	return scope === "project" ? cwd : HOME;
}
function stateFile(scope, cwd) {
	return path.join(scopeBase(scope, cwd), ".agents", ".consolidate-state.json");
}
function readLastRun(scope, cwd) {
	try {
		const s = JSON.parse(fs.readFileSync(stateFile(scope, cwd), "utf8"));
		return s.lastRun ? new Date(s.lastRun) : null;
	} catch {
		return null;
	}
}
function approxTokens(s) {
	return Math.round((s || "").length / 4);
}

/** Hybrid consolidation score (E): max(cost-pressure, value-opportunity) → 0..100. */
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
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walkSync(p));
		else if (e.name.endsWith(".md")) out.push(p);
	}
	return out;
}

function ensureBackup(file, scope, cwd) {
	if (!fs.existsSync(file)) return; // nothing to back up on the first consolidation
	const dir =
		scope === "project"
			? path.join(cwd, ".agents", "backups")
			: BACKUP_DIR_GLOBAL;
	// mkdirSync (recursive) BEFORE the synchronous copy: ensureDir is async and
	// was never awaited, so on a fresh home the backups dir did not exist and
	// copyFileSync silently failed — a "successful" consolidation had NO backup.
	fs.mkdirSync(dir, { recursive: true });
	fs.copyFileSync(
		file,
		path.join(
			dir,
			`LESSONS-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
		),
	);
}

function writeCore(file, entries, scope) {
	ensureDir(path.dirname(file));
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
	fs.writeFileSync(file, out, "utf8");
}

export function consolidate({
	scope = "global",
	cwd = process.cwd(),
	dryRun = false,
	promoteThreshold,
} = {}) {
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
				fs.writeFileSync(
					fp,
					`---\n${Object.entries(nfm)
						.map(([k, v]) => `${k}: ${v}`)
						.join("\n")}\n---\n${body}`,
					"utf8",
				);
			}
		} else if (isMarked) {
			deleted++; // grace expired, still single-occurrence → prune
			if (!dryRun) fs.unlinkSync(fp);
		} else {
			marked++; // first pass: start grace
			kept++;
			if (!dryRun) {
				const nfm = { ...fm, marked: "true" };
				fs.writeFileSync(
					fp,
					`---\n${Object.entries(nfm)
						.map(([k, v]) => `${k}: ${v}`)
						.join("\n")}\n---\n${body}`,
					"utf8",
				);
			}
		}
	}

	if (!dryRun) {
		try {
			ensureBackup(corePath, scope, cwd);
		} catch (error) {
			return {
				ok: false,
				reason: `backup failed: ${error && error.message ? error.message : error}`,
			};
		}
		writeCore(corePath, core, scope);
		try {
			fs.writeFileSync(
				stateFile(scope, cwd),
				JSON.stringify({ lastRun: new Date().toISOString() }, null, 2),
			);
		} catch {
			/* ignore */
		}
	}
	return {
		ok: true,
		dryRun,
		scope,
		dir,
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

/** Per-file consolidation plan (no writes) with stable plan-action ids. */
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

/** Apply ONE planned action by id (targeted; mirrors the full consolidation rules). */
export function applyPlanAction(scope, cwd, planId) {
	const plan = planConsolidation({ scope, cwd });
	const action = plan.actions.find((a) => a.id === planId);
	if (!action) return { ok: false, reason: `no such plan action: ${planId}` };
	if (action.action === "keep") return { ok: true, applied: action, changed: false };
	const raw = fs.readFileSync(action.path, "utf8");
	const { fm, body } = parseFM(raw);
	if (action.action === "promote") {
		const core = [...readCore(coreFile(scope, cwd))];
		if (!hasPointer(core, action.rel)) {
			const summary = (body.trim().split(/\r?\n/)[0] || path.basename(action.rel, ".md")).replace(/^[-*]\s+/, "");
			core.push(`- ${summary} — \`lessons/${action.rel}\``);
		}
		writeCore(coreFile(scope, cwd), core, scope);
		fs.writeFileSync(action.path, buildFM({ ...fm, promoted: "true", marked: "false" }) + body, "utf8");
	} else if (action.action === "mark") {
		fs.writeFileSync(action.path, buildFM({ ...fm, marked: "true" }) + body, "utf8");
	} else if (action.action === "delete") {
		fs.unlinkSync(action.path);
	}
	return { ok: true, applied: action, changed: true };
}
