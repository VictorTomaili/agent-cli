import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
	readdirSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolated store: AGENT_CLI_HOME must be set BEFORE the skill modules are imported
// (paths.js resolves STORE_DIR from it at module load). This keeps the fixture
// store under a throwaway temp dir — no real ~/.skill-cli is touched.
const TMP = mkdtempSync(path.join(tmpdir(), "agent-skill-update-"));
process.env.AGENT_CLI_HOME = TMP;
process.env.SKILL_CLI_HOME = TMP; // paths.js prefers SKILL_CLI_HOME — isolate from any ambient value

const update = await import("../src/skills/commands/update.js");
const store = await import("../src/skills/lib/store.js");
const removeCmd = await import("../src/skills/commands/remove.js");
const paths = await import("../src/skills/lib/paths.js");

const STORE_DIR = paths.STORE_DIR;

// ---- fixture helpers -------------------------------------------------------

// The fixture seam in npx.js (SKILL_CLI_FETCH_FIXTURE) copies a local tree into a
// temp .claude/skills/ so `skill update` runs with zero network. Each test points
// it at a freshly built fixture matching what it wants to fetch.
function makeFixture(...skills) {
	const root = mkdtempSync(path.join(tmpdir(), "agent-skill-fixture-"));
	for (const s of skills) {
		const d = path.join(root, s.dir);
		mkdirSync(d, { recursive: true });
		writeFileSync(
			path.join(d, "SKILL.md"),
			`---\nname: ${s.name}\nversion: ${s.version}\ndescription: test\n---\n\nbody\n`,
		);
		writeFileSync(path.join(d, "helper.js"), s.helper || "module.exports = 1\n");
	}
	return root;
}

// Plant a fake installed skill inside the store. `dir` is the real on-disk
// directory (trusted); `name` is the frontmatter `name:` to plant (may be a
// traversal payload such as "../../victim").
function plantSkill(dir, { name, version = "1.0.0", source = "fixture-src" }) {
	const d = path.join(STORE_DIR, dir);
	mkdirSync(d, { recursive: true });
	writeFileSync(
		path.join(d, "SKILL.md"),
		`---\nname: ${name}\nversion: ${version}\ndescription: test\n---\n\nbody\n`,
	);
	writeFileSync(path.join(d, ".source"), source + "\n");
	writeFileSync(path.join(d, "helper.js"), "module.exports = 1\n");
	return d;
}

function resetStore() {
	rmSync(STORE_DIR, { recursive: true, force: true });
	mkdirSync(STORE_DIR, { recursive: true });
}

// Sentinel files OUTSIDE the store that a traversal escape would read/delete or
// overwrite. `victim/.source` exists so the OLD vulnerable code would have treated
// the victim dir as the skill and swapped/removed it in place.
const VICTIM_DIR = path.join(TMP, "victim");
const VICTIM_FILE = path.join(TMP, "victim-file.txt");
function plantVictim() {
	mkdirSync(VICTIM_DIR, { recursive: true });
	writeFileSync(path.join(VICTIM_DIR, "marker.txt"), "intact");
	writeFileSync(path.join(VICTIM_DIR, ".source"), "victim-source\n");
	writeFileSync(VICTIM_FILE, "intact");
}
function assertVictimIntact() {
	assert.equal(readFileSync(path.join(VICTIM_DIR, "marker.txt"), "utf8"), "intact");
	assert.equal(readFileSync(VICTIM_FILE, "utf8"), "intact");
}
function tmpEntries() {
	return readdirSync(TMP).sort();
}

// ---- sanitizeSkillName ------------------------------------------------------

test("sanitizeSkillName rejects traversal, absolute, and backslash names", () => {
	const bad = [
		"../../victim",
		"..\\..\\victim", // Windows separator
		"C:\\escape\\victim", // Windows absolute
		"/etc/passwd", // POSIX absolute
		"..",
		"...",
		"a/../b",
		"a\\..\\b",
		".hidden",
	];
	for (const b of bad) {
		assert.equal(store.sanitizeSkillName(b), null, `should reject ${JSON.stringify(b)}`);
	}
	const good = ["research", "code-review", "my.skill_1", "a-b.c", "Research"];
	for (const g of good) {
		assert.equal(store.sanitizeSkillName(g), g, `should accept ${JSON.stringify(g)}`);
	}
});

// ---- malicious frontmatter names cannot escape the store ---------------------

test("malicious frontmatter name (../../victim) cannot escape the store", () => {
	resetStore();
	plantVictim();
	const before = tmpEntries();
	plantSkill("evil", { name: "../../victim", version: "1.0.0", source: "fixture-src" });
	// The fetched source ships a SKILL.md whose name matches the malicious name —
	// the OLD code would have matched it and swapped the victim dir in place.
	process.env.SKILL_CLI_FETCH_FIXTURE = makeFixture({
		dir: "evil-copy",
		name: "../../victim",
		version: "2.0.0",
	});

	const entry = store.listStore().find((s) => s.dir === "evil");
	assert.ok(entry, "installed skill found");
	assert.equal(entry.name, "../../victim"); // frontmatter name is surfaced as-is

	const status = update.updateOne(entry);
	assert.equal(status, "failed");

	// nothing outside the store was read, deleted, or written
	assertVictimIntact();
	assert.deepEqual(tmpEntries(), before);
	// the in-store skill was NOT replaced by the fetched copy
	assert.match(
		readFileSync(path.join(STORE_DIR, "evil", "SKILL.md"), "utf8"),
		/version: 1\.0\.0/,
	);
});

test("backslash traversal name (..\\..\\victim) is rejected", () => {
	plantVictim();
	plantSkill("evil-backslash", { name: "..\\..\\victim", version: "1.0.0", source: "fixture-src" });

	const entry = store.listStore().find((s) => s.dir === "evil-backslash");
	assert.ok(entry);
	assert.equal(entry.name, "..\\..\\victim");
	assert.equal(update.updateOne(entry), "failed");
	assertVictimIntact();
});

test("absolute-path frontmatter name is rejected", () => {
	plantVictim();
	plantSkill("evil-abs", { name: "/escape/victim", version: "1.0.0", source: "fixture-src" });

	const entry = store.listStore().find((s) => s.dir === "evil-abs");
	assert.ok(entry);
	assert.equal(update.updateOne(entry), "failed");
	assertVictimIntact();
});

// ---- legitimate names still update normally ----------------------------------

test("legitimately-named skill still updates normally", () => {
	resetStore();
	plantSkill("good-skill", { name: "good-skill", version: "1.0.0", source: "fixture-src" });
	process.env.SKILL_CLI_FETCH_FIXTURE = makeFixture({
		dir: "good-skill",
		name: "good-skill",
		version: "2.0.0",
		helper: "module.exports = 2\n",
	});

	const entry = store.listStore().find((s) => s.name === "good-skill");
	assert.ok(entry);
	assert.equal(update.updateOne(entry), "updated");

	const md = readFileSync(path.join(STORE_DIR, "good-skill", "SKILL.md"), "utf8");
	assert.match(md, /version: 2\.0\.0/);
	// the recorded source is preserved across the update
	assert.equal(
		readFileSync(path.join(STORE_DIR, "good-skill", ".source"), "utf8").trim(),
		"fixture-src",
	);
});

test("up-to-date skill reports current (hash path still works)", () => {
	resetStore();
	plantSkill("good-skill", { name: "good-skill", version: "1.0.0", source: "fixture-src" });
	process.env.SKILL_CLI_FETCH_FIXTURE = makeFixture({
		dir: "good-skill",
		name: "good-skill",
		version: "1.0.0",
	});

	const entry = store.listStore().find((s) => s.name === "good-skill");
	assert.ok(entry);
	assert.equal(update.updateOne(entry), "current");
});

// ---- cmdUpdate failure signaling ---------------------------------------------

test("P0-1: skill remove with a malicious frontmatter name cannot delete outside the store", () => {
	resetStore();
	plantVictim();
	plantSkill("evil-remove", { name: "../../victim", version: "1.0.0", source: "fixture-src" });

	// Removing BY the malicious frontmatter name ('../../victim') must resolve
	// to the canonical on-disk dir entry and delete only inside the store —
	// never path.join(STORE_DIR, name) which would escape.
	const origExit = process.exit;
	process.exit = () => {};
	try {
		removeCmd.cmdRemove(["../../victim", "-y"]);
	} finally {
		process.exit = origExit;
	}
	assertVictimIntact(); // sentinel outside the store is untouched
	assert.ok(
		!existsSync(path.join(STORE_DIR, "evil-remove")),
		"in-store skill directory removed",
	);
});

test("cmdUpdate exits 1 when a skill has a malicious name (nothing escapes)", () => {
	resetStore();
	plantVictim();
	plantSkill("evil", { name: "../../victim", version: "1.0.0", source: "fixture-src" });

	const origExit = process.exit;
	let exitCode = null;
	process.exit = (c) => {
		exitCode = c;
		throw new Error("process.exit(" + c + ")");
	};
	let threw = false;
	try {
		update.cmdUpdate([]);
	} catch {
		threw = true;
	} finally {
		process.exit = origExit;
	}
	assert.equal(threw, true);
	assert.equal(exitCode, 1);
	assertVictimIntact();
});
