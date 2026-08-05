import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
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
const npx = await import("../src/skills/lib/npx.js");
const lockCmd = await import("../src/skills/commands/lock.js");
const paths = await import("../src/skills/lib/paths.js");

const STORE_DIR = paths.STORE_DIR;
const FIXTURE_ENV = "SKILL_CLI_FETCH_FIXTURE";

// Build a fetch fixture: a dir of skill dirs — the layout npx produces under
// .claude/skills/. installSource copies these into the store (see npx.js seam).
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
	assert.throws(() => npx.fetchSkillsToTemp(""), /empty source/);
});

test("HIGH-1: npx spawn pins the skills package version (no unpinned -y skills)", () => {
	const win = npx.buildNpxSpawn("owner/repo", "win32");
	const posix = npx.buildNpxSpawn("owner/repo", "linux");
	const args = [...win.args, ...posix.args];
	// every invocation must reference a pinned skills@version, never bare 'skills'
	assert.ok(args.some((a) => /^skills@\d+\.\d+\.\d+/.test(a)), "expected pinned skills@x.y.z");
	assert.ok(!args.some((a) => a === "skills"), "bare unpinned 'skills' is forbidden");
	// a pinned source (owner/repo@skill) must not pass --skill '*'
	const pinned = npx.buildNpxSpawn("owner/repo@research", "linux");
	assert.ok(!pinned.args.includes("--skill"));
});

test("windowsShellMetachars rejects cmd.exe expansion and boundary chars (M2)", () => {
	// M2: % and ! are cmd.exe (delayed) expansion markers — %PATH% could expand
	// to a string carrying metacharacters AFTER a pre-check; quotes break cmd's
	// arg-boundary parsing. All must be rejected alongside & | < > ^.
	for (const bad of ["a&b", "a|b", "a<b", "a>b", "a^b", "a%b", "a!b", 'a"b', "a'b"]) {
		assert.ok(
			npx.windowsShellMetachars(bad),
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
			npx.windowsShellMetachars(good),
			null,
			`expected ${good} to pass the metachar check`,
		);
	}
});

test("skill provenance lists source/revision/hash for locked skills", () => {
	const { writeLock, readLock } = lockCmd;
	// write a lock into the isolated store for the fixture skill
	const dir = path.join(STORE_DIR, "provenance-skill");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "SKILL.md"), "---\nname: provenance-skill\n---\nbody\n");
	const lock = writeLock(dir, "github.com/x/y@z");
	assert.ok(lock.source);
	assert.ok(lock.contentHash);
	const reread = readLock("provenance-skill");
	assert.equal(reread.source, "github.com/x/y@z");
	assert.equal(reread.contentHash, lock.contentHash);
	assert.ok(reread.installedAt);
});
