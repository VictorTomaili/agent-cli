// src/session.js — session lifecycle state for the memory loop.
// One active session recorded in ~/.agents/.session.json (the shared brain).

import fs from "node:fs";
import path from "node:path";
import { HOME } from "./util.js";
import { gitInfo } from "./memory.js";

const SESSION_FILE = path.join(HOME, ".agents", ".session.json");

export function sessionFilePath() {
	return SESSION_FILE;
}

export function readSession() {
	try {
		const parsed = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
		if (parsed && typeof parsed === "object" && parsed.startedAt) return parsed;
	} catch {
		/* no session */
	}
	return null;
}

export async function sessionStart({ task = null, cwd = process.cwd() } = {}) {
	const info = gitInfo(cwd);
	const session = {
		startedAt: new Date().toISOString(),
		cwd: path.resolve(cwd),
		repo: info.repo,
		branch: info.branch,
		task: task ?? null,
		lessonsCaptured: [],
	};
	fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
	fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2) + "\n");
	return { ok: true, session };
}

export async function sessionEnd() {
	const session = readSession();
	if (!session) return { ok: false, reason: "no active session — run agent session start" };
	session.endedAt = new Date().toISOString();
	fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2) + "\n");
	const durationMs = new Date(session.endedAt) - new Date(session.startedAt);
	return { ok: true, session, durationMs };
}

export async function sessionReport() {
	const session = readSession();
	if (!session) return { ok: false, reason: "no active session — run agent session start" };
	return {
		ok: true,
		session,
		lesson: {
			topic: `session/${(session.task || "untitled")
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")}`,
			suggestion: "agent lessons capture <topic> --inbox",
		},
	};
}

export function currentSession() {
	return readSession();
}
