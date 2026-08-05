// Memory-loop tests: consolidate.prompt dispatch, backups, maintain.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_CLI_HOME = mkdtempSync(path.join(tmpdir(), "agent-mem-"));
const mem = await import("../src/memory.js");
const HOME = process.env.AGENT_CLI_HOME;

function writeUser(prompt) {
	const file = path.join(HOME, ".agents", "USER.md");
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `# USER.md\n\n<USER_PREFS>\n- consolidate.prompt: ${prompt}\n</USER_PREFS>\n`, "utf8");
	return file;
}

test("readConsolidatePrompt reads ask|auto|off from USER.md (default ask)", async () => {
	assert.equal(await mem.readConsolidatePrompt(), "ask"); // no USER.md → ask
	writeUser("auto");
	assert.equal(await mem.readConsolidatePrompt(), "auto");
	writeUser("off");
	assert.equal(await mem.readConsolidatePrompt(), "off");
});

test("memoryCheck honors consolidate.prompt", async () => {
	writeUser("off");
	const off = await mem.memoryCheck();
	assert.equal(off.prompt, "off");
	assert.equal(off.action, "off");
	writeUser("auto");
	const auto = await mem.memoryCheck();
	assert.equal(auto.prompt, "auto");
	assert.ok(["watch", "consolidate"].includes(auto.action));
	writeUser("ask");
	const ask = await mem.memoryCheck();
	assert.equal(ask.action, "ask");
});

test("backupsList lists LESSONS-* backups and backupsDiff diffs against core", () => {
	const dir = path.join(HOME, ".agents", "backups");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "LESSONS-2026-01-01.md"), "line one\nline two\n");
	writeFileSync(path.join(HOME, ".agents", "LESSONS.md"), "# core\n\n## Core\nline one\nchanged\n");
	const list = mem.backupsList();
	assert.equal(list.backups.length, 1);
	assert.equal(list.backups[0].name, "LESSONS-2026-01-01.md");
	const diff = mem.backupsDiff("LESSONS-2026-01-01.md");
	assert.equal(diff.ok, true);
	assert.match(diff.diff, /[-+]line two/);
	const missing = mem.backupsDiff("nope.md");
	assert.equal(missing.ok, false);
});

test("memoryMaintain runs snapshot + reports inbox + optionally consolidates", async () => {
	writeUser("ask");
	const r = await mem.memoryMaintain({ scope: "global" });
	assert.equal(r.ok, true);
	assert.ok(r.snapshot);
	assert.equal(typeof r.inbox, "number");
	assert.ok(Array.isArray(r.consolidated));
});

test("gitInfo returns repo/branch or nulls", () => {
	const info = mem.gitInfo(HOME);
	assert.ok(info.repo === null || typeof info.repo === "string");
	assert.ok(info.branch === null || typeof info.branch === "string");
});
