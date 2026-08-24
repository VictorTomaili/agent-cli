// Tests for the shipped dev-team roster integrity:
//   1. Every seed/agents/<role>.md persona passes validateAgent (the same
//      validator `agent-cli agents validate` uses) — so a fresh install
//      never ships an invalid persona.
//   2. The skill's SKILL.md frontmatter is valid per the skill manager's
//      conventions (kebab-case name, description present).
//   3. The roster in SKILL.md, ROLES.md, WORKFLOW.md references only roles
//      that actually exist as persona files (no dangling role names).

import { test } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = path.join(ROOT, "seed", "agents");
const SKILL_DIR = path.join(ROOT, "seed", "skills", "dev-team");

const { validateAgent } = await import("../src/agents-lib.js");

/** Read all persona files, sorted by name. */
function personaFiles() {
	return readdirSync(AGENTS_DIR)
		.filter((f) => f.endsWith(".md"))
		.sort();
}

/** Extract `name: <value>` from frontmatter. */
function frontmatterName(content) {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return null;
	const n = m[1].match(/^name:\s*(.+)$/m);
	return n ? n[1].trim() : null;
}

test("every seed persona passes validateAgent", async () => {
	const files = personaFiles();
	assert.ok(files.length >= 15, `expected ≥15 personas, got ${files.length}`);
	const failures = [];
	for (const f of files) {
		const r = await validateAgent(path.join(AGENTS_DIR, f));
		if (!r.valid) failures.push({ f, issues: r.issues });
	}
	assert.deepEqual(failures, [], "all seed personas must validate");
});

test("seed persona frontmatter names are kebab-case and match filenames", () => {
	for (const f of personaFiles()) {
		const content = readFileSync(path.join(AGENTS_DIR, f), "utf8");
		const name = frontmatterName(content);
		assert.ok(name, `${f}: missing frontmatter name`);
		assert.match(
			name,
			/^[a-z][a-z0-9-]*$/,
			`${f}: name "${name}" must be kebab-case`,
		);
		assert.equal(name, f.replace(/\.md$/, ""), `${f}: name must match filename`);
	}
});

test("the dev-team roster covers all four groups + the orchestrator", () => {
	const names = personaFiles().map((f) => f.replace(/\.md$/, ""));
	// Product & Design
	for (const r of ["product-manager", "product-owner", "business-analyst", "ux-ui-designer"])
		assert.ok(names.includes(r), `missing product role: ${r}`);
	// Engineering & Architecture
	for (const r of ["software-architect", "tech-lead", "frontend-dev", "backend-dev", "fullstack-dev", "ai-ml-engineer"])
		assert.ok(names.includes(r), `missing engineering role: ${r}`);
	// Operations & Quality
	for (const r of ["qa-engineer", "devops-engineer"])
		assert.ok(names.includes(r), `missing ops role: ${r}`);
	// Management
	for (const r of ["project-manager", "scrum-master"])
		assert.ok(names.includes(r), `missing management role: ${r}`);
	// Core
	assert.ok(names.includes("orchestrator-agent"), "missing orchestrator");
});

test("SKILL.md frontmatter is valid (kebab-case name, description, no legacy roster refs)", () => {
	const skill = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
	const m = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	assert.ok(m, "SKILL.md must have frontmatter");
	const fm = m[1];
	const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
	assert.equal(name, "dev-team");
	const desc = fm.match(/^description:\s*(.+)$/m)?.[1];
	assert.ok(desc, "SKILL.md must have a description");
	// The skill must not reference the legacy roster (renamed roles).
	for (const legacy of ["cto-agent", "dev-agent", "devops-agent", "qa-agent", "security-agent"]) {
		assert.ok(!skill.includes(legacy), `SKILL.md must not reference legacy role ${legacy}`);
	}
});

test("WORKFLOW.md and ROLES.md reference only roles that exist as persona files", () => {
	const names = new Set(personaFiles().map((f) => f.replace(/\.md$/, "")));
	for (const f of ["ROLES.md", "WORKFLOW.md", "SKILL.md"]) {
		const content = readFileSync(path.join(SKILL_DIR, f), "utf8");
		// Find every backtick-quoted role-looking token like `role-name`
		const refs = [...content.matchAll(/`([a-z][a-z0-9-]*(?:-[a-z0-9]+)+)`/g)]
			.map((m) => m[1])
			.filter((r) => r.endsWith("dev") || r.endsWith("engineer") || r.endsWith("manager") || r.endsWith("owner") || r.endsWith("analyst") || r.endsWith("designer") || r.endsWith("architect") || r.endsWith("lead") || r.endsWith("master"));
		const dangling = [...new Set(refs)].filter((r) => !names.has(r));
		assert.deepEqual(dangling, [], `${f} references unknown roles`);
	}
});

test("every role card in ROLES.md has a model tier", () => {
	const roles = readFileSync(path.join(SKILL_DIR, "ROLES.md"), "utf8");
	// Each role section has a "Default model tier:" line.
	const tierLines = roles.match(/Default model tier:.*/g) || [];
	assert.ok(tierLines.length >= 15, `expected ≥15 tier lines, got ${tierLines.length}`);
	for (const t of tierLines) {
		// The orchestrator's tier is prose ("The host's own model…");
		// every other role names a concrete tier (smart/coding/fast/…).
		if (/host's own model/i.test(t)) continue;
		assert.match(t, /smart|coding|fast|cheap|deepsearch/i, `tier line must name a tier: ${t}`);
	}
});