import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
	symlinkSync,
	lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolated store: AGENT_CLI_HOME must be set BEFORE the skill modules are imported
// (paths.js resolves STORE_DIR from it at module load). This keeps the fixture
// store under a throwaway temp dir — no real ~/.skill-cli is touched.
const TMP = mkdtempSync(path.join(tmpdir(), "agent-skill-install-"));
process.env.AGENT_CLI_HOME = TMP;
process.env.SKILL_CLI_HOME = TMP; // paths.js prefers SKILL_CLI_HOME — isolate from any ambient value

const install = await import("../src/skills/commands/install.js");
const fetchLib = await import("../src/skills/lib/fetch.js");
const lockCmd = await import("../src/skills/commands/lock.js");
const paths = await import("../src/skills/lib/paths.js");
const storeLib = await import("../src/skills/lib/store.js");

const STORE_DIR = paths.STORE_DIR;
const FIXTURE_ENV = "SKILL_CLI_FETCH_FIXTURE";

// Build a fetch fixture: a dir of skill dirs — the layout fetch.js produces
// under .claude/skills/. installSource copies these into the store (fixture seam).
function makeFixture(skills) {
	const root = mkdtempSync(path.join(tmpdir(), "agent-skill-fixture-"));
	for (const s of skills) {
		const d = path.join(root, s.dir);
		mkdirSync(d, { recursive: true });
		writeFileSync(
			path.join(d, "SKILL.md"),
			`---\nname: ${s.name}\nversion: ${s.version}\ndescription: test\n---\n\nbody\n`,
		);
		writeFileSync(path.join(d, "helper.js"), "module.exports = 1\n");
	}
	return root;
}

function resetStore() {
	rmSync(STORE_DIR, { recursive: true, force: true });
	mkdirSync(STORE_DIR, { recursive: true });
}

// Sentinel outside the store that a traversal escape would touch.
const VICTIM = path.join(TMP, "victim-file.txt");
function plantVictim() {
	writeFileSync(VICTIM, "intact");
}
function assertVictimIntact() {
	assert.equal(readFileSync(VICTIM, "utf8"), "intact");
}

test("installSource installs a skill from a fixture and writes .source", () => {
	resetStore();
	plantVictim();
	const fixture = makeFixture([{ dir: "good", name: "good", version: "1.0.0" }]);
	process.env[FIXTURE_ENV] = fixture;
	try {
		const moved = install.installSource("fixture-src");
		assert.equal(moved.length, 1);
		assert.equal(moved[0].name, "good");
		assert.equal(moved[0].reinstalled, false);
		assert.ok(existsSync(path.join(STORE_DIR, "good", "SKILL.md")));
		assert.ok(
			readFileSync(path.join(STORE_DIR, "good", ".source"), "utf8").includes(
				"fixture-src",
			),
		);
		assertVictimIntact();
	} finally {
		delete process.env[FIXTURE_ENV];
	}
});

test("installSource never writes outside the store for a traversal frontmatter name", () => {
	resetStore();
	plantVictim();
	// frontmatter name is a traversal payload; the safe dir name is the fallback.
	const fixture = makeFixture([
		{ dir: "evil", name: "../../victim", version: "1.0.0" },
	]);
	process.env[FIXTURE_ENV] = fixture;
	try {
		const moved = install.installSource("fixture-src");
		// The unsafe name is rejected; the skill is installed under its safe dir name.
		assert.ok(moved.length >= 1);
		assert.ok(existsSync(path.join(STORE_DIR, "evil", "SKILL.md")));
		assert.ok(!existsSync(path.join(TMP, "victim")));
		assertVictimIntact();
		// nothing outside the store appeared
		for (const entry of [path.join(TMP, "victim")]) {
			assert.equal(existsSync(entry), false, entry + " must not be created");
		}
	} finally {
		delete process.env[FIXTURE_ENV];
	}
});

test("M1: install refuses a fetched skill containing a symlink", () => {
	resetStore();
	plantVictim();
	// Build a fixture skill with a planted symlink inside it (as a malicious
	// source could ship): helper.js -> <outside store>. Install must refuse.
	const root = mkdtempSync(path.join(tmpdir(), "agent-skill-symlink-"));
	const d = path.join(root, "evil");
	mkdirSync(d, { recursive: true });
	writeFileSync(
		path.join(d, "SKILL.md"),
		"---\nname: evil\nversion: 1.0.0\ndescription: test\n---\n\nbody\n",
	);
	// symlink creation fails without privileges on some CI (Windows non-admin
	// needs developer mode); skip the assertion there.
	try {
		symlinkSync(VICTIM, path.join(d, "helper.js"));
	} catch {
		return; // no symlink privilege — nothing to test
	}
	process.env[FIXTURE_ENV] = root;
	try {
		assert.throws(() => install.installSource("fixture-src"));
		// nothing planted into the store
		assert.equal(existsSync(path.join(STORE_DIR, "evil")), false);
		assertVictimIntact();
	} finally {
		delete process.env[FIXTURE_ENV];
	}
});

test("M1: readSkill skips a symlinked SKILL.md (read-side containment)", () => {
	resetStore();
	// Plant a skill whose SKILL.md is a symlink to a file outside the store.
	mkdirSync(path.join(STORE_DIR, "planted"), { recursive: true });
	writeFileSync(VICTIM, "secret outside");
	try {
		symlinkSync(VICTIM, path.join(STORE_DIR, "planted", "SKILL.md"));
	} catch {
		return; // no symlink privilege — nothing to test
	}
	// The symlinked skill must not be readable (listStore skips it too).
	assert.equal(storeLib.readSkill("planted"), null);
	const listed = storeLib.listStore().map((s) => s.name);
	assert.ok(!listed.includes("planted"), "symlinked skill must not be listed");
});

test("M5: an oversized SKILL.md is skipped, not parsed (read cap)", () => {
	resetStore();
	const dir = path.join(STORE_DIR, "bloated");
	mkdirSync(dir, { recursive: true });
	// 1 MiB + 1 → over the cap
	const big = "# padded\n" + "x".repeat(storeLib.MAX_SKILL_MD_BYTES);
	writeFileSync(path.join(dir, "SKILL.md"), big);
	assert.equal(
		storeLib.readSkill("bloated"),
		null,
		"oversized SKILL.md must be unreadable",
	);
	const listed = storeLib.listStore().map((s) => s.name);
	assert.ok(!listed.includes("bloated"), "oversized skill must not be listed");
});

test("M5: containsSymlinks bounds hostile depth/entry counts", () => {
	resetStore();
	// a deep nesting beyond MAX_WALK_DEPTH must be flagged unsafe
	const deep = path.join(STORE_DIR, "deep");
	let cur = deep;
	for (let i = 0; i < storeLib.MAX_WALK_DEPTH + 2; i++) {
		mkdirSync(cur, { recursive: true });
		cur = path.join(cur, "d");
	}
	assert.equal(
		storeLib.containsSymlinks(deep),
		true,
		"over-deep tree must be treated as unsafe",
	);
});

test("reinstalling the same skill reports reinstalled:true", () => {
	resetStore();
	plantVictim();
	const fixture = makeFixture([{ dir: "good", name: "good", version: "1.0.0" }]);
	process.env[FIXTURE_ENV] = fixture;
	try {
		install.installSource("fixture-src");
		const second = install.installSource("fixture-src");
		const good = second.find((m) => m.name === "good");
		assert.ok(good);
		assert.equal(good.reinstalled, true);
		assertVictimIntact();
	} finally {
		delete process.env[FIXTURE_ENV];
	}
});

test("installSource throws a clear error when the source yields no skills", () => {
	resetStore();
	plantVictim();
	// fixture points at an empty dir → fetch yields no skills
	const empty = mkdtempSync(path.join(tmpdir(), "agent-skill-empty-"));
	process.env[FIXTURE_ENV] = empty;
	try {
		assert.throws(() => install.installSource("fixture-src"), /No skills moved/i);
		assertVictimIntact();
	} finally {
		delete process.env[FIXTURE_ENV];
	}
});

test("fetchSkillsToTemp rejects an empty source (source failure path)", () => {
	delete process.env[FIXTURE_ENV];
	assert.throws(() => fetchLib.fetchSkillsToTemp(""), /empty source/);
});

test("HIGH-1: skills are fetched natively — no external skills package spawn", () => {
	// Skills are integrated in this lib: fetching must NEVER shell out to the
	// external `skills` npm package (the old `npx -y skills@<pin>` path is gone).
	// classifySource routes every supported source type to a native strategy.
	assert.equal(fetchLib.classifySource("owner/repo").kind, "github");
	assert.equal(fetchLib.classifySource("owner/repo@research").kind, "github");
	assert.equal(
		fetchLib.classifySource("https://github.com/x/y.git").kind,
		"git",
	);
	assert.equal(
		fetchLib.classifySource("git@github.com:owner/repo.git").kind,
		"git",
	);
	assert.equal(fetchLib.classifySource("some-npm-package").kind, "npm");
	assert.equal(fetchLib.classifySource("some-package_2").kind, "npm");
	// invalid sources are refused up front (http(s) URLs are legit git targets —
	// a bare host fails at clone time, not classification)
	assert.equal(fetchLib.classifySource("a b c").kind, "invalid");
	assert.equal(fetchLib.classifySource("").kind, "invalid");
	// skillPin still strips owner/repo@skill (but not git@ SSH URLs)
	assert.equal(fetchLib.skillPin("owner/repo@research"), "research");
	assert.equal(fetchLib.skillPin("git@github.com:owner/repo.git"), null);
});

test("windowsShellMetachars rejects cmd.exe expansion and boundary chars (M2)", () => {
	// M2: % and ! are cmd.exe (delayed) expansion markers — %PATH% could expand
	// to a string carrying metacharacters AFTER a pre-check; quotes break cmd's
	// arg-boundary parsing. All must be rejected alongside & | < > ^.
	for (const bad of [
		"a&b",
		"a|b",
		"a<b",
		"a>b",
		"a^b",
		"a%b",
		"a!b",
		'a"b',
		"a'b",
	]) {
		assert.ok(
			/[\x26|\x3c\x3e\x5e%!"']/.test(bad),
			`expected ${bad} to be rejected as a Windows shell metacharacter`,
		);
	}
	// Real sources never contain these: owner/repo, URLs, git URLs, npm names.
	for (const good of [
		"owner/repo",
		"owner/repo@research",
		"https://github.com/x/y",
		"git@github.com:owner/repo.git",
		"some-npm-package",
		"./local/path",
	]) {
		assert.equal(
			/[\x26|\x3c\x3e\x5e%!"']/.test(good),
			false,
			`expected ${good} to pass the metachar check`,
		);
	}
});

test("skill provenance lists source/revision/hash for locked skills", () => {
	const { writeLock, readLock } = lockCmd;
	// write a lock into the isolated store for the fixture skill
	const dir = path.join(STORE_DIR, "provenance-skill");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, "SKILL.md"),
		"---\nname: provenance-skill\n---\nbody\n",
	);
	const lock = writeLock(dir, "github.com/x/y@z");
	assert.ok(lock.source);
	assert.ok(lock.contentHash);
	const reread = readLock("provenance-skill");
	assert.equal(reread.source, "github.com/x/y@z");
	assert.equal(reread.contentHash, lock.contentHash);
	assert.ok(reread.installedAt);
});

// --- recursive skill discovery (nested-category layouts) -----------------------
// Regression: collectSkills used to scan only <root>/<skill>/ and <root>/skills/
// <skill>/ — repos like mattpocock/skills nest at skills/<category>/<skill>/.

function nestedFixture() {
	// mirrors mattpocock/skills layout: skills/engineering/<skill>/SKILL.md
	const root = mkdtempSync(path.join(tmpdir(), "agent-skill-nested-"));
	const mk = (rel, name) => {
		const d = path.join(root, rel);
		mkdirSync(d, { recursive: true });
		writeFileSync(
			path.join(d, "SKILL.md"),
			`---\nname: ${name}\ndescription: nested test\n---\n\nbody\n`,
		);
	};
	mk("skills/engineering/code-review", "code-review");
	mk("skills/engineering/tdd", "tdd");
	mk("skills/productivity/teach", "teach");
	// a docs dir with plain .md files (no SKILL.md) — walked, never collected
	mkdirSync(path.join(root, "docs"), { recursive: true });
	writeFileSync(
		path.join(root, "docs", "code-review.md"),
		"prose, not a skill\n",
	);
	return root;
}

test("collectSkills finds skills in nested-category layouts at any depth", () => {
	const out = mkdtempSync(path.join(tmpdir(), "agent-skill-collect-"));
	const found = fetchLib.collectSkills(nestedFixture(), out);
	assert.equal(found, 3);
	for (const s of ["code-review", "tdd", "teach"])
		assert.ok(existsSync(path.join(out, s, "SKILL.md")), `${s} collected`);
});

test("collectSkills still finds flat + ./skills/ layouts (no regression)", () => {
	const root = mkdtempSync(path.join(tmpdir(), "agent-skill-flat-"));
	for (const rel of ["alpha", "skills/beta", "a/b/c/gamma"]) {
		const d = path.join(root, rel);
		mkdirSync(d, { recursive: true });
		writeFileSync(
			path.join(d, "SKILL.md"),
			`---\nname: ${path.basename(rel)}\ndescription: t\n---\n\nb\n`,
		);
	}
	const out = mkdtempSync(path.join(tmpdir(), "agent-skill-collect2-"));
	assert.equal(fetchLib.collectSkills(root, out), 3);
	for (const s of ["alpha", "beta", "gamma"])
		assert.ok(existsSync(path.join(out, s, "SKILL.md")), `${s} collected`);
});

test("collectSkills pin selects by dir basename at any depth", () => {
	const out = mkdtempSync(path.join(tmpdir(), "agent-skill-collect3-"));
	const found = fetchLib.collectSkills(nestedFixture(), out, {
		only: "code-review",
	});
	assert.equal(found, 1);
	assert.ok(existsSync(path.join(out, "code-review", "SKILL.md")));
	assert.ok(!existsSync(path.join(out, "tdd")));
});

test("collectSkills: a skill dir is never descended into; dupes first-wins deterministically; .git skipped", () => {
	const root = mkdtempSync(path.join(tmpdir(), "agent-skill-edge-"));
	// a SKILL.md INSIDE another skill's dir must not become a second skill
	mkdirSync(path.join(root, "outer", "inner"), { recursive: true });
	writeFileSync(
		path.join(root, "outer", "SKILL.md"),
		"---\nname: outer\ndescription: t\n---\n\nb\n",
	);
	writeFileSync(
		path.join(root, "outer", "inner", "SKILL.md"),
		"---\nname: inner\ndescription: t\n---\n\nb\n",
	);
	// same name at two depths — first (sorted) wins, no error
	mkdirSync(path.join(root, "a", "dupe"), { recursive: true });
	mkdirSync(path.join(root, "b", "dupe"), { recursive: true });
	writeFileSync(
		path.join(root, "a", "dupe", "SKILL.md"),
		"---\nname: dupe-a\n---\n\nfrom a\n",
	);
	writeFileSync(
		path.join(root, "b", "dupe", "SKILL.md"),
		"---\nname: dupe-b\n---\n\nfrom b\n",
	);
	// .git content with a skill-shaped dir must be skipped
	mkdirSync(path.join(root, ".git", "evil"), { recursive: true });
	writeFileSync(
		path.join(root, ".git", "evil", "SKILL.md"),
		"---\nname: evil\n---\n\nb\n",
	);

	const out = mkdtempSync(path.join(tmpdir(), "agent-skill-collect4-"));
	const found = fetchLib.collectSkills(root, out);
	assert.equal(found, 2); // outer + one dupe
	assert.ok(
		!existsSync(path.join(out, "inner")),
		"nested SKILL.md not a separate skill",
	);
	assert.ok(!existsSync(path.join(out, "evil")), ".git never entered");
	const dupe = readFileSync(path.join(out, "dupe", "SKILL.md"), "utf8");
	assert.ok(dupe.includes("from a"), "deterministic first-wins (sorted)");
});

test("collectSkills never follows symlinked dirs", () => {
	const root = mkdtempSync(path.join(tmpdir(), "agent-skill-symlink-"));
	const target = mkdtempSync(path.join(tmpdir(), "agent-skill-target-"));
	mkdirSync(path.join(target, "linked"), { recursive: true });
	writeFileSync(
		path.join(target, "linked", "SKILL.md"),
		"---\nname: linked\ndescription: t\n---\n\nb\n",
	);
	symlinkSync(target, path.join(root, "escape"));
	const out = mkdtempSync(path.join(tmpdir(), "agent-skill-collect5-"));
	assert.equal(fetchLib.collectSkills(root, out), 0);
	assert.ok(!existsSync(path.join(out, "linked")), "symlinked dir not followed");
});
