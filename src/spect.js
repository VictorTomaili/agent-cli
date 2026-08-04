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

/** Initialize project-local SPECT files without overwriting user content. */
export async function initSpect(cwd = process.cwd()) {
	const files = spectFiles(cwd);
	await fs.mkdir(files.root, { recursive: true });
	for (const dir of DIRS) await fs.mkdir(path.join(files.root, dir), { recursive: true });
	const created = [];
	const skipped = [];
	for (const [relative, content] of Object.entries(FILE_TEMPLATES)) {
		const target = path.join(files.root, relative);
		if (await exists(target)) {
			skipped.push(relative);
			continue;
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
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
		.map((entry) => path.join(dir, entry.name))
		.sort();
}

/** Return a read manifest for an existing project-local SPECT workflow. */
export async function inspectSpect(cwd = process.cwd()) {
	const files = spectFiles(cwd);
	const initialized = await exists(files.root);
	if (!initialized) {
		return {
			initialized: false,
			root: files.root,
			load: [],
			counts: { specs: 0, plans: 0, tasks: 0 },
		};
	}
	const [specs, plans, tasks] = await Promise.all([
		listMarkdown(files.specs),
		listMarkdown(files.plans),
		listMarkdown(files.tasks),
	]);
	const load = [files.readme, files.constitution, ...specs, ...plans, ...tasks];
	return {
		initialized: true,
		root: files.root,
		load,
		counts: { specs: specs.length, plans: plans.length, tasks: tasks.length },
	};
}

export function templatePaths(cwd = process.cwd()) {
	const { templates } = spectFiles(cwd);
	return Object.fromEntries(
		Object.keys(FILE_TEMPLATES)
			.filter((file) => file.startsWith("templates/"))
			.map((file) => [path.basename(file, ".md"), path.join(spectRoot(cwd), file)]),
	);
}
