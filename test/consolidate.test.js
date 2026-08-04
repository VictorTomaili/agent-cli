import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HOME_TMP = mkdtempSync(path.join(tmpdir(), "agent-con-home-"));
process.env.AGENT_CLI_HOME = HOME_TMP;

const { assess, consolidate } = await import("../src/consolidate.js");
const { addLesson, listLessons, coreFile, parseFM } = await import(
	"../src/lessons-lib.js"
);

test("assess on empty project dir → low score, not recommend", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-con-"));
	const a = assess({ scope: "project", cwd });
	assert.equal(a.ok, true);
	assert.equal(a.metrics.lessons, 0);
	assert.equal(a.recommend, false);
});

test("consolidate two-pass grace: promote recurring, prune singleton", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-con2-"));
	await addLesson("git/recurring", {
		scope: "project",
		cwd,
		body: "- **Lesson:** recurring one",
	});
	await addLesson("git/recurring", { scope: "project", cwd });
	await addLesson("solo/once", {
		scope: "project",
		cwd,
		body: "- **Lesson:** once",
	});

	// pass 1: promote recurring, mark singleton
	const p1 = consolidate({ scope: "project", cwd });
	assert.equal(p1.stats.promoted, 1);
	assert.equal(p1.stats.marked, 1);
	let items = (await listLessons({ includeProject: true, cwd })).filter(
		(i) => i.scope === "project",
	);
	assert.ok(items.find((i) => i.path === "git/recurring" && i.promoted));
	assert.ok(items.find((i) => i.path === "solo/once" && i.marked));

	// pass 2: prune marked singleton
	const p2 = consolidate({ scope: "project", cwd });
	assert.equal(p2.stats.deleted, 1);
	items = (await listLessons({ includeProject: true, cwd })).filter(
		(i) => i.scope === "project",
	);
	assert.deepEqual(
		items.map((i) => [i.path, i.promoted]),
		[["git/recurring", true]],
	);
});

test("assess reflects promotable count", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-con3-"));
	for (let i = 0; i < 6; i++) {
		await addLesson(`t/l${i}`, { scope: "project", cwd });
		await addLesson(`t/l${i}`, { scope: "project", cwd });
	}
	const a = assess({ scope: "project", cwd });
	assert.ok(a.metrics.promotable >= 5);
	assert.ok(a.metrics.valueOpportunity > 0);
});

test("consolidate with no lessons dir → ok:false", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-con4-"));
	const r = consolidate({ scope: "project", cwd });
	assert.equal(r.ok, false);
	assert.equal(r.reason, "no lessons dir");
});

test("consolidate dry-run does NOT mutate files or write core", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-con5-"));
	await addLesson("git/r", { scope: "project", cwd, body: "- **Lesson:** r" });
	await addLesson("git/r", { scope: "project", cwd });
	const r = consolidate({ scope: "project", cwd, dryRun: true });
	assert.equal(r.stats.promoted, 1);
	const items = (await listLessons({ includeProject: true, cwd })).filter(
		(i) => i.scope === "project",
	);
	const found = items.find((i) => i.path === "git/r");
	assert.ok(found); // still present (not deleted)
	assert.equal(found.marked, false); // not marked in dry-run
});

test("consolidate honors a custom promoteThreshold", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-con6-"));
	await addLesson("git/three", {
		scope: "project",
		cwd,
		body: "- **Lesson:** t",
	});
	await addLesson("git/three", { scope: "project", cwd });
	const r = consolidate({ scope: "project", cwd, promoteThreshold: 3 });
	assert.equal(r.stats.promoted, 0);
	assert.equal(r.stats.marked, 1);
});

test("assess tolerates a corrupt config (falls back to defaults)", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-con7-"));
	mkdirSync(path.join(HOME_TMP, ".agents"), { recursive: true });
	writeFileSync(path.join(HOME_TMP, ".agents", "config.json"), "{ broken");
	const a = assess({ scope: "project", cwd });
	assert.equal(a.ok, true);
	assert.equal(a.threshold, 70); // default scoreThreshold
});

test("consolidate promotes recurring lessons into the pointer index", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-con-promo-"));
	await addLesson("git/rec", {
		scope: "project",
		cwd,
		body: "- **Lesson:** promoted body",
	});
	await addLesson("git/rec", { scope: "project", cwd });
	consolidate({ scope: "project", cwd });
	const core = readFileSync(coreFile("project", cwd), "utf8");
	assert.ok(core.includes("## Core"));
	assert.ok(core.includes("promoted body"));
	assert.match(core, /lessons\/git\/rec\.md/);
	assert.ok(
		readFileSync(
			path.join(cwd, ".agents", "lessons", "git", "rec.md"),
			"utf8",
		).includes("promoted: true"),
	);
});

test("consolidate: a marked lesson reaching the threshold is promoted, not deleted", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-con-order-"));
	await addLesson("git/x", { scope: "project", cwd, body: "- **Lesson:** x" });
	consolidate({ scope: "project", cwd }); // pass 1: occ=1 -> marked
	await addLesson("git/x", { scope: "project", cwd }); // occ=2, clears mark
	const fp = path.join(cwd, ".agents", "lessons", "git", "x.md");
	const fm = parseFM(readFileSync(fp, "utf8")).fm;
	writeFileSync(
		fp,
		`---\noccurrences: ${fm.occurrences}\nfirstSeen: ${fm.firstSeen}\nlastSeen: ${fm.lastSeen}\nmarked: true\n---\n- **Lesson:** x`,
	);
	const r = consolidate({ scope: "project", cwd });
	assert.equal(r.stats.promoted, 1);
	assert.equal(r.stats.deleted, 0);
});

test("consolidate backs up the previous core before overwriting (project)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-con-backup-proj-"));
	await addLesson("git/rec", {
		scope: "project",
		cwd,
		body: "- **Lesson:** backed up",
	});
	await addLesson("git/rec", { scope: "project", cwd });
	// first run: writes the core, there is no prior core to back up yet
	consolidate({ scope: "project", cwd });
	const backupsDir = path.join(cwd, ".agents", "backups");
	assert.equal(existsSync(backupsDir), false);
	// second run: must create the backups dir and copy the existing core first
	const r = consolidate({ scope: "project", cwd });
	assert.equal(r.ok, true);
	assert.ok(existsSync(backupsDir));
	const backups = readdirSync(backupsDir).filter((n) => n.endsWith(".md"));
	assert.ok(backups.length > 0);
	const backup = readFileSync(path.join(backupsDir, backups[0]), "utf8");
	assert.match(backup, /lessons\/git\/rec\.md/);
});

test("consolidate backs up the previous core under the global backups dir", async () => {
	await addLesson("git/rec", {
		scope: "global",
		body: "- **Lesson:** global backup",
	});
	await addLesson("git/rec", { scope: "global" });
	consolidate({ scope: "global" }); // first run: writes the core
	const backupsDir = path.join(HOME_TMP, ".agents", "backups");
	assert.equal(existsSync(backupsDir), false);
	const r = consolidate({ scope: "global" }); // second run: backs up the existing core
	assert.equal(r.ok, true);
	assert.ok(existsSync(backupsDir));
	assert.ok(readdirSync(backupsDir).some((n) => n.endsWith(".md")));
});

test("repeated consolidation does not duplicate a promoted lesson's pointer", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-con-dedup-"));
	// prose first line → the pointer is written in the NEW `- <summary> — \`lessons/<rel>\``
	// format, which a prose-based parser failed to recognize on the next run.
	await addLesson("git/rec", {
		scope: "project",
		cwd,
		body: "Atomic commits keep history readable.",
	});
	await addLesson("git/rec", { scope: "project", cwd });
	consolidate({ scope: "project", cwd }); // promote → write pointer
	consolidate({ scope: "project", cwd }); // must re-read and keep exactly one pointer
	const core = readFileSync(coreFile("project", cwd), "utf8");
	assert.match(core, /Atomic commits keep history readable/);
	assert.equal((core.match(/lessons\/git\/rec\.md/g) || []).length, 1);
	// user content in the Core section must survive consolidation untouched
	const corePath = coreFile("project", cwd);
	writeFileSync(
		corePath,
		readFileSync(corePath, "utf8") + "\n- A user-authored note\n",
	);
	consolidate({ scope: "project", cwd });
	const after = readFileSync(corePath, "utf8");
	assert.ok(after.includes("- A user-authored note"));
	assert.equal((after.match(/lessons\/git\/rec\.md/g) || []).length, 1);
});
