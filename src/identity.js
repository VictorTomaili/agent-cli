// src/identity.js — apply identity/soul archetypes; set sections; onboard suggestions.

import path from "node:path";
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
	await writeFile(fp, identityContent(key));
	return { file: fp, identity: key };
}
export async function applySoul(
	key,
	{ scope = "global", cwd = process.cwd() } = {},
) {
	const fp = soulFile(scope, cwd);
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

/** Set a field by name: tag-aware for identity/soul/user (sets <TAG>…</TAG>);
 *  falls back to replacing/inserting a ## <section> for other files. */
export async function setSection(file, section, body) {
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
