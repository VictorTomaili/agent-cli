// Secret-store symlink regression tests (SEC-3 / SEC-4).
//
// Threat model: an untrusted repo (a cloned project, a PR branch you checked
// out) ships a `.agents/` directory containing a SYMLINK where agent-cli
// expects one of its project-scoped secret files. Running `agent-cli secret
// set|get` inside that repo then writes through the link and truncates
// whatever it points at — ~/.ssh/id_ed25519, a build output, anything the
// user can write.
//
//   SEC-3  [cwd]/.agents/.secrets.json → victim   (triggered by `secret set`,
//          which ends in writeStore())
//   SEC-4  [cwd]/.agents/.secrets.key  → victim   (triggered by loadKey(),
//          which runs BEFORE any secret-exists check — so a read-only
//          `secret get` of a name that does not exist is enough to fire it)
//
// Both guards are "replace the directory entry, never follow it": writeStore()
// routes through the symlink-safe atomic writer in util.js (temp + exclusive
// 'wx' create + rename-over), and loadKey() rmSync()es an unusable entry before
// exclusively re-creating the key. Each test asserts the VICTIM's bytes are
// untouched and that the store/key path is a real file afterwards — delete
// either guard and the victim assertion fails.
//
// Filesystem effects are confined to fresh mkdtemp dirs: AGENT_CLI_HOME for the
// global scope, a scratch "project" cwd per test, and a separate victim dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	lstatSync,
	readlinkSync,
	symlinkSync,
	openSync,
	fstatSync,
	closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate HOME BEFORE importing agent-cli modules so nothing real is touched.
process.env.AGENT_CLI_HOME = mkdtempSync(
	path.join(tmpdir(), "agent-secrets-symlink-home-"),
);
const secrets = await import("../src/secrets.js");

const IS_WIN = process.platform === "win32";

/** A scratch project cwd with an existing `.agents/` dir, plus a victim file. */
function fixture(tag, victimContents) {
	const cwd = mkdtempSync(path.join(tmpdir(), `agent-${tag}-proj-`));
	mkdirSync(path.join(cwd, ".agents"), { recursive: true });
	const victim = path.join(
		mkdtempSync(path.join(tmpdir(), `agent-${tag}-victim-`)),
		"precious",
	);
	writeFileSync(victim, victimContents);
	return { cwd, victim };
}

/**
 * Plant `linkPath` → `target`. Returns the error when the OS refused to create
 * a symlink at all (unprivileged Windows without Developer Mode), so the caller
 * can t.skip() instead of reporting a false pass. Any other failure is a real
 * one and is rethrown.
 */
function plantSymlink(target, linkPath) {
	try {
		symlinkSync(target, linkPath, "file");
		return null;
	} catch (err) {
		if (["EPERM", "EACCES", "ENOSYS"].includes(err?.code)) return err;
		throw err;
	}
}

const SKIP_REASON = (err) =>
	`symlink creation is not permitted here (${err.code}) — cannot plant the ` +
	`attack fixture; enable Developer Mode / run elevated to exercise this guard`;

// -----------------------------------------------------------------------------
// SEC-3: `secret set` must not write through a symlinked .secrets.json
// -----------------------------------------------------------------------------

test("SEC-3: setSecret replaces a symlinked .secrets.json instead of writing through it", (t) => {
	// Deliberately NOT valid JSON: readStore() must fall back to an empty store
	// rather than merging the attacker's file into ours.
	const VICTIM = "victim: private key material, do not clobber\n";
	const { cwd, victim } = fixture("sec3", VICTIM);

	const store = secrets.secretsPath("project", cwd);
	assert.equal(
		store,
		path.join(cwd, ".agents", ".secrets.json"),
		"fixture: project store must live at [cwd]/.agents/.secrets.json",
	);

	const refused = plantSymlink(victim, store);
	if (refused) {
		t.skip(SKIP_REASON(refused));
		return;
	}
	// Assert the fixture by reading the link's TARGET rather than by stat'ing the
	// path. It is the stronger claim - it proves the link points at the victim,
	// not merely that something symlink-shaped exists - and a stat predicate here
	// pairs with the descriptor opened after the write into the check-then-use
	// shape js/file-system-race blocks on.
	assert.equal(
		readlinkSync(store),
		victim,
		"fixture: the planted store path must be a symlink pointing at the victim",
	);

	const result = secrets.setSecret("K", "v", { scope: "project", cwd });
	assert.equal(result.ok, true, "setSecret must still succeed");

	// The guard: the write landed on a NEW file, not through the link.
	assert.equal(
		readFileSync(victim, "utf8"),
		VICTIM,
		"SEC-3: writing a project secret must not truncate the symlink's target",
	);
	// ...and the store is genuinely ours: the secret round-trips.
	assert.equal(
		secrets.getSecret("K", { scope: "project", cwd }),
		"v",
		"the replacement store must hold the secret we just set",
	);

	// Every property of the replacement entry is taken from ONE descriptor,
	// opened before any path check. Re-stat'ing the path per assertion is a
	// check-then-use race (js/file-system-race, which this repo's CodeQL policy
	// lists as blocking), and it is also weaker than what this test claims: the
	// point is that a single real entry replaced the link, so every fact must
	// come from that same entry rather than from whatever the path resolves to
	// on the next call.
	const fd = openSync(store, "r");
	let st;
	let body;
	try {
		st = fstatSync(fd);
		body = readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
	// The one question a descriptor cannot answer, asked last.
	const entry = lstatSync(store);

	assert.equal(
		entry.isSymbolicLink(),
		false,
		"SEC-3: the planted symlink must be replaced by a real file",
	);
	assert.equal(
		st.isFile(),
		true,
		"SEC-3: the store must be a regular file after the write",
	);
	assert.ok(
		!body.includes("do not clobber"),
		"the new store must not contain the victim's bytes",
	);
	if (!IS_WIN)
		assert.equal(
			st.mode & 0o777,
			0o600,
			"SEC-3: the replacement store must be 0600, never world-readable",
		);
});

// -----------------------------------------------------------------------------
// SEC-4: loadKey must not write through a symlinked .secrets.key
// -----------------------------------------------------------------------------

test("SEC-4: loadKey replaces a symlinked .secrets.key instead of writing through it", (t) => {
	// Length != 32, so loadKey() rejects it as a key and takes the mint path —
	// the exact branch that used to clobber the target.
	const VICTIM = "victim: ssh private key material, do not clobber\n";
	assert.notEqual(
		Buffer.byteLength(VICTIM),
		32,
		"fixture: the victim must not be a plausible 32-byte key",
	);
	const { cwd, victim } = fixture("sec4", VICTIM);

	const kp = secrets.keyPath("project", cwd);
	assert.equal(
		kp,
		path.join(cwd, ".agents", ".secrets.key"),
		"fixture: project key must live at [cwd]/.agents/.secrets.key",
	);

	const refused = plantSymlink(victim, kp);
	if (refused) {
		t.skip(SKIP_REASON(refused));
		return;
	}
	// Assert the fixture by reading the link's TARGET rather than by stat'ing the
	// path. It is the stronger claim - it proves the link points at the victim,
	// not merely that something symlink-shaped exists - and a stat predicate here
	// pairs with the descriptor opened after the write into the check-then-use
	// shape js/file-system-race blocks on.
	assert.equal(
		readlinkSync(kp),
		victim,
		"fixture: the planted key path must be a symlink pointing at the victim",
	);

	const key = secrets.loadKey("project", cwd);

	assert.equal(Buffer.isBuffer(key), true, "loadKey must return a Buffer");
	assert.equal(key.length, 32, "loadKey must return a usable 32-byte key");
	assert.equal(
		readFileSync(victim, "utf8"),
		VICTIM,
		"SEC-4: minting a key must not overwrite the symlink's target",
	);
	// Every property of the replacement entry is taken from ONE descriptor,
	// opened before any path check. Re-stat'ing the path per assertion is a
	// check-then-use race (js/file-system-race, which this repo's CodeQL policy
	// lists as blocking), and it is also weaker than what this test claims: the
	// point is that a single real entry replaced the link, so every fact must
	// come from that same entry rather than from whatever the path resolves to
	// on the next call.
	const fd = openSync(kp, "r");
	let st;
	let onDisk;
	try {
		st = fstatSync(fd);
		onDisk = readFileSync(fd);
	} finally {
		closeSync(fd);
	}
	const entry = lstatSync(kp);

	assert.equal(
		entry.isSymbolicLink(),
		false,
		"SEC-4: the planted symlink must be replaced by a real key file",
	);
	assert.deepEqual(
		onDisk,
		key,
		"the key on disk must be the key that was returned",
	);
	if (!IS_WIN)
		assert.equal(
			st.mode & 0o777,
			0o600,
			"SEC-4: the replacement key must be 0600",
		);
});

test("SEC-4: a read-only `secret get` miss still must not write through a symlinked .secrets.key", (t) => {
	// loadKey() runs before the "No such secret" check, so merely reading a
	// name that does not exist is enough to reach the mint path. Nothing the
	// user did should be able to destroy a file from a read.
	const VICTIM = "victim: read path must be harmless too\n";
	const { cwd, victim } = fixture("sec4-read", VICTIM);

	const kp = secrets.keyPath("project", cwd);
	const refused = plantSymlink(victim, kp);
	if (refused) {
		t.skip(SKIP_REASON(refused));
		return;
	}
	assert.equal(readlinkSync(kp), victim, "fixture: symlink planted at victim");

	assert.throws(
		() => secrets.getSecret("NOPE", { scope: "project", cwd }),
		/No such secret/,
		"reading a missing secret must still report it as missing",
	);
	assert.equal(
		readFileSync(victim, "utf8"),
		VICTIM,
		"SEC-4: a failed read must not truncate the symlink's target",
	);
	assert.equal(
		lstatSync(kp).isSymbolicLink(),
		false,
		"SEC-4: the planted symlink must be replaced, not followed",
	);
});

// loadKey() replaces an unusable key entry. "Unusable" has to mean provably so:
// a symlink (the SEC-4 attack) or a regular file that is not a 32-byte key.
// It previously removed ANY entry that existed, so a directory at that path —
// someone else's data, or a misconfiguration — was deleted without a word.
test("SEC-4: loadKey refuses to remove an entry that is neither file nor symlink", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-key-dir-proj-"));
	mkdirSync(path.join(cwd, ".agents"), { recursive: true });
	const kp = path.join(cwd, ".agents", ".secrets.key");
	mkdirSync(kp, { recursive: true });
	// A marker inside proves the directory was not blown away.
	writeFileSync(path.join(kp, "keep-me"), "not the agent's data");

	assert.throws(
		() => secrets.loadKey("project", cwd),
		/neither a regular file nor a symlink/,
		"loadKey must refuse rather than delete an unexpected entry",
	);
	assert.equal(
		readFileSync(path.join(kp, "keep-me"), "utf8"),
		"not the agent's data",
		"the directory and its contents must survive untouched",
	);
});

// SEC-4b: the WRITE side was symlink-safe but the READ side was not. loadKey()
// short-circuits on an existing 32-byte key, and it read that key with a plain
// readFileSync — so an untrusted repo could point [cwd]/.agents/.secrets.key at
// any 32-byte file on the machine and have agent-cli silently adopt those bytes
// as the project's encryption key. The earlier SEC-4 test could not catch this:
// its victim is a text file whose length is not 32, so the read returned null
// and fell through to the replace path by accident rather than by guard.
test("SEC-4b: loadKey must not read a key THROUGH a symlink to a 32-byte file", (t) => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-key-read-proj-"));
	mkdirSync(path.join(cwd, ".agents"), { recursive: true });
	const kp = path.join(cwd, ".agents", ".secrets.key");

	// A 32-byte victim: exactly the shape loadKey accepts as a valid key.
	const victimDir = mkdtempSync(path.join(tmpdir(), "agent-key-read-victim-"));
	const victim = path.join(victimDir, "someone-elses-32-bytes");
	const VICTIM_KEY = Buffer.alloc(32, 0xab);
	writeFileSync(victim, VICTIM_KEY);

	const refused = plantSymlink(victim, kp);
	if (refused) {
		t.skip(SKIP_REASON(refused));
		return;
	}

	const key = secrets.loadKey("project", cwd);
	assert.equal(Buffer.isBuffer(key), true, "loadKey must still return a Buffer");
	assert.equal(key.length, 32, "loadKey must still return a usable key");
	assert.notDeepEqual(
		key,
		VICTIM_KEY,
		"SEC-4b: the victim's bytes must never become the project's key",
	);
	assert.deepEqual(
		readFileSync(victim),
		VICTIM_KEY,
		"SEC-4b: the victim file itself must be untouched",
	);
	// Asked last: no path use follows it, so this stays a plain assertion rather
	// than a check-then-use.
	assert.equal(
		lstatSync(kp).isSymbolicLink(),
		false,
		"SEC-4b: the planted symlink must have been replaced by a real key file",
	);
});

