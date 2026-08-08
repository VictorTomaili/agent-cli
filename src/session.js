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
		if (parsed && typeof parsed === "object" && parsed.startedAt && !parsed.endedAt)
			return parsed;
	} catch {
		/* no session */
	}
	return null;
}

export async function sessionStart({ task = null, cwd = process.cwd() } = {}) {
	const info = gitInfo(cwd);
	const existing = readSession();
	if (existing) {
		// Never silently discard an active session — the previous task (and any
		// captured lesson pointers) would be lost. Return a warning so the
		// caller (CLI/agent) can surface it before proceeding.
		return {
			ok: false,
			reason: "a session is already active — run 'agent session end' first",
			session: existing,
		};
	}
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
/** Derive the lesson-candidate topic + capture command for a session.
 * Shared by sessionEnd() (so ending a session surfaces the next step
 * without a separate call) and sessionReport() (still useful mid-session). */
function suggestLessonTopic(session) {
	return {
		topic: `session/${(session.task || "untitled")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")}`,
		suggestion: "agent lessons capture <topic> --inbox",
	};
}

export async function sessionEnd() {
	const session = readSession();
	if (!session) return { ok: false, reason: "no active session — run agent session start" };
	const lesson = suggestLessonTopic(session);
	const ended = { ...session, endedAt: new Date().toISOString() };
	const durationMs = new Date(ended.endedAt) - new Date(ended.startedAt);
	// Archive the ended session so the user can review the history without it
	// being treated as the "current" session. readSession() filters out anything
	// with an endedAt so the active-session invariant holds.
	const historyDir = path.join(path.dirname(SESSION_FILE), "sessions");
	try {
		fs.mkdirSync(historyDir, { recursive: true });
		const stamp = ended.endedAt.replace(/[:.]/g, "-");
		fs.writeFileSync(
			path.join(historyDir, `${stamp}.json`),
			JSON.stringify(ended, null, 2) + "\n",
		);
	} catch {
		/* best-effort archive; not blocking */
	}
	fs.writeFileSync(SESSION_FILE, "");
	return { ok: true, session: ended, durationMs, lesson };
}

export async function sessionReport() {
	const session = readSession();
	if (!session) return { ok: false, reason: "no active session — run agent session start" };
	const lesson = suggestLessonTopic(session);
	const marked = markReported();
	return {
		ok: true,
		session: marked.ok ? marked.session : session,
		lesson,
	};
}

export function currentSession() {
	return readSession();
}

/** Append a lesson-capture pointer to the active session, if any. Silent
 *  no-op when no session is active — lessons can be captured outside a
 *  session and that's fine, not an error. */
export function recordLessonCapture(topic) {
	const session = readSession();
	if (!session) return { ok: false };
	session.lessonsCaptured = session.lessonsCaptured || [];
	session.lessonsCaptured.push({ topic, at: new Date().toISOString() });
	fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2) + "\n");
	return { ok: true, session };
}

/** Mark the active session as having been reported (`agent session report`
 *  was run). Silent no-op when no session is active. */
export function markReported() {
	const session = readSession();
	if (!session) return { ok: false };
	session.reported = true;
	fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2) + "\n");
	return { ok: true, session };
}
