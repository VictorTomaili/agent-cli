// src/secrets.js — machine-local encrypted secret store.
// AES-256-GCM with a per-scope 0600 key file. Secrets are NEVER synced and are
// redacted from files/brief/search. Stored in .secrets.json (global ~/.agents,
// or [cwd]/.agents for project scope).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HOME, AGENTS_DIR } from "./util.js";

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

/** Load (or create) the 32-byte AES key for a scope. */
export function loadKey(scope = "global", cwd = process.cwd()) {
	const kp = keyPath(scope, cwd);
	fs.mkdirSync(path.dirname(kp), { recursive: true });
	if (fs.existsSync(kp)) {
		const buf = fs.readFileSync(kp);
		if (buf.length === 32) return buf;
	}
	const key = crypto.randomBytes(32);
	fs.writeFileSync(kp, key, { mode: 0o600 });
	return key;
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
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(store, null, 2) + "\n", {
		mode: 0o600,
	});
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
