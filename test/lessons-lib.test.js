import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";

const HOME_TMP = mkdtempSync(path.join(tmpdir(), "agent-ll-home-"));
process.env.AGENT_CLI_HOME = HOME_TMP;

const {
	addLesson,
	listLessons,
	parseFM,
	fileInboxItem,
	deleteInboxItem,
	clearInbox,
	inboxLessons,
} = await import("../src/lessons-lib.js");

test("parseFM reads frontmatter", () => {
	const { fm, body } = parseFM("---\noccurrences: 3\nmarked: true\n---\nbody");
	assert.equal(fm.occurrences, "3");
	assert.equal(fm.marked, "true");
	assert.equal(body, "body");
});

test("addLesson recurrence increments occurrences", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-ll-"));
	const r1 = await addLesson("git/x", {
		scope: "project",
		cwd,
		body: "- **Lesson:** x",
	});
	assert.equal(r1.created, true);
	const r2 = await addLesson("git/x", { scope: "project", cwd });
	assert.equal(r2.created, false);
	assert.equal(r2.occurrences, 2);
	const items = (await listLessons({ includeProject: true, cwd })).filter(
		(i) => i.scope === "project",
	);
	assert.equal(items.find((i) => i.path === "git/x").occurrences, 2);
});

test("inbox triage: file an inbox item into a lesson", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-ll3-"));
	const inboxDir = path.join(cwd, ".agents", "lessons", ".inbox");
	await fsp.mkdir(inboxDir, { recursive: true });
	await fsp.writeFile(
		path.join(inboxDir, "cap.md"),
		"- **Lesson:** from inbox\n  - What: x",
	);
	const inbox = await inboxLessons({ includeProject: true, cwd });
	const idx = inbox.findIndex((x) => x.scope === "project");
	assert.ok(idx >= 0);
	const f = await fileInboxItem(idx, "filed/from-inbox", { cwd });
	assert.equal(f.ok, true);
	const after = (await inboxLessons({ includeProject: true, cwd })).filter(
		(i) => i.scope === "project",
	);
	assert.equal(after.length, 0);
});

test("addLesson empty/whitespace relpath → untitled", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-ll4-"));
	const r = await addLesson("   ", { scope: "project", cwd, body: "x" });
	assert.ok(r.file.endsWith("untitled.md"));
});

test("addLesson re-capture clears the grace mark", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-ll5-"));
	await addLesson("git/y", { scope: "project", cwd, body: "b" });
	const fp = path.join(cwd, ".agents", "lessons", "git", "y.md");
	const fm = parseFM(await fsp.readFile(fp, "utf8")).fm;
	await fsp.writeFile(
		fp,
		`---\noccurrences: ${fm.occurrences}\nfirstSeen: ${fm.firstSeen}\nlastSeen: ${fm.lastSeen}\nmarked: true\n---\nb`,
	);
	await addLesson("git/y", { scope: "project", cwd });
	assert.equal(parseFM(await fsp.readFile(fp, "utf8")).fm.marked, "false");
});

test("listLessons is [] on an absent dir", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-ll6-"));
	assert.deepEqual(await listLessons({ includeProject: true, cwd }), []);
});

test("listLessons handles a lesson without frontmatter (defaults)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-ll7-"));
	await fsp.mkdir(path.join(cwd, ".agents", "lessons", "x"), {
		recursive: true,
	});
	await fsp.writeFile(
		path.join(cwd, ".agents", "lessons", "x", "no-fm.md"),
		"no frontmatter body",
	);
	const items = await listLessons({ includeProject: true, cwd });
	const it = items.find((i) => i.path === "x/no-fm");
	assert.ok(it);
	assert.equal(it.occurrences, 1);
	assert.equal(it.marked, false);
});

test("inboxLessons is [] when no .inbox exists", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-ll8-"));
	assert.deepEqual(await inboxLessons({ includeProject: true, cwd }), []);
});

test("fileInboxItem / deleteInboxItem bad index → ok:false with reason", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-ll9-"));
	assert.deepEqual(await fileInboxItem(99, "x/y", { cwd }), {
		ok: false,
		reason: "no such inbox index",
	});
	assert.deepEqual(await deleteInboxItem(99, { cwd }), {
		ok: false,
		reason: "no such inbox index",
	});
});

test("deleteInboxItem removes an inbox item", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-ll10-"));
	const inboxDir = path.join(cwd, ".agents", "lessons", ".inbox");
	await fsp.mkdir(inboxDir, { recursive: true });
	await fsp.writeFile(path.join(inboxDir, "a.md"), "x");
	const r = await deleteInboxItem(0, { cwd });
	assert.equal(r.ok, true);
});

test("clearInbox removes all .inbox captures", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-ll-clear-"));
	const inboxDir = path.join(cwd, ".agents", "lessons", ".inbox");
	await fsp.mkdir(inboxDir, { recursive: true });
	await fsp.writeFile(path.join(inboxDir, "a.md"), "x");
	await fsp.writeFile(path.join(inboxDir, "b.md"), "y");
	await fsp.writeFile(path.join(inboxDir, "not-md.txt"), "keep");
	const r = await clearInbox({ includeProject: true, cwd });
	assert.equal(r.deleted, 2);
	assert.equal((await inboxLessons({ includeProject: true, cwd })).length, 0);
});

test("clearInbox is a no-op when no .inbox exists", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-ll-clear2-"));
	const r = await clearInbox({ includeProject: true, cwd });
	assert.equal(r.deleted, 0);
});

test("parseFM treats a missing closing fence as body (no fm)", () => {
	const { fm, body } = parseFM(
		"---\noccurrences: 3\nno closing fence\njust body",
	);
	assert.deepEqual(fm, {});
	assert.ok(body.includes("no closing fence"));
});

test("parseFM reads CRLF frontmatter", () => {
	const { fm } = parseFM("---\r\noccurrences: 5\r\n---\r\nbody");
	assert.equal(fm.occurrences, "5");
});

test("parseFM: a valueless key (idx 0) is ignored", () => {
	const { fm } = parseFM("---\n: nokey\nname: x\n---\nbody");
	assert.equal(fm.name, "x");
	assert.ok(!fm[""]);
});
