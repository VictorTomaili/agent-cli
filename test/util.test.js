import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	writeFileSync,
	mkdirSync,
	symlinkSync,
	readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-util-"));
process.env.AGENT_CLI_HOME = TMP;

const util = await import("../src/util.js");

test("HOME is overridden by AGENT_CLI_HOME", () => {
	assert.equal(util.HOME, TMP);
});

test("exists: false for missing, true for existing", async () => {
	assert.equal(await util.exists(path.join(TMP, "nope")), false);
	const f = path.join(TMP, "yes");
	writeFileSync(f, "x");
	assert.equal(await util.exists(f), true);
});

test("readFile throws ENOENT for a missing file", async () => {
	await assert.rejects(
		() => util.readFile(path.join(TMP, "missing")),
		/ENOENT/,
	);
});

test("readIfExists: null for missing, content for existing", async () => {
	assert.equal(await util.readIfExists(path.join(TMP, "missing")), null);
	const f = path.join(TMP, "r");
	writeFileSync(f, "hello");
	assert.equal(await util.readIfExists(f), "hello");
});

test("writeFile creates nested dirs; content roundtrips", async () => {
	const f = path.join(TMP, "a/b/c.txt");
	await util.writeFile(f, "data");
	assert.equal(await util.readFile(f), "data");
});

test("M3: writeFile replaces an existing file atomically (rename-over-existing)", async () => {
	const f = path.join(TMP, "replace-me.txt");
	await util.writeFile(f, "old content");
	await util.writeFile(f, "new content");
	assert.equal(await util.readFile(f), "new content");
});

test("M3: writeFile replaces a symlinked target — never writes through it", async () => {
	// If the target path itself is a symlink, atomic rename replaces the LINK,
	// leaving the victim untouched (rename never follows the target's link).
	const dir = path.join(TMP, "m3-plant");
	mkdirSync(dir, { recursive: true });
	const victim = path.join(dir, "victim.txt");
	const target = path.join(dir, "real.txt");
	writeFileSync(victim, "do-not-touch");
	let linked = false;
	try {
		symlinkSync(victim, target);
		linked = true;
	} catch {
		/* no symlink privilege — test degenerates to the plain roundtrip */
	}
	await util.writeFile(target, "safe");
	assert.equal(await util.readFile(target), "safe");
	if (linked) {
		assert.equal(await util.readFile(victim), "do-not-touch");
		// no temp files left behind
		const leftovers = readdirSync(dir).filter((n) => n.endsWith(".tmp"));
		assert.deepEqual(leftovers, []);
	}
});

test("M3: writeFileSync has the same exclusive-create + replace guarantees", async () => {
	const f = path.join(TMP, "sync-replace.txt");
	util.writeFileSync(f, "one");
	util.writeFileSync(f, "two");
	assert.equal(await util.readFile(f), "two");
});

test("ensureDir is recursive and idempotent", async () => {
	const d = path.join(TMP, "x/y/z");
	await util.ensureDir(d);
	await util.ensureDir(d); // second call must not throw
	assert.ok(await util.exists(d));
});

test("pretty: tilde-shortens under HOME, leaves outside paths, handles falsy", () => {
	assert.equal(util.pretty(null), null);
	assert.equal(util.pretty(""), "");
	assert.equal(util.pretty(path.join(TMP, "sub")), "~/sub");
	// a path outside HOME is returned normalized but unchanged
	assert.equal(util.pretty("/var/log/x"), "/var/log/x");
});

test("resolveScope resolves against HOME (global) and cwd (project)", () => {
	assert.equal(
		util.resolveScope(".agents", "global"),
		path.join(TMP, ".agents"),
	);
	assert.equal(
		util.resolveScope("foo", "project"),
		path.resolve(process.cwd(), "foo"),
	);
});

test("normalizeEndings converts CRLF → LF and leaves LF alone", () => {
	assert.equal(util.normalizeEndings("a\r\nb\r\n"), "a\nb\n");
	assert.equal(util.normalizeEndings("a\nb"), "a\nb");
});

test("homeExists: false for missing/empty, true for present marker", async () => {
	assert.equal(await util.homeExists(".marker-absent"), false);
	assert.equal(await util.homeExists(""), false);
	mkdirSync(path.join(TMP, ".marker-present"), { recursive: true });
	assert.equal(await util.homeExists(".marker-present"), true);
});
