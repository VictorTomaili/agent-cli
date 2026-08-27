// src/agents-lib.js — unified management of sub-agent personalities + identity/memory files.
// Everything lives under the agent-cli canonical home: ~/.agents/ (global) and
// [project]/.agents/ (project-local), mirroring the same pattern.

import fs from "node:fs";
import path from "node:path";
import fsp from "node:fs/promises";
import {
	exists,
	readFile,
	writeFile,
	ensureDir,
	pretty,
	HOME,
	resolveContained,
	projectBrainDir,
} from "./util.js";
import { FIELD_TAGS, fieldGaps, environmentGaps } from "./fields.js";
import { onboardSuggest as identityOnboardSuggest } from "./identity.js";

/** Global reusable sub-agent personalities dir: ~/.agents/agents */
export const GLOBAL_AGENTS_DIR = path.join(HOME, ".agents", "agents");
/** Project-local sub-agent personalities dir: [cwd]/.agents/agents */
export function projectAgentsDir(cwd = process.cwd()) {
	return path.join(projectBrainDir(cwd), "agents");
}

/** The unified identity/memory file set (kind → filename).
 *  `globalOnly: true` means the kind has NO project-scope override — only the
 *  global file is loaded by `agent-cli brief`, regardless of whether a project-scope
 *  file exists. These are characteristics of the agent/machine/operator that
 *  don't vary per project: who the agent IS (identity), who the operator IS
 *  (user), and what models the machine can reach (models). */
export const IDENTITY_FILES = [
	{
		kind: "agents",
		file: "AGENTS.md",
		desc: "Operating manual (canonical master)",
	},
	{
		kind: "soul",
		file: "SOUL.md",
		desc: "Personality, values, beliefs, goals",
	},
	{
		kind: "identity",
		file: "IDENTITY.md",
		desc: "Name, role, mission, persona",
		globalOnly: true,
	},
	{
		kind: "user",
		file: "USER.md",
		desc: "User preferences, goals, context",
		globalOnly: true,
	},
	{
		kind: "lessons",
		file: "LESSONS.md",
		desc: "Lessons learned (system-wide)",
	},
	{
		kind: "environments",
		file: "ENVIRONMENTS.md",
		desc: "Execution & connection environments (local, SSH, containers)",
	},
	{
		kind: "models",
		file: "MODELS.md",
		desc: "Model aliases (alias → provider/model + category + thinking)",
		globalOnly: true,
	},
	// LAST on purpose: a workflow step may reference a model alias, so MODELS.md
	// has to be read before WORKFLOW.md for those aliases to resolve.
	{
		kind: "workflow",
		file: "WORKFLOW.md",
		desc: "Reusable task workflows (recorded, replayable recipes)",
	},
];

export function identityBase(scope = "global", cwd = process.cwd()) {
	// projectBrainDir throws EPROJECTBASEREDIRECTED when the checkout points
	// .agents somewhere else — see util.js. Global scope is never checkout-controlled.
	return scope === "project"
		? projectBrainDir(cwd)
		: path.join(HOME, ".agents");
}

export function identityFilePath(kind, scope = "global", cwd = process.cwd()) {
	const f = IDENTITY_FILES.find((i) => i.kind === kind);
	if (!f) return null;
	return path.join(identityBase(scope, cwd), f.file);
}

/** Minimal YAML-frontmatter parser (key: value lines between --- fences). */
export function parseFrontmatter(content) {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { frontmatter: {}, body: content };
	const frontmatter = {};
	for (const line of m[1].split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx > 0)
			frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { frontmatter, body: m[2] };
}

function csv(v) {
	return v
		? String(v)
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: undefined;
}

/** List sub-agent personalities from global (+ project) dirs. */
export async function listAgents({
	includeProject = true,
	cwd = process.cwd(),
} = {}) {
	const out = [];
	const dirs = [];
	if (includeProject) {
		const pdir = projectAgentsDir(cwd);
		if (pdir !== GLOBAL_AGENTS_DIR) dirs.push({ dir: pdir, scope: "project" });
	}
	// Project-local personalities override global personalities with the same name.
	dirs.push({ dir: GLOBAL_AGENTS_DIR, scope: "global" });
	const seen = new Set();
	for (const { dir, scope } of dirs) {
		if (!(await exists(dir))) continue;
		let entries = [];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.name.endsWith(".md")) continue;
			const fp = path.join(dir, e.name);
			const content = await readFile(fp);
			const { frontmatter } = parseFrontmatter(content);
			const name = frontmatter.name || e.name.replace(/\.md$/, "");
			// Dedupe by name with the project (higher-precedence) entry winning:
			// project dirs are pushed first, so a global duplicate is skipped.
			if (seen.has(name)) continue;
			seen.add(name);
			out.push({
				name,
				description: frontmatter.description || "",
				tools: csv(frontmatter.tools),
				model: frontmatter.model || undefined,
				thinking: frontmatter.thinking || undefined,
				scope,
				path: fp,
			});
		}
	}
	return out;
}

export async function showAgent(
	name,
	{ includeProject = true, cwd = process.cwd() } = {},
) {
	const all = await listAgents({ includeProject, cwd });
	return all.find((a) => a.name === name) || null;
}

/** Canonical agent-personality template (role-specific, reusable). */
export function agentTemplate(name) {
	return `---
name: ${name}
description: <one line: role + when to use — used for matching>
tools: read, edit, bash
model:
thinking:
---

## Delegation identity
You are a delegated sub-agent, not the primary agent. The host/orchestrator owns the overall task, user communication, sequencing, and final verification.

## Goal
State the single outcome this delegation must achieve. Optimize for that outcome, not for unrelated improvements.

## Orchestrator contract
- Work only within the caller-provided scope and constraints.
- Do not redefine the user's goal, delegate further, or make unrelated changes.
- Surface blockers and ambiguities to the orchestrator instead of guessing.
- Return evidence, changed paths, and remaining risks so the orchestrator can integrate and verify your work.

## Role

## When to use
- <trigger/condition>
## When NOT to use
- <case where another role fits better>

## Requires (inputs from caller)
- <what must be in the task: files, context, constraints>

## Responsibilities
- <what it does, step by step>

## Output style & format
\`\`\`
<exact structure of its return, so the caller can parse it>
\`\`\`

## Constraints
- <guardrail>
- NEVER hardcode project paths/names — stay role-generic so it's reusable across projects.

## Handoff
<what it returns to the delegating agent>
`;
}

export async function scaffoldAgent(
	name,
	{ scope = "global", cwd = process.cwd() } = {},
) {
	const dir = scope === "project" ? projectAgentsDir(cwd) : GLOBAL_AGENTS_DIR;
	await ensureDir(dir);
	if (
		typeof name !== "string" ||
		!name.trim() ||
		name === "." ||
		name === ".." ||
		/[\\/]/.test(name) ||
		path.isAbsolute(name)
	)
		throw new Error("agent name must be a simple filename");
	const fp = resolveContained(dir, `${name}.md`);
	if (!fp) throw new Error("agent name must stay inside the agents directory");
	if (await exists(fp)) return { created: false, path: fp, reason: "exists" };
	await writeFile(fp, agentTemplate(name));
	return { created: true, path: fp };
}

/** Inspect the unified identity/memory file set (existence + size).
 *  Passes through `globalOnly` from IDENTITY_FILES so consumers can tell which
 *  kinds never have a project-scope override. */
export async function identityInventory({
	scope = "global",
	cwd = process.cwd(),
} = {}) {
	const base = identityBase(scope, cwd);
	const files = [];
	for (const { kind, file, desc, globalOnly } of IDENTITY_FILES) {
		const fp = path.join(base, file);
		let size = null;
		let filled = null;
		let gaps = null;
		if (await exists(fp)) {
			try {
				const st = await fsp.stat(fp);
				size = st.size;
				const content = await readFile(fp);
				filled = kind === "agents" ? null : isFilled(content, kind);
				if (FIELD_TAGS[kind]) gaps = fieldGaps(content, kind);
				else if (kind === "environments") gaps = environmentGaps(content);
			} catch {
				/* ignore */
			}
		}
		files.push({
			kind,
			file,
			desc,
			globalOnly: !!globalOnly,
			path: fp,
			exists: size !== null,
			size,
			filled,
			gaps,
		});
	}
	// also report the agents/ dir
	const agentsDir =
		scope === "project" ? projectAgentsDir(cwd) : GLOBAL_AGENTS_DIR;
	let agentsCount = 0;
	if (await exists(agentsDir)) {
		try {
			agentsCount = (await fsp.readdir(agentsDir)).filter((n) =>
				n.endsWith(".md"),
			).length;
		} catch {
			/* ignore */
		}
	}
	return { base, scope, files, agentsDir, agentsCount };
}

const PLACEHOLDER =
	/\((\s*fill in|your chosen|none yet|what you|e\.g\.|optional)\s*\)|<[^>]+>/i;
function isPromptish(t) {
	t = (t || "").trim();
	if (!t) return true;
	if (/^\(.*\)$/.test(t)) return true;
	if (/^<[^>]+>$/.test(t)) return true;
	if (PLACEHOLDER.test(t)) return true;
	if (/\be\.g\./i.test(t) && t.split(/\s+/).length < 12) return true;
	return false;
}
function realTextLen(text) {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !isPromptish(l))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim().length;
}
/** Heuristic: is an identity file filled (vs. an unfilled template)?
 *  Tag-aware: for tagged kinds (identity/soul/user) a file is filled iff it has no
 *  empty/placeholder field tags. Other files use the section-aware prose heuristic. */
export function isFilled(content, kind) {
	if (!content || !content.trim()) return false;
	if (kind && FIELD_TAGS[kind]) return fieldGaps(content, kind).length === 0;
	if (kind === "environments") return environmentGaps(content).length === 0;
	if (kind === "models") {
		// MODELS.md is "filled" when it has at least one <ALIAS ...> entry.
		// It used to also count a "## Curated model catalog" section, because
		// install seeded one — but agent-cli no longer ships model data, so no
		// section's mere presence can make an alias-less file look populated.
		return /<ALIAS\s+name=/.test(content);
	}
	// Loop-until-stable HTML comment strip — a single-pass regex leaves <!--
	// behind when adjacent text creates new <!-- substrings (CodeQL
	// js/incomplete-multi-character-sanitization flagged the old single-pass).
	let stripped = content;
	let prev;
	do {
		prev = stripped;
		stripped = stripped.replace(/<!--[\s\S]*?-->/g, "");
	} while (stripped !== prev);
	const body = stripped.replace(/^---[\s\S]*?---/, "");
	const parts = body.split(/^##\s+/m);
	const sections = parts.slice(1);
	if (sections.length === 0) return realTextLen(parts[0]) >= 40;
	for (const sec of sections) {
		const lines = sec.split(/\r?\n/);
		lines.shift();
		if (realTextLen(lines.join("\n")) < 15) return false;
	}
	return true;
}

const REQUIRED_SECTIONS = [
	"## Delegation identity",
	"## Goal",
	"## Orchestrator contract",
	"## Role",
	"## When to use",
	"## Requires",
	"## Output style",
	"## Constraints",
];
/** Validate a sub-agent personality file (frontmatter + required sections + placeholders). */
export async function validateAgent(filePath) {
	const issues = [];
	const warnings = [];
	if (!(await exists(filePath)))
		return { file: filePath, valid: false, issues: ["file missing"] };
	const content = await readFile(filePath);
	const { frontmatter, body } = parseFrontmatter(content);
	if (!frontmatter.name) issues.push("frontmatter: missing name");
	if (!frontmatter.description) issues.push("frontmatter: missing description");
	if (frontmatter.model) {
		let aliasOk = false;
		try {
			const cfg = JSON.parse(
				fs.readFileSync(path.join(HOME, ".agents", "config.json"), "utf8"),
			);
			aliasOk = !!cfg.models?.aliases?.[frontmatter.model];
		} catch {
			/* no config */
		}
		const concrete = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(frontmatter.model);
		if (!aliasOk && !concrete)
			warnings.push(
				`model: '${frontmatter.model}' is unresolved; configure it with agent-cli models set`,
			);
	}
	for (const sec of REQUIRED_SECTIONS)
		if (!body.includes(sec)) issues.push(`body: missing "${sec}" section`);
	if (
		/<one line|<one sentence|<what this agent|<trigger|<what must|<what it does|<exact|<guardrail|<what it returns|<case where/.test(
			body,
		)
	)
		issues.push("body: still has template placeholders (fill them in)");
	return {
		file: filePath,
		name: frontmatter.name || path.basename(filePath, ".md"),
		valid: issues.length === 0,
		issues,
		warnings,
	};
}

export { pretty };

/** Agents whose frontmatter `model:` is an unresolved alias. Scans both global
 * and project-scope personas so a brief shows every persona that needs an alias. */
export async function findUnresolvedModels(cwd = process.cwd()) {
	const list = await listAgents({ includeProject: true, cwd });
	const unresolved = [];
	for (const a of list) {
		if (!a.model) continue;
		const v = await validateAgent(a.path);
		if (v.warnings && v.warnings.some((w) => w.includes("unresolved")))
			unresolved.push({
				name: a.name,
				model: a.model,
				scope: a.scope || "global",
				guidance: `agent-cli models set ${a.name} <provider/model>`,
			});
	}
	return unresolved;
}

const ARCHETYPE_FIELDS = ["AGENT_ROLE", "AGENT_MISSION", "AGENT_PERSONA"];

/** From an identityInventory result, compute the onboarding/gap summary for brief/doctor.
 *  Pure helper (no I/O) so it stays unit-testable. */
export function computeOnboarding(inv) {
	const gapReport = {};
	for (const f of inv.files)
		if (f.gaps && f.gaps.length) gapReport[f.kind] = f.gaps;
	const identityGaps = gapReport.identity || [];
	const identityFile = inv.files.find((f) => f.kind === "identity");
	// The archetype supplies role/mission/persona; if any is missing (or IDENTITY.md is
	// absent) onboarding hasn't happened → offer the question. Else only list field gaps.
	const archetypeNeeded =
		ARCHETYPE_FIELDS.some((t) => identityGaps.includes(t)) ||
		!identityFile?.exists;
	const gapRecommended = Object.keys(gapReport).length > 0 || archetypeNeeded;
	return { gapReport, archetypeNeeded, gapRecommended };
}

// Kind priority for nextGapSuggestion, low → high index = low → high priority.
// "lessons" is intentionally absent: identityInventory() never computes a `gaps`
// array for kind "lessons" (FIELD_TAGS has no "lessons" entry and it isn't
// "environments"), so an empty/missing LESSONS.md can never appear in gapReport —
// it's a legitimate steady state (the "(no project lessons yet)" convention in
// blocks.js), not a gap to nag about.
const GAP_KIND_PRIORITY = ["identity", "user", "soul", "environments"];

// Open-ended questions for non-archetype field gaps, keyed by kind then tag.
// Identity's archetype fields (AGENT_ROLE/MISSION/PERSONA) are never reached here —
// any archetype gap sets archetypeNeeded, which nextGapSuggestion handles first by
// delegating to identity.js's onboardSuggest(). Only AGENT_NAME can reach the
// identity entry below (a filled archetype with an empty name).
const GAP_FIELD_QUESTIONS = {
	identity: {
		AGENT_NAME: "What should this agent be named?",
	},
	user: {
		USER_PREFS:
			"What are your preferences (communication style, tools, conventions)?",
		USER_GOALS: "What are your goals in this context?",
		USER_CONTEXT: "What context should the agent know about you?",
	},
	soul: {
		SOUL_PERSONALITY: "What personality should this agent have?",
		SOUL_VALUES: "What values should guide this agent's decisions?",
		SOUL_BELIEFS: "What beliefs should this agent hold about doing good work?",
		SOUL_MOTIVATIONS:
			"What should motivate this agent — its goals and drives?",
	},
	environments: {
		ENV_LOCAL_USER: "What's your local username?",
		ENV_LOCAL_OS: "What OS are you running locally?",
		ENV_LOCAL_SHELL: "What shell do you use locally?",
		ENV_LOCAL_HOME: "What's your local home directory?",
	},
};

/** Fallback question for a (kind, tag) not covered by GAP_FIELD_QUESTIONS above
 *  (defensive — keeps nextGapSuggestion from ever returning a blank question if
 *  the field schema grows without an accompanying question being added). */
function fallbackGapQuestion(kind, tag) {
	if (kind === "environments")
		return `What's your local ${tag.replace(/^ENV_LOCAL_/, "").toLowerCase()}?`;
	const field = FIELD_TAGS[kind]?.find((f) => f.tag === tag);
	const label = (field?.label || tag).toLowerCase();
	return `What is your ${label} for ${kind}.md?`;
}

/**
 * nextGapSuggestion(inv) — pick the single highest-priority unresolved gap across
 * ALL brain files and turn it into one actionable question. Generalizes onboarding
 * beyond identity archetype selection: identity.js's onboardSuggest() only ever
 * asks about archetype, but USER.md/SOUL.md/ENVIRONMENTS.md gaps (reported by
 * computeOnboarding()'s gapReport) previously had no question-generation at all.
 * Pure (no I/O): consumes the same identityInventory() shape computeOnboarding() does.
 *
 * Priority: identity archetype (seeds role/mission/persona that other files
 * reference) > identity non-archetype fields (AGENT_NAME) > user > soul >
 * environments. LESSONS.md is excluded — see GAP_KIND_PRIORITY's comment.
 *
 * Returned shapes (discriminate on `kind`):
 *   - identity archetype (multiple-choice — delegates to identity.js's
 *     onboardSuggest(), not reimplemented here):
 *       { kind: "identity", question, default, options, souls }
 *   - identity (AGENT_NAME) | user | soul | environments (single open-ended field):
 *       { kind, tag, question, freeform: true }
 *   - nothing left to suggest:
 *       null
 */
export function nextGapSuggestion(inv) {
	const { gapReport, archetypeNeeded } = computeOnboarding(inv);
	if (archetypeNeeded) return { kind: "identity", ...identityOnboardSuggest() };
	for (const kind of GAP_KIND_PRIORITY) {
		const gaps = gapReport[kind];
		if (!gaps || !gaps.length) continue;
		const tag = gaps[0];
		const question = GAP_FIELD_QUESTIONS[kind]?.[tag] || fallbackGapQuestion(kind, tag);
		return { kind, tag, question, freeform: true };
	}
	return null;
}
