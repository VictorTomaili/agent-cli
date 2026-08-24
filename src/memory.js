// src/memory.js — memory-loop helpers: consolidate.prompt dispatch, backups
// history, and the `memory maintain` composite. Read-mostly.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOME, AGENTS_DIR, exists, readFile } from "./util.js";
import { identityFilePath } from "./agents-lib.js";
import { assess } from "./consolidate.js";
import { inboxLessons } from "./lessons-lib.js";
import { listSnapshots, snapshot } from "./snapshot.js";

const PROMPT_RE = /consolidate\.prompt\s*:\s*(ask|auto|off)/i;

/** Read the documented-but-unimplemented `consolidate.prompt` from USER.md. */
export async function readConsolidatePrompt(scope = "global", cwd = process.cwd()) {
	const file = identityFilePath("user", scope, cwd);
	if (!(await exists(file))) return "ask";
	const content = await readFile(file);
	const m = PROMPT_RE.exec(content);
	return m ? m[1].toLowerCase() : "ask";
}

/** `memory check`: honor consolidate.prompt (ask|auto|off). */
export async function memoryCheck({ scope = "global", cwd = process.cwd() } = {}) {
	const prompt = await readConsolidatePrompt(scope, cwd);
	const cons = assess({ scope, cwd });
	const action =
		prompt === "off"
			? "off"
			: prompt === "auto"
				? cons.recommend
					? "consolidate"
					: "watch"
				: "ask";
	return {
		ok: true,
		scope,
		prompt,
		action,
		consolidate: { score: cons.score, recommend: cons.recommend, reasons: cons.reasons },
	};
}

/** Lightweight git identity for frontmatter. */
export function gitInfo(cwd = process.cwd()) {
	const git = (args) => {
		const r = spawnSync("git", args, { encoding: "utf8", cwd });
		return r.status === 0 ? (r.stdout || "").trim() : null;
	};
	const repo = git(["rev-parse", "--show-toplevel"]);
	return {
		repo: repo ? path.basename(repo) : null,
		branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
	};
}

/** List consolidation core backups (global + project). */
/** Recursive byte size of a directory (used for tx snapshot dirs). */
function dirSize(dir) {
	let total = 0;
	const stack = [dir];
	while (stack.length) {
		const d = stack.pop();
		let entries = [];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) stack.push(p);
			else {
				try {
					total += fs.statSync(p).size;
				} catch {
					/* ignore */
				}
			}
		}
	}
	return total;
}

export function backupsList({ scope = "global", cwd = process.cwd() } = {}) {
	const dir =
		scope === "project" ? path.join(cwd, ".agents", "backups") : path.join(HOME, ".agents", "backups");
	let entries = [];
	try {
		entries = fs
			.readdirSync(dir, { withFileTypes: true })
			.filter(
				(e) =>
					(e.isFile() && e.name.startsWith("LESSONS-") && e.name.endsWith(".md")) ||
					(e.isDirectory() && e.name.startsWith("consolidate-tx-")),
			)
			.map((e) => {
				const st = fs.statSync(path.join(dir, e.name));
				return {
					name: e.name,
					path: path.join(dir, e.name),
					size: e.isDirectory() ? dirSize(path.join(dir, e.name)) : st.size,
					mtime: st.mtime.toISOString(),
					kind: e.isDirectory() ? "tx" : "core",
				};
			})
			.sort((a, b) => b.mtime.localeCompare(a.mtime));
	} catch (error) {
		// HIGH-4: only a missing backups dir is a legitimate empty list — a
		// permission error (EACCES) must not be silently reported as "no backups".
		if (error && error.code === "ENOENT") return { ok: true, scope, backups: [] };
		return { ok: false, scope, reason: error && error.message ? error.message : String(error) };
	}
	return { ok: true, scope, backups: entries };
}

/** Diff a core backup against the current LESSONS.md core. */
export function backupsDiff(name, { scope = "global", cwd = process.cwd() } = {}) {
	const dir =
		scope === "project" ? path.join(cwd, ".agents", "backups") : path.join(HOME, ".agents", "backups");
	const file = path.join(dir, name);
	if (!fs.existsSync(file)) return { ok: false, reason: `no such backup: ${name}` };
	const backup = fs.readFileSync(file, "utf8");
	const corePath =
		scope === "project" ? path.join(cwd, ".agents", "LESSONS.md") : path.join(HOME, ".agents", "LESSONS.md");
	const live = fs.existsSync(corePath) ? fs.readFileSync(corePath, "utf8") : "";
	const { diffLines } = { diffLines: lcsDiff };
	return { ok: true, name, file, diff: diffLines(live, backup) };
}

/** Minimal LCS line diff (+ added/- removed). */
function lcsDiff(a, b) {
	const A = a.split("\n");
	const B = b.split("\n");
	const n = A.length;
	const m = B.length;
	const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const out = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (A[i] === B[j]) {
			out.push(" " + A[i]);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push("-" + A[i++]);
		} else {
			out.push("+" + B[j++]);
		}
	}
	while (i < n) out.push("-" + A[i++]);
	while (j < m) out.push("+" + B[j++]);
	return out.join("\n");
}

/**
 * `memory maintain`: snapshot → triage inbox count → consolidate (when
 * recommended) → brief summary, in one pass.
 */
export async function memoryMaintain({ scope = "all", cwd = process.cwd() } = {}) {
	const scopes = scope === "all" ? ["global", "project"] : [scope];
	const snap = await snapshot();
	const inbox = (await inboxLessons({ includeProject: true, cwd })).length;
	const consolidated = [];
	for (const s of scopes) {
		const cons = assess({ scope: s, cwd });
		if (cons.recommend) {
			const conMod = await import("./consolidate.js");
			const r = await conMod.consolidate({ scope: s, cwd });
			consolidated.push({ scope: s, ...(r.stats || {}) });
		}
	}
	return {
		ok: true,
		snapshot: snap.name,
		inbox,
		consolidated,
		snapshots: listSnapshots().length,
	};
}
