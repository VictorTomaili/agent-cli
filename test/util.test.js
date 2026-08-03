import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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
