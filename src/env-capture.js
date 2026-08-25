// src/env-capture.js — autodetect machine-local environment and fill ENVIRONMENTS.md.
// Detects OS/arch/shell/home and discovers ~/.ssh/config aliases. Filling is
// non-destructive: only empty `- Field:` lines are written.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { identityFilePath } from "./agents-lib.js";
import { exists, readFile, writeFile, escapeRegExp } from "./util.js";

/** Detect local environment facts. */
export function detectEnvironment() {
	return {
		user: os.userInfo().username || process.env.USERNAME || "",
		os: os.platform(),
		release: os.release(),
		arch: os.arch(),
		shell:
			process.env.SHELL ||
			(process.platform === "win32" ? "powershell" : "/bin/sh"),
		home: os.homedir(),
		node: process.version,
	};
}

/** Parse `Host <alias>` names from ~/.ssh/config (excludes the `*` wildcard). */
export function sshAliases() {
	const config = path.join(os.homedir(), ".ssh", "config");
	try {
		const content = fs.readFileSync(config, "utf8");
		const aliases = [];
		for (const line of content.split(/\r?\n/)) {
			const m = /^\s*Host\s+([^\s*].*)$/.exec(line);
			if (m)
				for (const a of m[1].split(/\s+/))
					if (a && a !== "*") aliases.push(a);
		}
		return [...new Set(aliases)].sort();
	} catch {
		return [];
	}
}

const FIELD_ORDER = [
	["User:", "user"],
	["OS:", "os"],
	["Shell:", "shell"],
	["Home:", "home"],
];

/** Fill empty `- Field:` lines in ENVIRONMENTS.md from detected facts. */
export function fillLocalFields(content, detected) {
	let filled = 0;
	const out = content.split(/\r?\n/).map((line) => {
		for (const [label, key] of FIELD_ORDER) {
			const re = new RegExp(`^-\\s*${label}\\s*$`);
			if (!re.test(line)) continue;
			let value;
			if (key === "os") value = `${detected.os} ${detected.release} (${detected.arch})`;
			else value = String(detected[key] ?? "");
			if (!value.trim()) return line;
			filled++;
			return `- ${label} ${value}`;
		}
		return line;
	});
	return { content: out.join("\n"), filled };
}

/**
 * Detect the environment and fill the ENVIRONMENTS.md file for a scope.
 * Non-destructive: only empty fields are written. Returns what was detected.
 */
export async function captureAndApply({
	scope = "global",
	cwd = process.cwd(),
} = {}) {
	const detected = detectEnvironment();
	const aliases = sshAliases();
	const file = identityFilePath("environments", scope, cwd);
	if (!(await exists(file)))
		return { ok: false, reason: `ENVIRONMENTS.md not found (${file})` };
	const raw = await readFile(file);
	const { content, filled } = fillLocalFields(raw, detected);
	await writeFile(file, content);
	return {
		ok: true,
		file,
		filled,
		detected,
		sshAliases: aliases,
	};
}

/** Set a specific `- <Field>: <value>` line in ENVIRONMENTS.md (adds if absent). */
export async function setEnvironmentField(
	field,
	value,
	{ scope = "global", cwd = process.cwd() } = {},
) {
	const file = identityFilePath("environments", scope, cwd);
	if (!(await exists(file)))
		return { ok: false, reason: `ENVIRONMENTS.md not found (${file})` };
	const raw = await readFile(file);
	// Typos guard: updating an existing line is always allowed. Adding a NEW
	// field that is not a tracked ENV_LOCAL_* key succeeds but is flagged with
	// a warning (the gap detector won't track it), so a misspelling is visible
	// instead of silently appending an unfillable junk line.
	const { ENVIRONMENT_FIELDS } = await import("./fields.js");
	const known = ENVIRONMENT_FIELDS.map((f) => f.key);
	// `field` is caller-supplied and interpolated into a pattern. Unescaped, a
	// field named `.*` matches every line, so the typo guard below reports the
	// opposite of the truth for exactly the inputs it exists to catch.
	const re = new RegExp(`^-\\s*${escapeRegExp(field)}\\s*:.*$`, "m");
	const warning =
		!re.test(raw) && !known.includes(field)
			? `note: '${field}' is not a tracked ENV_LOCAL_* field (${known.join(", ")}) — the gap detector won't monitor it`
			: null;
	let content;
	if (re.test(raw)) {
		content = raw.replace(re, `- ${field}: ${value}`);
	} else {
		// append after the "## Local (primary)" header, else at the end
		const header = /(^## Local[^\n]*\n)/m.exec(raw);
		if (header) {
			const idx = header.index + header[0].length;
			content = raw.slice(0, idx) + `- ${field}: ${value}\n` + raw.slice(idx);
		} else {
			content = raw + `\n- ${field}: ${value}\n`;
		}
	}
	await writeFile(file, content);
	return { ok: true, file, field, value, ...(warning ? { warning } : {}) };
}
