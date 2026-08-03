import { test } from "node:test";
import assert from "node:assert";
import {
	TARGETS,
	getTarget,
	pathFor,
	scopesFor,
	targetsWithScope,
	adaptContent,
} from "../src/targets.js";

test("target ids are unique", () => {
	const ids = TARGETS.map((t) => t.id);
	assert.equal(ids.length, new Set(ids).size);
});

test("every target has id, name, docs, and at least one scope", () => {
	for (const t of TARGETS) {
		assert.ok(t.id, "missing id");
		assert.ok(t.name, "missing name");
		assert.ok(t.docs, "missing docs for " + t.id);
		assert.ok(t.global || t.project, t.id + " has no path");
	}
});

test("pathFor returns the native path per scope (or null)", () => {
	const claude = getTarget("claude");
	assert.equal(pathFor(claude, "global"), ".claude/CLAUDE.md");
	assert.equal(pathFor(claude, "project"), "CLAUDE.md");

	const cursor = getTarget("cursor");
	assert.equal(pathFor(cursor, "global"), null);
	assert.equal(pathFor(cursor, "project"), ".cursor/rules/agent-cli.mdc");
});

test("scopesFor lists supported scopes", () => {
	assert.deepEqual(scopesFor(getTarget("claude")).sort(), [
		"global",
		"project",
	]);
	assert.deepEqual(scopesFor(getTarget("cursor")), ["project"]);
});

test("cursor transform adds alwaysApply frontmatter", () => {
	const cursor = getTarget("cursor");
	const out = adaptContent(cursor, "BODY", { scope: "project" });
	assert.match(out, /^---\n/);
	assert.match(out, /alwaysApply: true/);
	assert.match(out, /BODY$/);
});

test("targetsWithScope filters correctly", () => {
	assert.ok(targetsWithScope("global").length >= 4);
	assert.ok(targetsWithScope("project").length >= TARGETS.length - 1);
});

test("we cover the major agents", () => {
	const ids = TARGETS.map((t) => t.id);
	for (const id of [
		"claude",
		"codex",
		"pi",
		"gemini",
		"cursor",
		"windsurf",
		"cline",
		"copilot",
	]) {
		assert.ok(ids.includes(id), "missing " + id);
	}
});

test("getTarget returns null for an unknown id", () => {
	assert.equal(getTarget("nope-not-a-target"), null);
});

test("pathFor returns null for an unsupported or unknown scope", () => {
	assert.equal(pathFor(getTarget("claude"), "bogus-scope"), null);
	assert.equal(pathFor(getTarget("cursor"), "global"), null); // cursor is project-only
});

test("adaptContent passes content through unchanged when there's no transform", () => {
	assert.equal(
		adaptContent(getTarget("claude"), "BODY", { scope: "global" }),
		"BODY",
	);
});
