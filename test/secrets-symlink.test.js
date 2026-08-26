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
	statSync,
	symlinkSync,
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
	assert.equal(
		lstatSync(store).isSymbolicLink(),
		true,
		"fixture: the planted store path must actually be a symlink",
	);

	const result = secrets.setSecret("K", "v", { scope: "project", cwd });
	assert.equal(result.ok, true, "setSecret must still succeed");

	// The guard: the write landed on a NEW file, not through the link.
	assert.equal(
		readFileSync(victim, "utf8"),
		VICTIM,
		"SEC-3: writing a project secret must not truncate the symlink's target",
	);
	assert.equal(
		lstatSync(store).isSymbolicLink(),
		false,
		"SEC-3: the planted symlink must be replaced by a real file",
	);
	assert.equal(
		statSync(store).isFile(),
		true,
		"SEC-3: the store must be a regular file after the write",
	);

	// ...and the store is genuinely ours: the secret round-trips.
	assert.equal(
		secrets.getSecret("K", { scope: "project", cwd }),
		"v",
		"the replacement store must hold the secret we just set",
	);
	assert.ok(
		!readFileSync(store, "utf8").includes("do not clobber"),
		"the new store must not contain the victim's bytes",
	);

	if (!IS_WIN)
		assert.equal(
			statSync(store).mode & 0o777,
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
	assert.equal(
		lstatSync(kp).isSymbolicLink(),
		true,
		"fixture: the planted key path must actually be a symlink",
	);

	const key = secrets.loadKey("project", cwd);

	assert.equal(Buffer.isBuffer(key), true, "loadKey must return a Buffer");
	assert.equal(key.length, 32, "loadKey must return a usable 32-byte key");
	assert.equal(
		readFileSync(victim, "utf8"),
		VICTIM,
		"SEC-4: minting a key must not overwrite the symlink's target",
	);
	assert.equal(
		lstatSync(kp).isSymbolicLink(),
		false,
		"SEC-4: the planted symlink must be replaced by a real key file",
	);
	assert.deepEqual(
		readFileSync(kp),
		key,
		"the key on disk must be the key that was returned",
	);

	if (!IS_WIN)
		assert.equal(
			statSync(kp).mode & 0o777,
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
	assert.equal(lstatSync(kp).isSymbolicLink(), true, "fixture: symlink planted");

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
