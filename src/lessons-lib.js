// src/lessons-lib.js — agent-driven lessons primitives. NO heuristics: the agent chooses
// every path/topic/filename. Supports global (~/.agents/lessons) and project ([cwd]/.agents/lessons).

import path from "node:path";
import fsp from "node:fs/promises";
import {
	exists,
	readFile,
	writeFile,
	ensureDir,
	HOME,
	resolveContained,
} from "./util.js";

export function lessonsRoot(scope = "global", cwd = process.cwd()) {
	return scope === "project"
		? path.join(cwd, ".agents", "lessons")
		: path.join(HOME, ".agents", "lessons");
}
export function coreFile(scope = "global", cwd = process.cwd()) {
	return scope === "project"
		? path.join(cwd, ".agents", "LESSONS.md")
		: path.join(HOME, ".agents", "LESSONS.md");
}

/**
 * Read the always-on core lessons — the `## Core` section of `LESSONS.md`.
 * Project scope is preferred; falls back to global. Pure read; never throws.
 * Returns `{ scope, path, content, tokens, exists }` where `content` is the
 * cleaned section text (HTML comments stripped, trimmed) or `null` when no
 * core is found in either scope. Used by the MCP `brain://lessons/core`
 * resource (Phase 6 T6.1.1) and by `actions.js#collectState` (was inline).
 */
export async function readCoreLessons({ cwd = process.cwd() } = {}) {
	for (const scope of ["project", "global"]) {
		try {
			const fp = coreFile(scope, cwd);
			const md = await readFile(fp);
			const idx = md.indexOf("## Core");
			if (idx < 0) continue;
			const cleaned = md
				.slice(idx + "## Core".length)
				.replace(/<!--[\s\S]*?-->/g, "")
				.trim();
			if (cleaned) {
				return {
					scope,
					path: fp,
					content: cleaned,
					tokens: Math.ceil(cleaned.length / 4),
					exists: true,
				};
			}
		} catch {
			/* no LESSONS.md in this scope — try the next one */
		}
	}
	return {
		scope: "global",
		path: coreFile("global", cwd),
		content: null,
		tokens: 0,
		exists: false,
	};
}

export function parseFM(content) {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { fm: {}, body: content };
	const fm = {};
	for (const line of m[1].split(/\r?\n/)) {
		const i = line.indexOf(":");
		if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return { fm, body: m[2] };
}
export function buildFM(fm) {
	return (
		"---\n" +
		Object.entries(fm)
			.map(([k, v]) => `${k}: ${v}`)
			.join("\n") +
		"\n---\n"
	);
}

/** true when p is inside base (or equal), using path.sep boundaries. */
function isInside(base, p) {
	return p === base || p.startsWith(base + path.sep);
}

/** Realpath of p, or of its deepest existing ancestor (null at the fs root). */
async function realpathOfExisting(p) {
	let cur = p;
	for (;;) {
		try {
			return await fsp.realpath(cur);
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return null;
			cur = parent;
		}
	}
}

/**
 * Resolve a lesson name (relative path, no .md) to an absolute path inside the
 * selected lessons directory. Rejects traversal, absolute paths, Windows
 * separators, and symlink escapes. Returns null when the path is unsafe.
 */
export async function resolveLessonFile(
	relpath,
	{ scope = "global", cwd = process.cwd() } = {},
) {
	if (typeof relpath !== "string") return null;
	const clean = relpath.replace(/\.md$/, "").trim();
	if (!clean) return null;
	const root = lessonsRoot(scope, cwd);
	const fp = resolveContained(root, `${clean}.md`);
	if (!fp) return null;
	// Symlink escape: the real target must stay inside the real lessons root.
	const realRoot = await realpathOfExisting(root);
	if (!realRoot) return null;
	const realFp = await realpathOfExisting(fp);
	if (realFp) return isInside(realRoot, realFp) ? fp : null;
	// File does not exist yet — guard symlinked intermediate directories.
	const realDir = await realpathOfExisting(path.dirname(fp));
	return realDir && isInside(realRoot, realDir) ? fp : null;
}

/** Recursively list .md files (relative to root), excluding dotfiles/.inbox. */
async function walk(dir) {
	const out = [];
	let entries = [];
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.name.startsWith(".")) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory())
			out.push(...(await walk(p)).map((r) => `${e.name}/${r}`));
		else if (e.name.endsWith(".md")) out.push(e.name);
	}
	return out;
}

/** List lessons across scopes. Each entry's `path` (no .md) IS the lesson summary. */
export async function listLessons({
	includeProject = true,
	cwd = process.cwd(),
} = {}) {
	const out = [];
	const seen = new Set();
	const scopes = ["global", ...(includeProject ? ["project"] : [])];
	for (const scope of scopes) {
		const root = lessonsRoot(scope, cwd);
		if (seen.has(root) || !(await exists(root))) {
			seen.add(root);
			continue;
		}
		seen.add(root);
		const rels = await walk(root);
		for (const rel of rels) {
			const fp = path.join(root, rel);
			const { fm } = parseFM(await readFile(fp));
			out.push({
				scope,
				path: rel.replace(/\.md$/, ""),
				file: fp,
				occurrences: parseInt(fm.occurrences || "1", 10) || 1,
				marked: String(fm.marked || "false") === "true",
				promoted: String(fm.promoted || "false") === "true",
				firstSeen: fm.firstSeen || null,
				lastSeen: fm.lastSeen || null,
			});
		}
	}
	return out;
}

/** List raw inbox captures (from the optional pi extension) for the agent to review/file. */
export async function inboxLessons({
	includeProject = true,
	cwd = process.cwd(),
} = {}) {
	const out = [];
	const seen = new Set();
	const scopes = ["global", ...(includeProject ? ["project"] : [])];
	for (const scope of scopes) {
		const root = lessonsRoot(scope, cwd);
		if (seen.has(root)) continue;
		seen.add(root);
		const dir = path.join(root, ".inbox");
		if (!(await exists(dir))) continue;
		let entries = [];
		try {
			entries = await fsp.readdir(dir);
		} catch {
			continue;
		}
		for (const name of entries)
			if (name.endsWith(".md"))
				out.push({ scope, name, file: path.join(dir, name) });
	}
	return out;
}

/**
 * Write/refresh a lesson at an agent-chosen relative path (may include subfolders).
 * Re-capturing the same path increments `occurrences` (recurrence) and clears the grace mark.
 */
export async function addLesson(
	relpath,
	{ body = null, scope = "global", cwd = process.cwd() } = {},
) {
	const clean =
		(typeof relpath === "string" ? relpath : "").replace(/\.md$/, "").trim() ||
		"untitled";
	const fp = await resolveLessonFile(clean, { scope, cwd });
	if (!fp)
		throw new Error("lesson path must stay inside the lessons directory");
	const now = new Date().toISOString();
	if (await exists(fp)) {
		const { fm, body: oldBody } = parseFM(await readFile(fp));
		const occ = (parseInt(fm.occurrences || "1", 10) || 1) + 1;
		const newFm = {
			...fm,
			occurrences: String(occ),
			lastSeen: now,
			marked: "false",
		}; // recurrence clears grace
		await writeFile(fp, buildFM(newFm) + (body ? body : oldBody));
		return { file: fp, created: false, occurrences: occ };
	}
	await ensureDir(path.dirname(fp));
	const fm = {
		occurrences: "1",
		firstSeen: now,
		lastSeen: now,
		marked: "false",
	};
	const tmpl =
		body ??
		`- **Lesson:** ${clean.split("/").pop()}\n  - What:\n  - When: ${now}\n  - How:\n  - Who:\n  - Why:\n  - Fix/avoid:\n  - Worth remembering:\n`;
	await writeFile(fp, `${buildFM(fm)}\n${tmpl}\n`);
	return { file: fp, created: true, occurrences: 1 };
}

/**
 * Derive a candidate lesson topic/slug from a raw inbox capture's content.
 * Prefers a `- Capture: <topic>` line; else the first non-empty body line
 * outside the YAML frontmatter block; else `fallbackName`. Pure string
 * transform — used by `agent-cli lessons triage --plan` to map each inbox item
 * to a suggested filing path without touching the filesystem.
 */
export function deriveTriageCandidate(content, fallbackName) {
	const capture = /^-\s*Capture:\s*(.+)$/m.exec(content);
	const lines = content.split(/\r?\n/).map((l) => l.trim());
	let inFm = false;
	const first = lines.find((l) => {
		if (l.startsWith("---")) {
			inFm = !inFm;
			return false;
		}
		return (
			!inFm &&
			l &&
			!l.startsWith("#") &&
			!l.startsWith("-") &&
			!l.startsWith("---")
		);
	});
	const topic = (capture ? capture[1] : first || fallbackName).trim();
	return {
		candidate: topic
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, ""),
		topic,
	};
}

export async function removeInbox(file) {
	try {
		await fsp.unlink(file);
		return true;
	} catch {
		return false;
	}
}

/** File inbox item <index> as a lesson at <relpath>, then delete the inbox file. */
export async function fileInboxItem(
	index,
	relpath,
	{ cwd = process.cwd() } = {},
) {
	const inbox = await inboxLessons({ includeProject: true, cwd });
	const item = inbox[index];
	if (!item) return { ok: false, reason: "no such inbox index" };
	const content = await readFile(item.file);
	const r = await addLesson(relpath, { body: content, scope: item.scope, cwd });
	await removeInbox(item.file);
	return { ok: true, filedTo: r.file, from: item.file };
}
/** Delete inbox item <index>. */
export async function deleteInboxItem(index, { cwd = process.cwd() } = {}) {
	const inbox = await inboxLessons({ includeProject: true, cwd });
	const item = inbox[index];
	if (!item) return { ok: false, reason: "no such inbox index" };
	await removeInbox(item.file);
	return { ok: true, deleted: item.file };
}

/** Delete ALL raw inbox captures across scopes. Returns { deleted, files }. */
export async function clearInbox({
	includeProject = true,
	cwd = process.cwd(),
} = {}) {
	const files = [];
	const seen = new Set();
	const scopes = ["global", ...(includeProject ? ["project"] : [])];
	for (const scope of scopes) {
		const root = lessonsRoot(scope, cwd);
		if (seen.has(root)) continue;
		seen.add(root);
		const dir = path.join(root, ".inbox");
		if (!(await exists(dir))) continue;
		let entries = [];
		try {
			entries = await fsp.readdir(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.endsWith(".md")) continue;
			const fp = path.join(dir, name);
			await removeInbox(fp);
			files.push(fp);
		}
	}
	return { deleted: files.length, files };
}

/**
 * Write a raw capture into `lessons/.inbox/` for later triage (revives the dead
 * triage loop — nothing in the tool wrote .inbox before). Records the source
 * session/repo/branch in frontmatter.
 */
export async function addInboxCapture(
	topic,
	{
		body = null,
		scope = "global",
		cwd = process.cwd(),
		sourceSession = null,
		repo = null,
		branch = null,
	} = {},
) {
	const clean =
		(typeof topic === "string" ? topic : "").replace(/\.md$/, "").trim() ||
		"untitled";
	const dir = path.join(lessonsRoot(scope, cwd), ".inbox");
	await ensureDir(dir);
	const safe = clean.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	let file = path.join(dir, `${safe}.md`);
	let n = 2;
	while (await exists(file)) file = path.join(dir, `${safe}-${n++}.md`);
	const fm = {
		sourceSession: sourceSession ?? "",
		repo: repo ?? "",
		branch: branch ?? "",
		capturedAt: new Date().toISOString(),
	};
	const content =
		`---\n${Object.entries(fm)
			.map(([k, v]) => `${k}: ${v}`)
			.join("\n")}\n---\n` +
		(body ?? `- Capture: ${clean}\n  - What:\n  - Context:\n`);
	await writeFile(file, content);
	return { ok: true, file, scope, inbox: true };
}
