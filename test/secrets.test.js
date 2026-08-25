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
const HOME = process.env.AGENT_CLI_HOME;

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
	if (process.platform !== "win32") assert.equal(statSync(kp).mode & 0o777, 0o600);
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
	assert.notEqual(secrets.secretsPath("project", cwd), secrets.secretsPath("global"));
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
