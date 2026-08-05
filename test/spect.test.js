import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	initSpect,
	inspectSpect,
	spectFiles,
	templatePaths,
	parseTaskLine,
	parseTasks,
	setTaskStatus,
	parseSpecReqs,
	validateSpect,
	reportSpect,
	traceSpect,
	nextTask,
	closeTask,
	spectHeadline,
} from "../src/spect.js";

function project() {
	return mkdtempSync(path.join(tmpdir(), "agent-spect-"));
}

function writeSpec(cwd, id, reqs) {
	const dir = path.join(cwd, ".spect", "specs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, `${id}.md`),
		[
			`# ${id}: title`,
			"",
			...reqs.flatMap((r) =>
				r.verification
					? [`- ${r.id}: ${r.criterion}`, `  - Verification: ${r.verification}`]
					: [`- ${r.id}: ${r.criterion}`],
			),
		].join("\n"),
		"utf8",
	);
}

function writeTasks(cwd, id, lines) {
	const dir = path.join(cwd, ".spect", "tasks");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, `${id}.md`), `# ${id}\n\n${lines.join("\n")}\n`, "utf8");
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
	await import("node:fs/promises").then(({ mkdir }) =>
		mkdir(files.root, { recursive: true }),
	);
	const result = await inspectSpect(cwd);
	assert.equal(result.initialized, false);
	assert.equal(result.partial, true);
	assert.ok(result.missingFiles.includes(files.readme));
});

// ---------------------------------------------------------------------------
// Executable task workflow
// ---------------------------------------------------------------------------

test("parseTaskLine parses checkboxes, ids, REQ refs, and titles", () => {
	const open = parseTaskLine("- [ ] TASK-001 [REQ-001] [REQ-002] build the thing");
	assert.deepEqual(open, {
		done: false,
		id: "TASK-001",
		reqs: ["REQ-001", "REQ-002"],
		title: "build the thing",
	});
	const done = parseTaskLine("- [x] TASK-002 [REQ-001] verify");
	assert.equal(done.done, true);
	assert.equal(done.id, "TASK-002");
	assert.equal(parseTaskLine("# not a task"), null);
});

test("parseTasks reads all task files in order", async () => {
	const cwd = project();
	await initSpect(cwd);
	writeTasks(cwd, "TASKS-01", ["- [ ] TASK-001 [REQ-001] a", "- [x] TASK-002 b"]);
	writeTasks(cwd, "TASKS-02", ["- [ ] TASK-003 [REQ-002] c"]);
	const tasks = await parseTasks(cwd);
	assert.deepEqual(tasks.map((t) => t.id), ["TASK-001", "TASK-002", "TASK-003"]);
	assert.equal(tasks[0].reqs[0], "REQ-001");
	assert.equal(tasks[1].title, "b");
});

test("setTaskStatus toggles a task by stable id and reports not-found", async () => {
	const cwd = project();
	await initSpect(cwd);
	writeTasks(cwd, "TASKS-01", ["- [ ] TASK-001 [REQ-001] a"]);
	const r = await setTaskStatus(cwd, "TASK-001", true);
	assert.equal(r.ok, true);
	assert.equal(r.done, true);
	assert.match(readFileSync(r.file, "utf8"), /\[x\] TASK-001/);
	await setTaskStatus(cwd, "TASK-001", false);
	assert.match(readFileSync(r.file, "utf8"), /\[ \] TASK-001/);
	const missing = await setTaskStatus(cwd, "TASK-999", true);
	assert.equal(missing.ok, false);
});

test("parseSpecReqs captures REQ criteria and Verification lines", () => {
	const reqs = parseSpecReqs(
		"# S\n\n- REQ-001: works\n  - Verification: test x\n- REQ-002: fast\n",
	);
	assert.equal(reqs.length, 2);
	assert.equal(reqs[0].id, "REQ-001");
	assert.equal(reqs[0].criterion, "works");
	assert.equal(reqs[0].verification, "test x");
	assert.equal(reqs[1].verification, null);
});

test("validateSpect flags dangling task REQs and orphan spec REQs", async () => {
	const cwd = project();
	await initSpect(cwd);
	writeSpec(cwd, "SPEC-01", [
		{ id: "REQ-001", criterion: "works", verification: "t" },
		{ id: "REQ-002", criterion: "fast" },
	]);
	writeTasks(cwd, "TASKS-01", [
		"- [ ] TASK-001 [REQ-001] a",
		"- [ ] TASK-002 [REQ-999] dangling",
	]);
	const r = await validateSpect(cwd);
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((i) => i.type === "dangling-task-req" && i.req === "REQ-999"));
	assert.ok(r.issues.some((i) => i.type === "orphan-req" && i.req === "REQ-002"));
});

test("reportSpect produces per-REQ coverage with status", async () => {
	const cwd = project();
	await initSpect(cwd);
	writeSpec(cwd, "SPEC-01", [
		{ id: "REQ-001", criterion: "works", verification: "t" },
		{ id: "REQ-002", criterion: "fast" },
	]);
	writeTasks(cwd, "TASKS-01", ["- [ ] TASK-001 [REQ-001] a"]);
	const r = await reportSpect(cwd);
	assert.equal(r.ok, true);
	const byId = Object.fromEntries(r.reqs.map((q) => [q.req, q]));
	assert.equal(byId["REQ-001"].status, "done"); // implemented + verified
	assert.equal(byId["REQ-002"].status, "defined"); // not implemented
	const scoped = await reportSpect(cwd, { spec: "SPEC-01" });
	assert.equal(scoped.reqs.length, 2);
	const missing = await reportSpect(cwd, { spec: "SPEC-99" });
	assert.equal(missing.ok, false);
});

test("traceSpect links REQ→TASK→verification and flags gaps", async () => {
	const cwd = project();
	await initSpect(cwd);
	writeSpec(cwd, "SPEC-01", [
		{ id: "REQ-001", criterion: "works", verification: "t" },
		{ id: "REQ-002", criterion: "fast" },
	]);
	writeTasks(cwd, "TASKS-01", ["- [ ] TASK-001 [REQ-001] a"]);
	const r = await traceSpect("SPEC-01", cwd);
	assert.equal(r.ok, true);
	const req1 = r.reqs.find((q) => q.id === "REQ-001");
	assert.deepEqual(req1.tasks.map((t) => t.id), ["TASK-001"]);
	assert.equal(req1.verified, true);
	assert.ok(r.issues.some((i) => i.type === "orphan-req" && i.req === "REQ-002"));
	assert.ok(r.issues.some((i) => i.type === "unverified-req" && i.req === "REQ-002"));
	const missing = await traceSpect("SPEC-99", cwd);
	assert.equal(missing.ok, false);
});

test("nextTask returns the first open task with acceptance criteria", async () => {
	const cwd = project();
	await initSpect(cwd);
	writeSpec(cwd, "SPEC-01", [{ id: "REQ-001", criterion: "works", verification: "t" }]);
	writeTasks(cwd, "TASKS-01", ["- [ ] TASK-001 [REQ-001] a"]);
	const r = await nextTask(cwd);
	assert.equal(r.task.id, "TASK-001");
	assert.equal(r.acceptance[0].criterion, "works");
	// nothing left after closing all
	await setTaskStatus(cwd, "TASK-001", true);
	const done = await nextTask(cwd);
	assert.equal(done.nothingToDo, true);
});

test("closeTask marks done and suggests a lesson + snapshot", async () => {
	const cwd = project();
	await initSpect(cwd);
	writeTasks(cwd, "TASKS-01", ["- [ ] TASK-001 [REQ-001] a"]);
	const r = await closeTask(cwd, "TASK-001");
	assert.equal(r.ok, true);
	assert.match(readFileSync(r.file, "utf8"), /\[x\] TASK-001/);
	assert.match(r.lesson.suggestion, /lessons add/);
	assert.equal(r.snapshotSuggestion, "agent snapshot");
});

test("spectHeadline reports counts and open tasks", async () => {
	const cwd = project();
	await initSpect(cwd);
	writeTasks(cwd, "TASKS-01", ["- [ ] TASK-001 a", "- [x] TASK-002 b"]);
	const h = await spectHeadline(cwd);
	assert.equal(h.initialized, true);
	assert.equal(h.taskCount, 2);
	assert.equal(h.open, 1);
	assert.equal(h.done, 1);
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
