// src/spect.js — project-local specification-driven development workflow.
// SPECT state is deliberately scoped to cwd/.spect; it never touches ~/.agents.

import fs from "node:fs/promises";
import path from "node:path";

export const SPECT_DIR_NAME = ".spect";

const FILE_TEMPLATES = {
	"README.md": `# SPECT — specification-driven development

This project uses SPECT as a living specification workflow.

## Workflow

1. Write or update a specification before implementation.
2. Express requirements as scenarios with stable IDs and testable acceptance criteria.
3. Decompose the specification into a plan and traceable tasks.
4. Implement one task at a time; keep the specification honest when reality changes.
5. Verify every acceptance criterion and record the relevant tests before declaring done.

## Task-start guidance

SPECT is optional. If the user explicitly requests specification-driven development,
run agent-cli spect init in the project directory when it is absent. If the project already
has .spect, read this README, constitution.md, and the relevant specs, plans, and tasks,
then follow the SPECT loop below.

For ordinary tasks, do not initialize SPECT or create .spect automatically. If SPECT
would materially help, explain the option and ask the user before initializing it.

When SPECT is active, use this loop:
specify → plan → decompose → implement → verify → review → refactor → re-verify.
A failed check returns to implementation; do not declare done with an open failure.

## Layout

- \`constitution.md\` — project-wide principles and constraints.
- \`specs/\` — product, technical, and integration specifications.
- \`plans/\` — implementation plans and design decisions.
- \`tasks/\` — executable task checklists.
- \`templates/\` — starting templates; copy, then customize.

Read the relevant specification before changing code. Update the specification before
changing an agreed requirement. Do not treat this directory as a changelog.
`,
	"constitution.md": `# Project Constitution

> Project-wide principles that every specification and implementation must respect.
> Replace these starters with the project's actual constraints.

## Principles

- Keep requirements explicit, testable, and traceable to implementation tasks.
- Prefer the smallest safe change that satisfies the acceptance criteria.
- Preserve compatibility unless a specification explicitly approves a breaking change.
- Validate behavior with automated tests and document meaningful verification gaps.

## Constraints

- Runtime and supported platforms: (fill in)
- Security and privacy requirements: (fill in)
- Performance or reliability requirements: (fill in)
`,
	"templates/spec.md": `# SPEC-<id>: <short title>

Status: draft

## Problem

What user or system problem does this solve?

## Goals

- <goal>

## Non-goals

- <explicitly excluded behavior>

## Scenarios and acceptance criteria

### SCN-001: <scenario>

Given <precondition>, when <action>, then <observable result>.

- REQ-001: <testable acceptance criterion>
  - Verification: <test or evidence>

## Constraints

- <technical, security, compatibility, or operational constraint>

## Interfaces and data

- <API, CLI, event, schema, or user-facing contract>

## Open questions

- <question or decision needed>
`,
	"templates/plan.md": `# PLAN-<id>: <short title>

Spec: \`../specs/SPEC-<id>.md\`
Status: draft

## Decisions

- <decision and rationale>

## Implementation sequence

1. <bounded step with file or symbol targets>

## Verification plan

- REQ-001 → <test command or test file>

## Risks and rollback

- <risk> — <mitigation or rollback>
`,
	"templates/tasks.md": `# TASKS-<id>: <short title>

Spec: \`../specs/SPEC-<id>.md\`
Plan: \`../plans/PLAN-<id>.md\`

- [ ] TASK-001 [REQ-001] <bounded implementation task>
- [ ] TASK-002 [REQ-001] Add or update verification
- [ ] TASK-003 [REQ-001] Review implementation against the specification
`,
};

const DIRS = ["specs", "plans", "tasks", "templates"];

export function spectRoot(cwd = process.cwd()) {
	return path.join(path.resolve(cwd), SPECT_DIR_NAME);
}

export function spectFiles(cwd = process.cwd()) {
	const root = spectRoot(cwd);
	return {
		root,
		readme: path.join(root, "README.md"),
		constitution: path.join(root, "constitution.md"),
		specs: path.join(root, "specs"),
		plans: path.join(root, "plans"),
		tasks: path.join(root, "tasks"),
		templates: path.join(root, "templates"),
	};
}

async function exists(file) {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

/** Is `candidate` inside `root` (both resolved to real paths)?
 *  For a not-yet-existing file, resolve the nearest existing ancestor and
 *  verify it stays under root. */
async function containedIn(root, candidate) {
	try {
		const rootReal = await fs.realpath(root);
		let probe = candidate;
		for (;;) {
			try {
				const candReal = await fs.realpath(probe);
				const sep = path.sep;
				return (
					candReal === rootReal ||
					candReal.startsWith(rootReal + sep)
				);
			} catch {
				const parent = path.dirname(probe);
				if (parent === probe) return false; // hit the fs root
				probe = parent;
			}
		}
	} catch {
		return false;
	}
}

/** Initialize project-local SPECT files without overwriting user content. */
export async function initSpect(cwd = process.cwd()) {
	const files = spectFiles(cwd);
	// GAP-3: refuse to initialize into a symlinked/junctioned .spect — a link
	// to outside the project root would make every template write escape.
	if (await exists(files.root) && !(await containedIn(files.root, files.root))) {
		return {
			ok: false,
			reason: ".spect resolves outside the project root (symlink escape)",
			root: files.root,
		};
	}
	await fs.mkdir(files.root, { recursive: true });
	for (const dir of DIRS) {
		const full = path.join(files.root, dir);
		await fs.mkdir(full, { recursive: true });
		if (!(await containedIn(files.root, full))) {
			return {
				ok: false,
				reason: `${dir} resolves outside the project root (symlink escape)`,
				root: files.root,
			};
		}
	}
	const created = [];
	const skipped = [];
	for (const [relative, content] of Object.entries(FILE_TEMPLATES)) {
		const target = path.join(files.root, relative);
		if (await exists(target)) {
			skipped.push(relative);
			continue;
		}
		if (!(await containedIn(files.root, target))) {
			return {
				ok: false,
				reason: `${relative} resolves outside the project root (symlink escape)`,
				root: files.root,
			};
		}
		await fs.writeFile(target, content, "utf8");
		created.push(relative);
	}
	return { root: files.root, created, skipped, directories: DIRS };
}

async function listMarkdown(dir) {
	if (!(await exists(dir))) return [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	return entries
		.filter(
			// GAP-3: skip symlinks/junctions — a malicious .spect could link a
			// tasks/plan file to a path outside the project root, and writes
			// (setTaskStatus etc.) would follow it.
			(entry) =>
				entry.isFile() &&
				!entry.isSymbolicLink() &&
				entry.name.toLowerCase().endsWith(".md"),
		)
		.map((entry) => path.join(dir, entry.name))
		.sort();
}

/** Return a read manifest for an existing project-local SPECT workflow. */
export async function inspectSpect(cwd = process.cwd()) {
	const files = spectFiles(cwd);
	const rootExists = await exists(files.root);
	if (!rootExists) {
		return {
			initialized: false,
			partial: false,
			root: files.root,
			load: [],
			missing: [],
			missingFiles: [],
			counts: { specs: 0, plans: 0, tasks: 0 },
		};
	}
	const expectedFiles = [
		files.readme,
		files.constitution,
		path.join(files.templates, "spec.md"),
		path.join(files.templates, "plan.md"),
		path.join(files.templates, "tasks.md"),
	];
	const expectedDirs = [files.specs, files.plans, files.tasks, files.templates];
	const [specs, plans, tasks] = await Promise.all([
		listMarkdown(files.specs),
		listMarkdown(files.plans),
		listMarkdown(files.tasks),
	]);
	const missingFiles = [];
	for (const file of expectedFiles)
		if (!(await exists(file))) missingFiles.push(file);
	const missing = [
		...missingFiles,
		...(
			await Promise.all(
				expectedDirs.map(async (dir) => ((await exists(dir)) ? null : dir)),
			)
		).filter(Boolean),
	];
	const load = [
		...expectedFiles.filter((file) => !missingFiles.includes(file)),
		...specs,
		...plans,
		...tasks,
	];
	return {
		initialized: missing.length === 0,
		partial: missing.length > 0,
		root: files.root,
		load,
		missing,
		missingFiles,
		counts: { specs: specs.length, plans: plans.length, tasks: tasks.length },
	};
}

export function templatePaths(cwd = process.cwd()) {
	const { templates } = spectFiles(cwd);
	return Object.fromEntries(
		Object.keys(FILE_TEMPLATES)
			.filter((file) => file.startsWith("templates/"))
			.map((file) => [
				path.basename(file, ".md"),
				path.join(templates, path.basename(file)),
			]),
	);
}

// ---------------------------------------------------------------------------
// Executable task workflow — parse `- [ ] TASK-001 [REQ-001] <title>` checklists
// ---------------------------------------------------------------------------

const TASK_ID =
	/^(\s*-\s+)\[([ xX])\]\s+([A-Za-z0-9][\w.-]*)((?:\s+\[([^\]]+)\])*)\s*(.*)$/;
const REQ_IN_BRACKETS = /\[(REQ-[\w.-]+)\]/g;
const REQ_LINE = /^\s*[-*]\s*REQ-([\w.-]+):\s*(.*)$/;
const VERIFY_LINE = /^\s*[-*]\s*Verification:\s*(.*)$/;

/** Parse a single task checklist line, or null when it is not a task. */
export function parseTaskLine(line) {
	const m = TASK_ID.exec(line);
	if (!m) return null;
	return {
		done: m[2].toLowerCase() === "x",
		id: m[3],
		reqs: [...(m[4] || "").matchAll(REQ_IN_BRACKETS)].map((x) => x[1]),
		title: (m[6] || "").trim(),
	};
}

/** Parse every task checkbox across `tasks/*.md`, in file/line order. */
export async function parseTasks(cwd = process.cwd()) {
	const { tasks: tasksDir } = spectFiles(cwd);
	const files = await listMarkdown(tasksDir);
	const out = [];
	for (const file of files) {
		const content = await fs.readFile(file, "utf8");
		content.split(/\r?\n/).forEach((line, idx) => {
			const t = parseTaskLine(line);
			if (t) out.push({ ...t, file, line: idx + 1 });
		});
	}
	return out;
}

/** Mark a task done/open by its stable id. */
export async function setTaskStatus(cwd, id, done) {
	const files = await listMarkdown(spectFiles(cwd).tasks);
	for (const file of files) {
		const content = await fs.readFile(file, "utf8");
		const lines = content.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const t = parseTaskLine(lines[i]);
			if (!t || t.id !== id) continue;
			if (t.done === done) {
				// Already in the requested state — a no-op, not a missing task.
				return { ok: true, id, done, file, unchanged: true };
			}
			lines[i] = lines[i].replace(
				/^(\s*-\s+)\[[ xX]\]/,
				`$1${done ? "[x]" : "[ ]"}`,
			);
			await fs.writeFile(file, lines.join("\n"), "utf8");
			return { ok: true, id, done, file };
		}
	}
	return { ok: false, reason: `no task with id '${id}'` };
}

/** Parse REQ definitions (+ Verification lines) from a spec document. */
export function parseSpecReqs(content) {
	const reqs = [];
	let cur = null;
	for (const line of content.split(/\r?\n/)) {
		const rm = REQ_LINE.exec(line);
		if (rm) {
			if (cur) reqs.push(cur);
			cur = { id: `REQ-${rm[1]}`, criterion: rm[2].trim(), verification: null };
			continue;
		}
		if (cur) {
			const vm = VERIFY_LINE.exec(line);
			if (vm) cur.verification = vm[1].trim();
		}
	}
	if (cur) reqs.push(cur);
	return reqs;
}

/** Parse every spec under `specs/*.md` (id = filename base). */
export async function parseSpecs(cwd = process.cwd()) {
	const { specs: specsDir } = spectFiles(cwd);
	const files = await listMarkdown(specsDir);
	const specs = [];
	for (const file of files) {
		const content = await fs.readFile(file, "utf8");
		specs.push({ id: path.basename(file, ".md"), file, reqs: parseSpecReqs(content) });
	}
	return specs;
}

/** Cross-reference integrity: dangling task REQs vs orphan spec REQs. */
export async function validateSpect(cwd = process.cwd()) {
	const specs = await parseSpecs(cwd);
	const tasks = await parseTasks(cwd);
	const specReqIds = new Set(specs.flatMap((s) => s.reqs.map((r) => r.id)));
	const taskReqIds = new Set(tasks.flatMap((t) => t.reqs));
	const issues = [];
	for (const t of tasks)
		for (const r of t.reqs)
			if (!specReqIds.has(r))
				issues.push({ type: "dangling-task-req", task: t.id, req: r, file: t.file });
	for (const s of specs)
		for (const r of s.reqs)
			if (!taskReqIds.has(r.id))
				issues.push({ type: "orphan-req", spec: s.id, req: r.id });
	return {
		ok: issues.length === 0,
		issues,
		counts: { specs: specs.length, tasks: tasks.length, reqs: specReqIds.size },
	};
}

/** Per-REQ acceptance-criteria coverage report. */
export async function reportSpect(cwd = process.cwd(), { spec } = {}) {
	const specs = await parseSpecs(cwd);
	const filtered = spec ? specs.filter((s) => s.id === spec) : specs;
	if (spec && filtered.length === 0)
		return { ok: false, reason: `no such spec: '${spec}'` };
	const tasks = await parseTasks(cwd);
	const reqs = [];
	for (const s of filtered)
		for (const r of s.reqs) {
			const linked = tasks.filter((t) => t.reqs.includes(r.id));
			const implemented = linked.length > 0;
			const verified = !!r.verification;
			reqs.push({
				req: r.id,
				spec: s.id,
				criterion: r.criterion,
				implemented,
				verified,
				tasks: linked.map((t) => ({ id: t.id, done: t.done })),
				status: implemented && verified ? "done" : implemented ? "in-progress" : "defined",
			});
		}
	return {
		ok: true,
		spec: spec || "all",
		reqs,
		summary: {
			total: reqs.length,
			done: reqs.filter((r) => r.status === "done").length,
			inProgress: reqs.filter((r) => r.status === "in-progress").length,
			defined: reqs.filter((r) => r.status === "defined").length,
		},
	};
}

/** REQ → TASK → verification traceability for one spec. */
export async function traceSpect(specId, cwd = process.cwd()) {
	const specs = await parseSpecs(cwd);
	const spec = specs.find((s) => s.id === specId);
	if (!spec) return { ok: false, reason: `no such spec: '${specId}'` };
	const tasks = await parseTasks(cwd);
	const reqs = spec.reqs.map((r) => {
		const linked = tasks.filter((t) => t.reqs.includes(r.id));
		return {
			id: r.id,
			criterion: r.criterion,
			verification: r.verification,
			verified: !!r.verification,
			implemented: linked.length > 0,
			tasks: linked.map((t) => ({ id: t.id, done: t.done, file: t.file })),
		};
	});
	const issues = [];
	for (const r of reqs) {
		if (!r.implemented)
			issues.push({ type: "orphan-req", req: r.id, detail: "defined but no task implements it" });
		if (!r.verified)
			issues.push({ type: "unverified-req", req: r.id, detail: "no Verification line in the spec" });
	}
	return { ok: true, spec: specId, file: spec.file, reqs, issues };
}

/** The next unchecked task, with its REQ acceptance criteria. */
export async function nextTask(cwd = process.cwd()) {
	const tasks = await parseTasks(cwd);
	const next = tasks.find((t) => !t.done);
	if (!next) return { ok: true, nothingToDo: true, taskCount: tasks.length };
	const specs = await parseSpecs(cwd);
	const acceptance = next.reqs.map((r) => {
		const found = specs.find((s) => s.reqs.some((x) => x.id === r));
		const rr = found?.reqs.find((x) => x.id === r);
		return rr ? { req: r.id, criterion: rr.criterion, spec: found.id } : { req: r.id, criterion: null, spec: null };
	});
	return { ok: true, task: next, acceptance };
}

/** Mark a task done and suggest a lesson + snapshot (the close loop). */
export async function closeTask(cwd, id) {
	const r = await setTaskStatus(cwd, id, true);
	if (!r.ok) return r;
	return {
		ok: true,
		id,
		file: r.file,
		lesson: {
			topic: `spect/${id.toLowerCase()}`,
			suggestion: `agent-cli lessons add spect/${id.toLowerCase()} --body '<what was learned>'`,
		},
		snapshotSuggestion: "agent-cli snapshot",
	};
}

/** Compact headline for `brief`/status surfaces. */
export async function spectHeadline(cwd = process.cwd()) {
	const insp = await inspectSpect(cwd);
	const tasks = await parseTasks(cwd);
	const open = tasks.filter((t) => !t.done).length;
	return {
		initialized: insp.initialized || insp.partial,
		counts: insp.counts,
		taskCount: tasks.length,
		open,
		done: tasks.length - open,
	};
}
