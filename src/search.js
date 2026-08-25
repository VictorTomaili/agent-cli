// src/search.js — local memory retrieval over the agent brain.
// Tokenized TF + filename scoring (no external deps). An embedding provider can
// slot in behind the same contract later. Search is read-only and never touches
// machine-local files that should not be surfaced.

import fs from "node:fs/promises";
import path from "node:path";
import { HOME, AGENTS_DIR, exists } from "./util.js";
import { lessonsRoot, listLessons, parseFM } from "./lessons-lib.js";
import { spectRoot } from "./spect.js";

const STOPWORDS = new Set([
	"the", "and", "for", "with", "you", "your", "this", "that", "have",
	"has", "are", "was", "were", "but", "not", "all", "can", "will", "from",
	"our", "their", "they", "them", "there", "here", "what", "when", "which",
	"who", "whom", "how", "why", "its", "it's", "one", "two", "new", "any",
]);

/** Tokenize a query/content into normalized search terms. */
export function tokenize(text) {
	return String(text ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.split(" ")
		.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function scoreContent(tokens, content, filename) {
	let score = 0;
	const matched = [];
	for (const t of tokens) {
		const re = new RegExp(t, "gi");
		const count = (content.match(re) || []).length;
		if (count > 0) {
			score += count;
			matched.push(t);
		}
	}
	const base = path.basename(filename).toLowerCase();
	for (const t of tokens) {
		if (base.includes(t)) {
			score += 3;
			if (!matched.includes(t)) matched.push(t);
		}
	}
	return { score, matchedTokens: matched };
}

/** Best excerpt line (the one with the most query-token hits); falls back to the
 *  first non-empty content line (lesson filenames ARE the summaries here). */
function excerptLine(tokens, content) {
	const lines = content.split(/\r?\n/);
	let best = null;
	let bestScore = 0;
	let firstContent = null;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (firstContent == null) firstContent = trimmed.slice(0, 200);
		const hits = tokens.filter((t) => trimmed.toLowerCase().includes(t)).length;
		if (hits > bestScore) {
			bestScore = hits;
			best = trimmed.slice(0, 200);
		}
	}
	return best || firstContent || "";
}

async function readIfMd(file) {
	if (!(await exists(file))) return null;
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return null;
	}
}

async function walkMd(dir) {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		const out = [];
		for (const e of entries) {
			if (e.name.startsWith(".")) continue; // skip .inbox etc.
			const p = path.join(dir, e.name);
			if (e.isDirectory()) out.push(...(await walkMd(p)));
			else if (e.name.endsWith(".md")) out.push(p);
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Rank search hits across the brain.
 * kinds: lessons | identity | spect | all. scope: global, project, or both.
 * Returns { query, results: [{ path, scope, score, excerpt, tokens }] }.
 */
export async function searchAll(
	query,
	{ kind = "all", project = false, limit = 10, cwd = process.cwd() } = {},
) {
	const tokens = tokenize(query);
	if (!tokens.length) return { query, results: [] };

	const candidates = [];
	const scopeList = project ? ["project", "global"] : ["global"];

	for (const scope of scopeList) {
		const base = scope === "project" ? cwd : HOME;
		const brain = path.join(base, ".agents");
		if (kind === "lessons" || kind === "all") {
			const dir = lessonsRoot(scope, cwd);
			candidates.push(
				...(await walkMd(dir)).map((p) => ({
					path: p,
					scope,
					kind: "lesson",
				})),
			);
			const core = path.join(brain, "LESSONS.md");
			if (await exists(core))
				candidates.push({ path: core, scope, kind: "lesson" });
		}
		if (kind === "identity" || kind === "all") {
			for (const name of [
				"IDENTITY.md",
				"SOUL.md",
				"USER.md",
				"ENVIRONMENTS.md",
				"MODELS.md",
			]) {
				const p = path.join(brain, name);
				if (await exists(p))
					candidates.push({ path: p, scope, kind: "identity" });
			}
		}
		if (kind === "spect" || kind === "all") {
			if (scope === "project") {
				const root = spectRoot(cwd);
				candidates.push(
					...(await walkMd(root)).map((p) => ({ path: p, scope, kind: "spect" })),
				);
			}
		}
	}

	const results = [];
	for (const c of candidates) {
		const content = await readIfMd(c.path);
		if (content == null) continue;
		const { score, matchedTokens } = scoreContent(tokens, content, c.path);
		if (score <= 0) continue;
		results.push({
			path: c.path,
			scope: c.scope,
			kind: c.kind,
			score,
			excerpt: excerptLine(tokens, content),
			tokens: matchedTokens,
		});
	}
	results.sort((a, b) => b.score - a.score);
	return { query, results: results.slice(0, limit) };
}

/** Scoped lessons search: per-file occurrences + marked + excerpt. */
export async function searchLessons(
	query,
	{ includeProject = true, limit = 10, cwd = process.cwd() } = {},
) {
	const tokens = tokenize(query);
	if (!tokens.length) return { query, results: [] };
	const items = await listLessons({ includeProject, cwd });
	const results = [];
	for (const item of items) {
		const content = await readIfMd(item.file);
		if (content == null) continue;
		const { score, matchedTokens } = scoreContent(tokens, content, item.file);
		if (score <= 0) continue;
		results.push({
			path: item.file,
			scope: item.scope,
			occurrences: item.occurrences,
			marked: item.marked,
			score,
			excerpt: excerptLine(tokens, content),
			tokens: matchedTokens,
		});
	}
	results.sort((a, b) => b.score - a.score);
	return { query, results: results.slice(0, limit) };
}

/** Paths the search must NOT surface (secrets/state). */
export function searchExcludes() {
	return [path.join(AGENTS_DIR, ".secrets.json"), path.join(AGENTS_DIR, ".consolidate-state.json")];
}
