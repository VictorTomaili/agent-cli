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

/**
 * Create a symlink, returning false when the platform refuses to make one.
 *
 * The symlink tests used to `return` unconditionally on win32, which node:test
 * counts as a PASS — so the Windows-specific half of readFileNoFollow's symlink
 * guard had zero coverage on the only platform it exists for, and could be
 * deleted with the suite green. Windows CAN create symlinks (Developer Mode or
 * admin), so attempt it and skip ONLY when the OS actually refuses.
 */
function trySymlink(target, linkPath, type) {
	try {
		symlinkSync(target, linkPath, type);
		return true;
	} catch (e) {
		if (["EPERM", "EACCES", "ENOSYS", "UNKNOWN"].includes(e.code)) return false;
		throw e;
	}
}

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

test("writeFileIfAbsent: refuses to follow a pre-planted symlink (wx is atomic)", (t) => {
	const dir = path.join(TMP, "wia-sym");
	mkdirSync(dir, { recursive: true });
	const real = path.join(dir, "victim.txt");
	const link = path.join(dir, "sneaky.txt");
	fs.writeFileSync(real, "do-not-touch");
	if (!trySymlink(real, link, "file")) {
		t.skip("OS refused symlink creation (no privilege)");
		return;
	}
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

test("readFileNoFollow: refuses a symlink", (t) => {
	const dir = path.join(TMP, "rfn-sym");
	mkdirSync(dir, { recursive: true });
	const real = path.join(dir, "real.txt");
	const link = path.join(dir, "link.txt");
	fs.writeFileSync(real, "secret");
	if (!trySymlink(real, link, "file")) {
		t.skip("OS refused symlink creation (no privilege)");
		return;
	}
	assert.throws(() => util.readFileNoFollow(link), /symlink/);
	// the refusal carries a stable code so callers can fail closed on it
	assert.throws(() => util.readFileNoFollow(link), {
		code: "ESYMLINKREFUSED",
	});
	// and the victim is untouched
	assert.equal(fs.readFileSync(real, "utf8"), "secret");
});

test("readFileNoFollow: refuses a directory junction/symlink (win32 reparse point)", (t) => {
	const dir = path.join(TMP, "rfn-junction");
	mkdirSync(dir, { recursive: true });
	const realDir = path.join(dir, "realdir");
	mkdirSync(realDir, { recursive: true });
	fs.writeFileSync(path.join(realDir, "inner.txt"), "inner-secret");
	const link = path.join(dir, "linkdir");
	// "junction" needs no privilege on Windows; ignored/aliased elsewhere.
	if (!trySymlink(realDir, link, process.platform === "win32" ? "junction" : "dir")) {
		t.skip("OS refused junction/dir-symlink creation");
		return;
	}
	// Opening the reparse point itself must never yield file content.
	assert.throws(() => util.readFileNoFollow(link), /symlink|not a regular file/);
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

// --- readFileNoFollow: the win32 fd-identity guard ---------------------------
// The guard compares lstat(path) against fstat(fd) to catch a path swapped
// between the two calls. It only runs on win32, so a test that merely runs on
// this machine would report PASS on every other platform without executing a
// line of it -- the same blind spot the trySymlink comment above describes.
// process.platform is a configurable data property, so the branch is forced
// directly and the tests are real everywhere.
//
// The disagreement these simulate is not hypothetical: Windows + Node 22.13.0
// reports different dev/ino from lstat and fstat for ordinary files, which fired
// the guard on every regular read and broke 27 tests. Reproducing it needs that
// exact Node build, so the divergence is injected rather than provoked.

/** Run `fn` with process.platform forced to win32, then restore it. */
function asWin32(fn) {
	const real = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", {
		value: "win32",
		configurable: true,
	});
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", real);
	}
}

/** Copy a Stats, overriding fields. Prototype methods read `mode`, so isFile()
 *  and isSymbolicLink() keep working unless deliberately overridden. */
function statWith(st, over) {
	const clone = Object.create(Object.getPrototypeOf(st));
	Object.assign(clone, st, over);
	return clone;
}

/** Patch a node:fs sync stat call for the duration of `fn`. `map` receives the
 *  real Stats, the 1-based call index, and the call's arguments, and returns
 *  what the caller sees. `import fs from "node:fs"` is the mutable CJS module
 *  object shared with src/util.js, so patching here reaches the code under test. */
function withStatPatched(name, map, fn) {
	const real = fs[name];
	let n = 0;
	fs[name] = (...args) => map(real.apply(fs, args), ++n, args);
	try {
		return fn();
	} finally {
		fs[name] = real;
	}
}

/**
 * Rewrite the SECOND lstat of `target` -- the confirming one -- and leave every
 * other lstat alone, the probe's own included.
 *
 * Keyed on the path rather than on a global call index, because the probe lstats
 * a file of its own in between and shifts any index the test might have counted.
 */
function onConfirmingLstat(target, over) {
	let seen = 0;
	return (st, _i, args) =>
		args[0] === target && ++seen === 2 ? statWith(st, over) : st;
}

/**
 * Simulate a runtime whose fstat identity is systematically wrong -- the
 * 22.13.0 shape. EVERY fstat diverges, the probe's own file included, so the
 * probe concludes the comparison is meaningless and the fallback runs.
 */
const brokenFstat = (st) => statWith(st, { ino: st.ino + 1, dev: st.dev + 1 });

/**
 * Simulate a HEALTHY runtime under attack: only the first fstat -- the caller's
 * file -- diverges. The probe's own fstat, the second call, is left real, so it
 * reports identity as trustworthy and the mismatch is taken at face value.
 */
const attackedFstat = (st, i) => (i === 1 ? statWith(st, { ino: st.ino + 1 }) : st);

/** The probe caches per process; each test needs its own verdict. */
function freshProbe(fn) {
	util.__resetFdIdentityProbe();
	try {
		return fn();
	} finally {
		util.__resetFdIdentityProbe();
	}
}

test("readFileNoFollow: win32 fstat/lstat identity disagreement on a stable file is not a refusal", () => {
	const f = path.join(TMP, "rfn-fstat-divergence.txt");
	fs.writeFileSync(f, "payload");
	// The 22.13.0 regression: fstat reports a different file than lstat did, on a
	// path that never moved. The probe finds the same divergence on a file of its
	// own, so the mismatch is known to be noise and the read must proceed.
	const out = freshProbe(() =>
		asWin32(() =>
			withStatPatched("fstatSync", brokenFstat, () => util.readFileNoFollow(f)),
		),
	);
	assert.equal(out, "payload");
});

test("readFileNoFollow: win32 refuses when the path really was swapped", () => {
	const f = path.join(TMP, "rfn-swapped.txt");
	fs.writeFileSync(f, "payload");
	// Same divergence the previous test tolerates -- but here the confirming
	// lstat sees a different file than the approving one did. The path moved and
	// stayed moved, so even the weaker fallback refuses.
	assert.throws(
		() =>
			freshProbe(() =>
				asWin32(() =>
					withStatPatched("fstatSync", brokenFstat, () =>
						withStatPatched(
							"lstatSync",
							onConfirmingLstat(f, { ino: 1 }),
							() => util.readFileNoFollow(f),
						),
					),
				),
			),
		{ code: "ESYMLINKREFUSED" },
	);
});

test("readFileNoFollow: win32 refuses a symlink planted in the check-then-open window", () => {
	const f = path.join(TMP, "rfn-planted.txt");
	fs.writeFileSync(f, "payload");
	// A swap that keeps dev/ino would slip past a numeric comparison alone, so
	// the link itself is checked rather than inferred from the identity.
	assert.throws(
		() =>
			freshProbe(() =>
				asWin32(() =>
					withStatPatched("fstatSync", brokenFstat, () =>
						withStatPatched(
							"lstatSync",
							onConfirmingLstat(f, { isSymbolicLink: () => true }),
							() => util.readFileNoFollow(f),
						),
					),
				),
			),
		{ code: "ESYMLINKREFUSED" },
	);
});

test("readFileNoFollow: win32 refuses a swap REVERTED before the confirming lstat, on a healthy runtime", () => {
	const f = path.join(TMP, "rfn-reverted.txt");
	fs.writeFileSync(f, "payload");
	// The looping-TOCTOU shape: swap the path, let the open land on the attacker's
	// file, then swap it back. Both lstats see the victim and agree, so the
	// same-family confirmation cannot see this -- only the fd can, and here the fd
	// is trustworthy because the probe says so. Every unmodified lstat below is
	// the point: nothing about the PATH looks wrong.
	assert.throws(
		() =>
			freshProbe(() =>
				asWin32(() =>
					withStatPatched("fstatSync", attackedFstat, () =>
						util.readFileNoFollow(f),
					),
				),
			),
		{ code: "ESYMLINKREFUSED" },
	);
});

test("readFileNoFollow: win32 skips the identity guard when the volume reports ino 0", () => {
	const f = path.join(TMP, "rfn-ino-zero.txt");
	fs.writeFileSync(f, "payload");
	// Some volumes report no usable inode. Comparing zeros would refuse every
	// read there, so the guard opts out BEFORE the probe is ever consulted.
	//
	// Asserting only that the read succeeds does not test that: with the opt-out
	// removed, the mismatch reaches a probe that also sees ino 0, calls the
	// runtime unreliable, and falls through to a confirming lstat that agrees --
	// same result, different route, mutation survives. So the probe is made
	// detectable instead. It is the only thing here that writes a file; if it
	// runs, this throws, and fail-closed turns that into a refusal.
	let probeRan = false;
	const realWrite = fs.writeFileSync;
	fs.writeFileSync = (...args) => {
		probeRan = true;
		throw Object.assign(new Error("probe must not run"), { code: "EACCES" });
	};
	try {
		const out = freshProbe(() =>
			asWin32(() =>
				withStatPatched("fstatSync", (st) => statWith(st, { ino: 0 }), () =>
					util.readFileNoFollow(f),
				),
			),
		);
		assert.equal(out, "payload");
	} finally {
		fs.writeFileSync = realWrite;
	}
	assert.equal(probeRan, false, "ino 0 must short-circuit before the probe");
});

test("readFileNoFollow: the fd-identity probe reports true when it cannot run", () => {
	const f = path.join(TMP, "rfn-probe-broken.txt");
	fs.writeFileSync(f, "payload");
	// An unknown must fail closed. If the probe cannot write its own file it
	// cannot clear the mismatch, so the read is refused rather than allowed.
	const realWrite = fs.writeFileSync;
	assert.throws(
		() =>
			freshProbe(() =>
				asWin32(() =>
					withStatPatched("fstatSync", brokenFstat, () => {
						fs.writeFileSync = () => {
							throw Object.assign(new Error("EACCES: forced"), {
								code: "EACCES",
							});
						};
						try {
							return util.readFileNoFollow(f);
						} finally {
							fs.writeFileSync = realWrite;
						}
					}),
				),
			),
		{ code: "ESYMLINKREFUSED" },
	);
	assert.equal(fs.writeFileSync, realWrite, "writeFileSync must be restored");
});
