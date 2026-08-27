// Secrets store tests: AES-256-GCM round-trip, scoping, and non-plaintext storage.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	readFileSync,
	writeFileSync,
	existsSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

process.env.AGENT_CLI_HOME = mkdtempSync(path.join(tmpdir(), "agent-secrets-"));
const secrets = await import("../src/secrets.js");

test("loadKey never replaces an existing key (a race would make secrets undecryptable)", () => {
	// The key is created with the exclusive `wx` flag. Repeated calls, and a
	// call that finds a key already on disk, must both return THAT key — if a
	// second caller overwrote it, everything encrypted with the first would be
	// permanently unreadable.
	const first = secrets.loadKey();
	const second = secrets.loadKey();
	assert.deepEqual(second, first, "loadKey must be stable across calls");

	const kp = secrets.keyPath();
	assert.ok(existsSync(kp));
	const onDisk = readFileSync(kp);
	assert.equal(onDisk.length, 32);
	assert.deepEqual(onDisk, first, "the returned key must be the one on disk");

	// Simulate losing the race: a different 32-byte key appears on disk.
	const other = randomBytes(32);
	// lgtm[js/file-system-race] -- this IS the race the test simulates
	writeFileSync(kp, other);
	assert.deepEqual(
		secrets.loadKey(),
		other,
		"an existing key on disk must win over minting a new one",
	);
	// restore, so the round-trip tests below still decrypt
	// lgtm[js/file-system-race] -- restore-fixture
	writeFileSync(kp, first);
});

test("set/get round-trips a secret", () => {
	const r = secrets.setSecret("API_KEY", "s3cr3t-value");
	assert.equal(r.ok, true);
	assert.equal(secrets.getSecret("API_KEY"), "s3cr3t-value");
});

test("secrets are not stored in plaintext", () => {
	const raw = readFileSync(secrets.secretsPath("global"), "utf8");
	assert.ok(!raw.includes("s3cr3t-value"));
});

test("key file exists with 0600 permissions", () => {
	const kp = secrets.keyPath("global");
	assert.equal(existsSync(kp), true);
	if (process.platform !== "win32")
		assert.equal(statSync(kp).mode & 0o777, 0o600);
});

test("list returns names only; missing get throws", () => {
	secrets.setSecret("B", "2");
	assert.deepEqual(secrets.listSecretNames(), ["API_KEY", "B"]);
	assert.throws(() => secrets.getSecret("missing"), /No such secret/);
});

test("rm removes a secret and is idempotent", () => {
	const r = secrets.rmSecret("B");
	assert.equal(r.existed, true);
	assert.equal(r.ok, true);
	assert.deepEqual(secrets.listSecretNames(), ["API_KEY"]);
	const again = secrets.rmSecret("B");
	assert.equal(again.existed, false);
});

test("secretEnv exports NAME=value lines", () => {
	const lines = secrets.secretEnv();
	assert.ok(lines.includes("API_KEY=s3cr3t-value"));
});

test("project scope uses a separate store", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "secrets-proj-"));
	const r = secrets.setSecret("PROJ_SECRET", "p", { scope: "project", cwd });
	assert.equal(r.ok, true);
	assert.equal(secrets.getSecret("PROJ_SECRET", { scope: "project", cwd }), "p");
	assert.throws(() => secrets.getSecret("PROJ_SECRET"));
	// keys are scoped too
	assert.ok(existsSync(secrets.keyPath("project", cwd)));
	assert.notEqual(
		secrets.secretsPath("project", cwd),
		secrets.secretsPath("global"),
	);
});

test("regenerating a key invalidates old ciphertext (garbage on decrypt)", () => {
	// Simulate a key file loss + recreate: old entries no longer decrypt cleanly.
	const kp = secrets.keyPath("global");
	secrets.setSecret("LOST", "value");
	// replace key with a fresh one
	writeFileSync(kp, randomBytes(32));
	const env = secrets.secretEnv(); // must not throw; unreadable entries skipped
	assert.ok(!env.some((l) => l.startsWith("LOST=")));
});

// --- write-side size caps -------------------------------------------------
// readStore() caps the store at MAX_STORE_READ_BYTES and reports the refusal as
// an EMPTY store (the SEC-3/SEC-3b symlink tests need that). With no matching
// cap on the write side, one oversized value pushed the file past the read cap,
// every stored secret then read back as absent, and the NEXT set silently
// replaced the whole store with just that one name. Both caps below must stay
// under the read cap for the store to survive a refusal.

test("an oversized value is refused, and the secrets already stored survive", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "secrets-cap-value-"));
	const scope = "project";
	assert.equal(secrets.setSecret("KEEP", "keep-me", { scope, cwd }).ok, true);

	const huge = "x".repeat(secrets.MAX_SECRET_BYTES + 1);
	const r = secrets.setSecret("HUGE", huge, { scope, cwd });
	assert.equal(r.ok, false, "an oversized value must not be written");
	assert.match(r.reason, /HUGE/);
	assert.ok(
		r.reason.includes(`the limit is ${secrets.MAX_SECRET_BYTES} bytes per secret`),
		r.reason,
	);

	// The refusal wrote nothing, so the store is still well under the read cap
	// and everything in it still decrypts.
	assert.deepEqual(secrets.listSecretNames({ scope, cwd }), ["KEEP"]);
	assert.equal(secrets.getSecret("KEEP", { scope, cwd }), "keep-me");
	assert.ok(statSync(secrets.secretsPath(scope, cwd)).size < secrets.MAX_STORE_BYTES);

	// a normal-sized secret still stores
	assert.equal(secrets.setSecret("OK", "y".repeat(1024), { scope, cwd }).ok, true);
	assert.equal(secrets.getSecret("OK", { scope, cwd }), "y".repeat(1024));
});

test("a write that would grow the store past the cap is refused, not silently applied", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "secrets-cap-store-"));
	const scope = "project";
	assert.equal(secrets.setSecret("KEEP", "keep-me", { scope, cwd }).ok, true);

	// Pad the store on disk to just under the write cap. One entry with a large
	// payload stands in for the ~30k ordinary secrets it would otherwise take;
	// nothing ever decrypts it.
	const p = secrets.secretsPath(scope, cwd);
	const store = JSON.parse(readFileSync(p, "utf8"));
	store.secrets.PAD = { iv: "", tag: "", data: "" };
	const serialize = (s) => JSON.stringify(s, null, 2) + "\n";
	const target = secrets.MAX_STORE_BYTES - 512;
	store.secrets.PAD.data = "A".repeat(target - Buffer.byteLength(serialize(store), "utf8"));
	// lgtm[js/file-system-race] -- test fixture: a store already near the cap
	writeFileSync(p, serialize(store));
	assert.equal(statSync(p).size, target);

	// One more ordinary secret does not fit under the cap.
	const r = secrets.setSecret("ONE_MORE", "z".repeat(1024), { scope, cwd });
	assert.equal(r.ok, false, "a write past the store cap must be refused");
	assert.match(r.reason, /ONE_MORE/);
	assert.match(r.reason, /secrets store/);

	// The store on disk is untouched, still under the READ cap, still readable —
	// this is the assertion that fails if the write cap ever drifts above it.
	assert.equal(statSync(p).size, target);
	assert.ok(secrets.MAX_STORE_BYTES < secrets.MAX_STORE_READ_BYTES);
	assert.deepEqual(secrets.listSecretNames({ scope, cwd }), ["KEEP", "PAD"]);
	assert.equal(secrets.getSecret("KEEP", { scope, cwd }), "keep-me");

	// Shrinking is never blocked: removing the padding makes room again.
	assert.equal(secrets.rmSecret("PAD", { scope, cwd }).existed, true);
	assert.equal(secrets.setSecret("ONE_MORE", "z", { scope, cwd }).ok, true);
});
