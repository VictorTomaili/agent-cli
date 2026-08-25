import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
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

// --- sanitizePathSegment ----------------------------------------------------
// Folds a caller-supplied id into ONE filename segment. Unlike resolveContained
// (which refuses an escaping relative path), this flattens an id that is only
// ever interpolated into a filename.

test("sanitizePathSegment strips traversal and separators", () => {
	const s = util.sanitizePathSegment;
	assert.equal(s("../../../PWNED"), "PWNED");
	assert.equal(s("....evil"), "evil");
	assert.equal(s("a/b/c"), "a-b-c");
	assert.equal(s(".."), null);
	assert.equal(s("..."), null);
	assert.equal(s("/"), null);
	assert.equal(s(""), null);
	assert.equal(s(null), null);
	assert.equal(s(undefined), null);
	// never yields a dotfile, and never leaves a trailing dot
	assert.equal(s(".hidden"), "hidden");
	assert.equal(s("trailing."), "trailing");
});

test("sanitizePathSegment preserves case and the safe character set", () => {
	const s = util.sanitizePathSegment;
	// case must survive: task id T1 must not collide with t1
	assert.equal(s("T1"), "T1");
	assert.notEqual(s("T1"), s("t1"));
	assert.equal(s("h-1735689600000-fix-parser"), "h-1735689600000-fix-parser");
	assert.equal(s("a.b_c-D9"), "a.b_c-D9");
	// a UUID session id passes through untouched
	assert.equal(
		s("0b5faf32-60f5-473a-a044-8a1ced4ccd0b"),
		"0b5faf32-60f5-473a-a044-8a1ced4ccd0b",
	);
});

// --- escapeRegExp -----------------------------------------------------------
// Anything interpolated into `new RegExp(...)` that is meant to match literally
// has to come through here, or every metacharacter in it goes live.

test("escapeRegExp makes a metacharacter match literally", () => {
	const e = util.escapeRegExp;
	// The concrete bug this exists for: env-capture builds
	// `^-\s*<field>\s*:.*$` from a caller-supplied field name. Unescaped, a
	// field of ".*" matches every line, so the typo guard reports the opposite
	// of the truth.
	const line = "- SOME_KEY: value";
	const build = (f) => new RegExp("^-\\s*" + f + "\\s*:.*$", "m");
	assert.equal(build(".*").test(line), true, "unescaped .* matches — the bug");
	assert.equal(build(e(".*")).test(line), false, "escaped .* must not match");
	// and a real key still matches
	assert.equal(build(e("SOME_KEY")).test(line), true);
	assert.equal(build(e("OTHER_KEY")).test(line), false);
});

test("escapeRegExp escapes every regex metacharacter, and leaves the rest alone", () => {
	const e = util.escapeRegExp;
	for (const ch of [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]) {
		const escaped = e(ch);
		assert.equal(escaped, "\\" + ch, `${ch} must be escaped`);
		// round-trip: the escaped form matches the literal character
		assert.equal(new RegExp("^" + escaped + "$").test(ch), true);
	}
	assert.equal(e("SOME_KEY-1.2"), "SOME_KEY-1\\.2");
	assert.equal(e(""), "");
	assert.equal(e(null), "");
	assert.equal(e(undefined), "");
});

test("sanitizePathSegment caps length", () => {
	const s = util.sanitizePathSegment;
	assert.equal(s("x".repeat(200)).length, 64);
	assert.equal(s("x".repeat(200), { max: 10 }).length, 10);
});

// --- writeFileIfAbsent ------------------------------------------------------
// Extends the secrets.js:35 primitive. The `wx` flag makes the open atomic
// with respect to a pre-planted symlink — EEXIST returns before any read or
// write follows the link.

test("writeFileIfAbsent: created:true on a fresh path", () => {
	const f = path.join(TMP, "wia-new.txt");
	const r = util.writeFileIfAbsent(f, "hello");
	assert.equal(r.created, true);
	assert.equal(fs.readFileSync(f, "utf8"), "hello");
});

test("writeFileIfAbsent: created:false on EEXIST — never overwrites", () => {
	const f = path.join(TMP, "wia-exist.txt");
	fs.writeFileSync(f, "first");
	const r = util.writeFileIfAbsent(f, "second");
	assert.equal(r.created, false);
	assert.equal(fs.readFileSync(f, "utf8"), "first");
});

test("writeFileIfAbsent: refuses to follow a pre-planted symlink (wx is atomic)", () => {
	if (process.platform === "win32") {
		// skip — symlink privilege differs; covered by an integration test
		return;
	}
	const dir = path.join(TMP, "wia-sym");
	mkdirSync(dir, { recursive: true });
	const real = path.join(dir, "victim.txt");
	const link = path.join(dir, "sneaky.txt");
	fs.writeFileSync(real, "do-not-touch");
	symlinkSync(real, link);
	const r = util.writeFileIfAbsent(link, "hijack");
	assert.equal(r.created, false, "wx must EEXIST before following the symlink");
	assert.equal(fs.readFileSync(real, "utf8"), "do-not-touch");
});

test("writeFileIfAbsent: throws through non-EEXIST errors (ENOENT)", () => {
	assert.throws(
		() => util.writeFileIfAbsent(path.join(TMP, "nope-dir-xyz", "x.txt"), "x"),
		/ENOENT/,
	);
});

// --- readFileNoFollow -------------------------------------------------------
// Opens fd with O_NOFOLLOW (POSIX) or O_RDONLY + fstat guard (Windows).
// The fstat guard catches Windows junctions which appear as S_IFLNK.

test("readFileNoFollow: roundtrips a regular file", () => {
	const f = path.join(TMP, "rfn-regular.txt");
	fs.writeFileSync(f, "hello");
	assert.equal(util.readFileNoFollow(f), "hello");
});

test("readFileNoFollow: refuses a symlink", () => {
	if (process.platform === "win32") return;
	const dir = path.join(TMP, "rfn-sym");
	mkdirSync(dir, { recursive: true });
	const real = path.join(dir, "real.txt");
	const link = path.join(dir, "link.txt");
	fs.writeFileSync(real, "secret");
	symlinkSync(real, link);
	assert.throws(() => util.readFileNoFollow(link), /symlink/);
	// and the victim is untouched
	assert.equal(fs.readFileSync(real, "utf8"), "secret");
});

test("readFileNoFollow: refuses a directory", () => {
	assert.throws(() => util.readFileNoFollow(TMP), /not a regular file/);
});

test("readFileNoFollow: throws ENOENT for missing", () => {
	assert.throws(
		() => util.readFileNoFollow(path.join(TMP, "rfn-missing.txt")),
		/ENOENT/,
	);
});

test("readFileNoFollow: maxBytes cap is enforced", () => {
	const f = path.join(TMP, "rfn-cap.txt");
	fs.writeFileSync(f, "a".repeat(100));
	assert.throws(() => util.readFileNoFollow(f, { maxBytes: 50 }), /cap/);
	assert.equal(util.readFileNoFollow(f, { maxBytes: 200 }), "a".repeat(100));
});
