// Search tests: src/search.js tokenized TF + filename retrieval.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_CLI_HOME = mkdtempSync(path.join(tmpdir(), "agent-search-"));
const search = await import("../src/search.js");
const HOME = process.env.AGENT_CLI_HOME;

function mklessons(dir) {
	mkdirSync(path.join(dir, "git"), { recursive: true });
	return path.join(dir, "git");
}

test("tokenize normalizes and drops stopwords and short tokens", () => {
	assert.deepEqual(search.tokenize("Merge Git branches"), ["merge", "git", "branches"]);
	assert.deepEqual(search.tokenize("the and for a"), []);
	assert.deepEqual(search.tokenize("  Mixed-Case 123 "), ["mixed", "case", "123"]);
});

test("searchAll finds a global lesson by content and filename", async () => {
	const dir = mklessons(path.join(HOME, ".agents", "lessons"));
	writeFileSync(
		path.join(dir, "merge.md"),
		"---\noccurrences: 1\n---\nHow to merge git branches safely.\n",
		"utf8",
	);
	const r = await search.searchAll("merge");
	assert.ok(r.results.length >= 1);
	const hit = r.results.find((x) => x.path.endsWith("merge.md"));
	assert.ok(hit);
	assert.ok(hit.score >= 4); // content (1) + filename bonus (3)
	assert.ok(hit.excerpt.includes("merge"));
});

test("searchAll project scope finds project lessons", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "search-proj-"));
	const dir = mklessons(path.join(cwd, ".agents", "lessons"));
	writeFileSync(
		path.join(dir, "rebase.md"),
		"---\noccurrences: 1\n---\nRebasing keeps history clean.\n",
		"utf8",
	);
	const r = await search.searchAll("rebase", { project: true, cwd });
	assert.ok(r.results.some((x) => x.path.endsWith("rebase.md")));
	// global-only search must NOT see the project lesson
	const g = await search.searchAll("rebase", { project: false, cwd });
	assert.ok(!g.results.some((x) => x.path.endsWith("rebase.md")));
});

test("searchAll kind filters scope to identity files", async () => {
	const idPath = path.join(HOME, ".agents", "IDENTITY.md");
	writeFileSync(idPath, "# Identity\n\n<AGENT_ROLE>marvin the detective</AGENT_ROLE>\n", "utf8");
	const r = await search.searchAll("detective", { kind: "identity" });
	assert.ok(r.results.some((x) => x.kind === "identity" && x.path.endsWith("IDENTITY.md")));
	// spect kind should not surface identity
	const spect = await search.searchAll("detective", { kind: "spect" });
	assert.ok(!spect.results.some((x) => x.kind === "identity"));
});

test("searchAll ranks exact content matches above filename-only matches", async () => {
	const dir = mklessons(path.join(HOME, ".agents", "lessons"));
	writeFileSync(path.join(dir, "deploy.md"), "---\n---\nKubernetes deploy strategies\n", "utf8");
	writeFileSync(
		path.join(dir, "kubernetes.md"),
		"---\n---\nkubernetes kubernetes kubernetes\n",
		"utf8",
	);
	const r = await search.searchAll("kubernetes", { limit: 10 });
	const sorted = [...r.results].sort((a, b) => b.score - a.score);
	assert.equal(sorted[0].path.endsWith("kubernetes.md"), true);
});

test("searchLessons returns per-file occurrences, marked, and excerpt", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "search-less-"));
	const dir = mklessons(path.join(cwd, ".agents", "lessons"));
	writeFileSync(
		path.join(dir, "git-tips.md"),
		"---\noccurrences: 3\nmarked: true\n---\nUse git status often\n",
		"utf8",
	);
	const r = await search.searchLessons("git", { includeProject: true, cwd });
	const hit = r.results.find((x) => x.path.endsWith("git-tips.md"));
	assert.ok(hit);
	assert.equal(hit.occurrences, 3);
	assert.equal(hit.marked, true);
	assert.ok(hit.excerpt.includes("git"));
});

test("searchExcludes marks machine-local files that must not surface", () => {
	const ex = search.searchExcludes();
	assert.ok(ex.some((p) => p.includes(".secrets.json")));
	assert.ok(ex.some((p) => p.includes(".consolidate-state.json")));
});

test("empty/stopword queries return no results", async () => {
	const r = await search.searchAll("the and for");
	assert.deepEqual(r.results, []);
});
