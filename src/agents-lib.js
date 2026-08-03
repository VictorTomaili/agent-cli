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
} from "./util.js";
import { FIELD_TAGS, fieldGaps } from "./fields.js";

/** Global reusable sub-agent personalities dir: ~/.agents/agents */
export const GLOBAL_AGENTS_DIR = path.join(HOME, ".agents", "agents");
/** Project-local sub-agent personalities dir: [cwd]/.agents/agents */
export function projectAgentsDir(cwd = process.cwd()) {
	return path.join(cwd, ".agents", "agents");
}

/** The unified identity/memory file set (kind → filename). */
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
	},
	{ kind: "user", file: "USER.md", desc: "User preferences, goals, context" },
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
];

export function identityBase(scope = "global", cwd = process.cwd()) {
	return scope === "project"
		? path.join(cwd, ".agents")
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
	const dirs = [{ dir: GLOBAL_AGENTS_DIR, scope: "global" }];
	if (includeProject) {
		const pdir = projectAgentsDir(cwd);
		if (pdir !== GLOBAL_AGENTS_DIR) dirs.push({ dir: pdir, scope: "project" });
	}
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
			out.push({
				name: frontmatter.name || e.name.replace(/\.md$/, ""),
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

## Role
<one sentence: what this agent IS>

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
	const fp = path.join(dir, `${name}.md`);
	if (await exists(fp)) return { created: false, path: fp, reason: "exists" };
	await writeFile(fp, agentTemplate(name));
	return { created: true, path: fp };
}

/** Inspect the unified identity/memory file set (existence + size). */
export async function identityInventory({
	scope = "global",
	cwd = process.cwd(),
} = {}) {
	const base = identityBase(scope, cwd);
	const files = [];
	for (const { kind, file, desc } of IDENTITY_FILES) {
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
			} catch {
				/* ignore */
			}
		}
		files.push({
			kind,
			file,
			desc,
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
	const body = content
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/^---[\s\S]*?---/, "");
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
	"## Role",
	"## When to use",
	"## Requires",
	"## Output style",
	"## Constraints",
];
/** Validate a sub-agent personality file (frontmatter + required sections + placeholders). */
export async function validateAgent(filePath) {
	const issues = [];
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
			issues.push(
				`model: '${frontmatter.model}' is neither a known alias nor provider/model`,
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
	};
}

export { pretty };

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
