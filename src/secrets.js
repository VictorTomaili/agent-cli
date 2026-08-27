// src/secrets.js — machine-local encrypted secret store.
// AES-256-GCM with a per-scope 0600 key file. Secrets are NEVER synced and are
// redacted from files/brief/search. Stored in .secrets.json (global ~/.agents,
// or [cwd]/.agents for project scope).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
	HOME,
	AGENTS_DIR,
	writeFileSync,
	writeFileIfAbsent,
	readFileNoFollow,
} from "./util.js";

export const SECRETS_FILE = ".secrets.json";
export const SECRETS_KEY = ".secrets.key";

function scopeDir(scope, cwd = process.cwd()) {
	return scope === "project" ? path.join(path.resolve(cwd), ".agents") : AGENTS_DIR;
}

export function secretsPath(scope = "global", cwd = process.cwd()) {
	return path.join(scopeDir(scope, cwd), SECRETS_FILE);
}

export function keyPath(scope = "global", cwd = process.cwd()) {
	return path.join(scopeDir(scope, cwd), SECRETS_KEY);
}

/**
 * Load (or create) the 32-byte AES key for a scope.
 *
 * Created with the exclusive `wx` flag rather than a plain write behind an
 * `existsSync` check. That check-then-write is a race, and losing it here is
 * not a hiccup: two agent-cli processes starting at once could both see "no
 * key", both generate one, and the second write would replace the key the
 * first had already encrypted secrets with — silently making them
 * undecryptable. With `wx` the loser gets EEXIST and re-reads the winner's key.
 */
export function loadKey(scope = "global", cwd = process.cwd()) {
	const kp = keyPath(scope, cwd);
	fs.mkdirSync(path.dirname(kp), { recursive: true });
	// Symlink-safe READ, not just a symlink-safe write. writeFileIfAbsent's 'wx'
	// refuses to follow a planted link, but a plain readFileSync here would
	// happily follow one — so an untrusted repo could point [cwd]/.agents/
	// .secrets.key at any 32-byte file on the machine and have agent-cli adopt
	// its bytes as the project's encryption key. A refusal returns null, which
	// falls through to the replace path below and removes the link.
	const readExisting = () => {
		try {
			const buf = readFileNoFollow(kp, { encoding: null, maxBytes: 1024 });
			return buf.length === 32 ? buf : null;
		} catch {
			return null;
		}
	};

	const existing = readExisting();
	if (existing) return existing;

	const key = crypto.randomBytes(32);
	// writeFileIfAbsent is the shared exclusive-create primitive ('wx' refuses to
	// follow a symlink pre-planted at kp, and reports EEXIST as created:false).
	if (writeFileIfAbsent(kp, key, { mode: 0o600 }).created) return key;

	// Something is already there. Prefer whatever is on disk — overwriting is what
	// destroys secrets — so re-read in case we simply lost the create race.
	const raced = readExisting();
	if (raced) return raced;

	// It did not read back as a 32-byte key. Replace it only when it is provably
	// unusable: a SYMLINK (remove the link, never its target, so the exclusive
	// re-create below cannot be redirected through it) or a regular file of the
	// wrong size (truncated/corrupt).
	//
	// A right-sized file that merely failed to READ is a PERMISSION problem, not a
	// corrupt key — readExisting() swallows every read error, so it looks the same
	// from here. Deleting it would throw away secrets its owner can still decrypt,
	// and unlike the in-place write this replaced, rmSync needs only directory
	// write permission, so it would succeed where the old code correctly failed.
	let st = null;
	try {
		st = fs.lstatSync(kp);
	} catch {
		st = null; // vanished under us — fall through and re-create
	}
	if (st && st.isFile() && !st.isSymbolicLink() && st.size === 32) {
		throw new Error(
			`secrets key at ${kp} exists but could not be read — refusing to replace it (check permissions)`,
		);
	}
	// Remove ONLY what we can prove is unusable: a symlink (the SEC-4 attack)
	// or a regular file that is not a 32-byte key. Anything else - a directory,
	// a FIFO, a device - is someone else's data or a misconfiguration, and
	// deleting it silently would be exactly the destructive behaviour this
	// guard exists to prevent.
	if (st) {
		if (!st.isSymbolicLink() && !st.isFile())
			throw new Error(
				`secrets key path ${kp} exists but is neither a regular file nor a symlink — refusing to replace it`,
			);
		fs.rmSync(kp, { force: true });
	}

	if (writeFileIfAbsent(kp, key, { mode: 0o600 }).created) return key;
	// Lost a concurrent re-create: the winner's key is authoritative.
	const raced2 = readExisting();
	if (raced2) return raced2;
	throw new Error(
		`could not create the secrets key at ${kp} — it exists but is not a usable 32-byte key`,
	);
}

function readStore(scope, cwd) {
	const p = secretsPath(scope, cwd);
	if (!fs.existsSync(p)) return { version: 1, secrets: {} };
	try {
		const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
		if (parsed && typeof parsed === "object" && parsed.secrets) return parsed;
	} catch {
		/* corrupt → treat as empty, original bytes preserved below on write? */
	}
	return { version: 1, secrets: {} };
}

function writeStore(store, scope, cwd) {
	const p = secretsPath(scope, cwd);
	// Route through the symlink-safe atomic writer (temp + exclusive 'wx' create
	// + rename-over). A plain 'w' write followed a symlink pre-planted at
	// [cwd]/.agents/.secrets.json in an untrusted repo and truncated its target;
	// rename-over replaces the symlink itself, leaving the target untouched. Keep
	// the 0600 mode so the store is never briefly world-readable.
	writeFileSync(p, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}

function encrypt(key, value) {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return { iv: iv.toString("base64"), tag: tag.toString("base64"), data: ct.toString("base64") };
}

function decrypt(key, entry) {
	const iv = Buffer.from(entry.iv, "base64");
	const tag = Buffer.from(entry.tag, "base64");
	const data = Buffer.from(entry.data, "base64");
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Store an encrypted secret. Returns { ok, name, scope, file }. */
export function setSecret(name, value, { scope = "global", cwd = process.cwd() } = {}) {
	if (!name || typeof name !== "string")
		return { ok: false, reason: "secret name is required" };
	const key = loadKey(scope, cwd);
	const store = readStore(scope, cwd);
	store.secrets[name] = encrypt(key, value);
	writeStore(store, scope, cwd);
	return { ok: true, name, scope, file: secretsPath(scope, cwd) };
}

/** Read a secret. Throws when the secret does not exist. */
export function getSecret(name, { scope = "global", cwd = process.cwd() } = {}) {
	const key = loadKey(scope, cwd);
	const entry = readStore(scope, cwd).secrets[name];
	if (!entry) throw new Error(`No such secret: ${name}`);
	return decrypt(key, entry);
}

/** List secret names (never values). */
export function listSecretNames({ scope = "global", cwd = process.cwd() } = {}) {
	return Object.keys(readStore(scope, cwd).secrets).sort();
}

/** Remove a secret. Returns { ok, name, existed }. */
export function rmSecret(name, { scope = "global", cwd = process.cwd() } = {}) {
	const store = readStore(scope, cwd);
	const existed = Object.prototype.hasOwnProperty.call(store.secrets, name);
	if (!existed) return { ok: true, name, existed: false, file: secretsPath(scope, cwd) };
	delete store.secrets[name];
	writeStore(store, scope, cwd);
	return { ok: true, name, existed: true, file: secretsPath(scope, cwd) };
}

/** Export as `NAME=value` lines for shell env injection (values decrypted). */
export function secretEnv({ scope = "global", cwd = process.cwd() } = {}) {
	const key = loadKey(scope, cwd);
	const store = readStore(scope, cwd);
	const out = [];
	for (const name of Object.keys(store.secrets).sort())
		try {
			out.push(`${name}=${decrypt(key, store.secrets[name])}`);
		} catch {
			/* skip unreadable */
		}
	return out;
}

export { HOME, AGENTS_DIR };
