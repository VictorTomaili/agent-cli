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

test("adaptContent is a passthrough for every target without a transform", () => {
	const untransformed = TARGETS.filter(
		(t) => typeof t.transform !== "function",
	);
	assert.ok(untransformed.length > 0);
	for (const t of untransformed) {
		assert.equal(
			adaptContent(t, "BODY", { scope: "project" }),
			"BODY",
			t.id + " must pass content through untouched",
		);
	}
});

test("every target with a transform is adapted through adaptContent", () => {
	const transformed = TARGETS.filter(
		(t) => typeof t.transform === "function",
	);
	assert.ok(transformed.length >= 1, "expected at least one transformed target");
	for (const t of transformed) {
		const out = adaptContent(t, "BODY", { scope: "project" });
		assert.ok(typeof out === "string", t.id + " transform must return a string");
		assert.ok(out.includes("BODY"), t.id + " transform must keep the body");
		assert.notEqual(out, "BODY", t.id + " transform must actually wrap the body");
	}
});

test("cursor transform wraps pointer stub output in alwaysApply frontmatter", () => {
	const cursor = getTarget("cursor");
	const body = "<!-- agent-cli-pointer -->\n<!-- target: cursor -->\n# body\n";
	const out = adaptContent(cursor, body, { scope: "project" });
	assert.match(out, /^---\n/);
	assert.match(out, /description: Synced by agent-cli/);
	assert.match(out, /alwaysApply: true/);
	// frontmatter must precede the pointer marker so .mdc always-apply loads
	assert.ok(out.indexOf("---") < out.indexOf("<!-- agent-cli-pointer -->"));
	assert.ok(out.trim().endsWith("# body"));
});
