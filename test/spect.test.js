import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	initSpect,
	inspectSpect,
	spectFiles,
	templatePaths,
} from "../src/spect.js";

function project() {
	return mkdtempSync(path.join(tmpdir(), "agent-spect-"));
}

test("spect init is project-local and creates the workflow layout", async () => {
	const cwd = project();
	const result = await initSpect(cwd);
	assert.equal(result.root, path.join(cwd, ".spect"));
	assert.ok(result.created.includes("constitution.md"));
	assert.ok(existsSync(path.join(cwd, ".spect", "specs")));
	assert.ok(existsSync(path.join(cwd, ".spect", "plans")));
	assert.ok(existsSync(path.join(cwd, ".spect", "tasks")));
	assert.equal(existsSync(path.join(cwd, "SPECT.md")), false);
});

test("spect init is idempotent and never overwrites project-owned content", async () => {
	const cwd = project();
	await initSpect(cwd);
	const files = spectFiles(cwd);
	writeFileSync(files.constitution, "# User constitution\n", "utf8");
	const second = await initSpect(cwd);
	assert.ok(second.skipped.includes("constitution.md"));
	assert.equal(
		readFileSync(files.constitution, "utf8"),
		"# User constitution\n",
	);
});

test("inspectSpect reports an uninitialized project without creating files", async () => {
	const cwd = project();
	const result = await inspectSpect(cwd);
	assert.equal(result.initialized, false);
	assert.deepEqual(result.load, []);
	assert.equal(existsSync(path.join(cwd, ".spect")), false);
});

test("inspectSpect marks a partial SPECT directory incomplete and reports missing files", async () => {
	const cwd = project();
	const files = spectFiles(cwd);
	await import("node:fs/promises").then(({ mkdir }) => mkdir(files.root, { recursive: true }));
	const result = await inspectSpect(cwd);
	assert.equal(result.initialized, false);
	assert.equal(result.partial, true);
	assert.ok(result.missingFiles.includes(files.readme));
});

test("inspectSpect discovers only markdown specs, plans, and tasks", async () => {
	const cwd = project();
	await initSpect(cwd);
	writeFileSync(path.join(cwd, ".spect", "specs", "SPEC-001.md"), "# spec\n");
	writeFileSync(path.join(cwd, ".spect", "specs", "secret.txt"), "ignore\n");
	writeFileSync(path.join(cwd, ".spect", "plans", "PLAN-001.md"), "# plan\n");
	const result = await inspectSpect(cwd);
	assert.equal(result.counts.specs, 1);
	assert.equal(result.counts.plans, 1);
	assert.equal(result.counts.tasks, 0);
	assert.ok(result.load.some((file) => file.endsWith("SPEC-001.md")));
	assert.equal(
		result.load.some((file) => file.endsWith("secret.txt")),
		false,
	);
});

test("spect guidance is opt-in and defines the quality loop", async () => {
	const cwd = project();
	await initSpect(cwd);
	const readme = readFileSync(spectFiles(cwd).readme, "utf8");
	assert.match(readme, /SPECT is optional/);
	assert.match(readme, /ask the user before initializing/);
	assert.match(readme, /specify → plan → decompose → implement/);
});

test("templatePaths stays within the project SPECT directory", () => {
	const cwd = project();
	for (const file of Object.values(templatePaths(cwd)))
		assert.ok(file.startsWith(path.join(cwd, ".spect") + path.sep));
});
