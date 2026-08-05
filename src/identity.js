// src/identity.js — apply identity/soul archetypes; set sections; onboard suggestions.

import path from "node:path";
import fsp from "node:fs/promises";
import { exists, readFile, writeFile, HOME } from "./util.js";
import {
	IDENTITIES,
	SOULS,
	identityContent,
	soulContent,
	DEFAULT_IDENTITY,
	ONBOARD_QUESTION,
	onboardOptions,
} from "./archetypes.js";
import { kindForFile, resolveField, setTag as setTagValue } from "./fields.js";

function base(scope, cwd) {
	return scope === "project"
		? path.join(cwd, ".agents")
		: path.join(HOME, ".agents");
}
export function idFile(scope, cwd) {
	return path.join(base(scope, cwd), "IDENTITY.md");
}
export function soulFile(scope, cwd) {
	return path.join(base(scope, cwd), "SOUL.md");
}

export async function applyIdentity(
	key,
	{ scope = "global", cwd = process.cwd() } = {},
) {
	const fp = idFile(scope, cwd);
	await guardScope(fp, scope, cwd);
	// Preserve a user-set <AGENT_NAME> across re-applies — the archetype template
	// always emits an empty name, so a plain overwrite would clobber it (G6).
	let existingName = null;
	try {
		const m = /<AGENT_NAME>([^<]*)<\/AGENT_NAME>/.exec(await readFile(fp));
		if (m && m[1].trim()) existingName = m[1].trim();
	} catch {
		/* file absent */
	}
	let content = identityContent(key);
	if (existingName) {
		content = content.replace(
			/<AGENT_NAME><\/AGENT_NAME>/,
			`<AGENT_NAME>${existingName}</AGENT_NAME>`,
		);
	}
	await writeFile(fp, content);
	return { file: fp, identity: key, namePreserved: Boolean(existingName) };
}
export async function applySoul(
	key,
	{ scope = "global", cwd = process.cwd() } = {},
) {
	const fp = soulFile(scope, cwd);
	await guardScope(fp, scope, cwd);
	await writeFile(fp, soulContent(key));
	return { file: fp, soul: key };
}
export function listIdentities() {
	return Object.entries(IDENTITIES).map(([k, v]) => ({
		key: k,
		label: v.label,
		role: v.role,
	}));
}
export function listSouls() {
	return Object.entries(SOULS).map(([k, v]) => ({ key: k, label: v.label }));
}
export function onboardSuggest() {
	return {
		question: ONBOARD_QUESTION,
		default: DEFAULT_IDENTITY,
		options: onboardOptions(),
		souls: listSouls(),
	};
}

/**
 * GAP-4: verify `file` resolves under the scope base (`.agents` dir for the
 * given scope). A symlinked .agents or a caller-supplied path must never let
 * identity writes escape. Resolves the nearest existing ancestor when the file
 * doesn't exist yet (same pattern as spect.js containedIn).
 */
async function containedInScope(baseDir, file) {
	// Base absent (fresh install): nothing to symlink yet — trivially safe,
	// the write creates the dir. Base present: must be a real (non-symlink)
	// dir and the file must resolve under the base's REAL path.
	let baseReal;
	try {
		baseReal = await fsp.realpath(baseDir);
	} catch {
		return true; // base doesn't exist yet
	}
	try {
		const baseLstat = await fsp.lstat(baseDir);
		if (baseLstat.isSymbolicLink()) return false;
	} catch {
		return false;
	}
	const sep = path.sep;
	let probe = file;
	for (;;) {
		try {
			const candReal = await fsp.realpath(probe);
			return (
				candReal === baseReal ||
				candReal.startsWith(baseReal + sep)
			);
		} catch {
			const parent = path.dirname(probe);
			if (parent === probe) return false;
			probe = parent;
		}
	}
}

async function guardScope(file, scope, cwd) {
	if (!(await containedInScope(base(scope, cwd), file))) {
		const err = new Error(
			`refusing to write outside the ${scope} scope (${file})`,
		);
		err.code = "ESCAPE";
		throw err;
	}
}

/** Set a field by name: tag-aware for identity/soul/user (sets <TAG>…</TAG>);
 *  falls back to replacing/inserting a ## <section> for other files. */
export async function setSection(file, section, body, { scope = "global", cwd = process.cwd() } = {}) {
	await guardScope(file, scope, cwd);
	let content = (await exists(file)) ? await readFile(file) : `# ${section}\n`;
	const kind = kindForFile(path.basename(file));
	const field = kind ? resolveField(kind, section) : null;
	if (field) {
		content = setTagValue(content, field.tag, body);
	} else {
		const heading = section.startsWith("## ") ? section : `## ${section}`;
		const lines = content.split(/\r?\n/);
		const start = lines.findIndex((l) => l.trim() === heading);
		if (start < 0) {
			content = `${content.trimEnd()}\n\n${heading}\n${body}\n`;
		} else {
			let end = start + 1;
			while (end < lines.length && !/^##\s/.test(lines[end])) end++;
			lines.splice(start + 1, end - start - 1, body);
			content = lines.join("\n");
		}
	}
	await writeFile(file, content);
	return file;
}
