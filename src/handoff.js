// src/handoff.js — delegation artifacts for sub-agents.
// Real wire format for the `## Handoff` template section: an artifact under
// ~/.agents/handoffs/ with stable ids and a status lifecycle (open → accepted → closed).

import fs from "node:fs";
import path from "node:path";
import { HOME, AGENTS_DIR, exists, ensureDir, writeFile, readFile } from "./util.js";
import { gitInfo } from "./memory.js";

export const HANDOFF_DIR = path.join(HOME, ".agents", "handoffs");

function slug(s) {
	return String(s || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

export async function createHandoff({
	to,
	from = "agent-cli",
	task,
	context = "",
	cwd = process.cwd(),
} = {}) {
	if (!to) return { ok: false, reason: "handoff requires a target agent (--to <name>)" };
	if (!task) return { ok: false, reason: "handoff requires a task (--task <text>)" };
	await ensureDir(HANDOFF_DIR);
	const info = gitInfo(cwd);
	const id = `h-${Date.now()}-${slug(task)}`;
	const file = path.join(HANDOFF_DIR, `${id}.md`);
	const content = `---
id: ${id}
to: ${to}
from: ${from}
task: ${task}
status: open
createdAt: ${new Date().toISOString()}
repo: ${info.repo ?? ""}
branch: ${info.branch ?? ""}
---

## Context
${context || "(none)"}

## Handoff
${task}
`;
	await writeFile(file, content);
	return { ok: true, id, to, task, file, status: "open" };
}

export async function listHandoffs({ status = null } = {}) {
	if (!(await exists(HANDOFF_DIR))) return [];
	const entries = fs
		.readdirSync(HANDOFF_DIR, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".md"));
	const out = [];
	for (const e of entries) {
		const file = path.join(HANDOFF_DIR, e.name);
		const content = fs.readFileSync(file, "utf8");
		const fm = parseFm(content);
		if (status && fm.status !== status) continue;
		out.push({ id: fm.id ?? e.name, to: fm.to, from: fm.from, task: fm.task, status: fm.status ?? "open", file });
	}
	return out.sort((a, b) => a.file.localeCompare(b.file));
}

function parseFm(content) {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
	if (!m) return {};
	const fm = {};
	for (const line of m[1].split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return fm;
}

function findFile(id) {
	const file = path.join(HANDOFF_DIR, `${id}.md`);
	return fs.existsSync(file) ? file : null;
}

export async function showHandoff(id) {
	const file = findFile(id);
	if (!file) return { ok: false, reason: `no such handoff: ${id}` };
	return { ok: true, id, file, content: fs.readFileSync(file, "utf8") };
}

export async function setHandoffStatus(id, status) {
	const file = findFile(id);
	if (!file) return { ok: false, reason: `no such handoff: ${id}` };
	const content = fs.readFileSync(file, "utf8");
	const next = content.replace(
		/^status: .*$/m,
		`status: ${status}`,
	);
	fs.writeFileSync(file, next, "utf8");
	return { ok: true, id, status, file };
}

export async function acceptHandoff(id) {
	return setHandoffStatus(id, "accepted");
}

export async function closeHandoff(id, { lesson = null, cwd = process.cwd() } = {}) {
	const r = await setHandoffStatus(id, "closed");
	if (!r.ok) return r;
	let lessonResult = null;
	if (lesson) {
		const lessonsLib = await import("./lessons-lib.js");
		lessonResult = await lessonsLib.addLesson(lesson, { body: `Learned while closing handoff ${id}`, cwd });
	}
	return { ok: true, id, status: "closed", file: r.file, lesson: lessonResult };
}

export { AGENTS_DIR };
