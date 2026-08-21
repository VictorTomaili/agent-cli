// src/skill.js — integrated skill manager adapter.
// The implementation lives in src/skills; no global binary, submodule, or
// runtime dependency installation is used.

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { HOME, exists, ensureDir, writeFile } from "./util.js";
import { VERSION as SKILL_VERSION } from "./skills/lib/version.js";
import { listStore } from "./skills/lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(__dirname, "skills");
export const SUBMODULE_ROOT = SKILL_ROOT;
export const SUBMODULE_CLI = path.join(SKILL_ROOT, "cli.js");
export const SUBMODULE_PKG = path.join(SKILL_ROOT, "package.json");

const SKILL_HOME = path.join(HOME, ".skill-cli");
const SKILL_STORE = path.join(SKILL_HOME, "store");
const SKILL_CONFIG = path.join(SKILL_HOME, "config.yaml");

export function submodulePresent() {
	return fs.existsSync(SUBMODULE_CLI);
}

export function submoduleHasDeps() {
	return submodulePresent();
}

export function readSubmodulePkg() {
	return { version: skillVersion().version };
}

export function submoduleVersion() {
	return skillVersion().version;
}

/** Integrated implementation is always the only executable skill backend. */
export function globalSkillBin() {
	return null;
}

export function isSkillAvailable() {
	return submodulePresent();
}

/** Compatibility no-op: dependencies are declared by the parent package. */
export function ensureSubmoduleDeps() {
	return submodulePresent()
		? { ok: true, reason: "integrated" }
		: { ok: false, reason: "missing-integrated-skill" };
}

function normalize(r) {
	return {
		code: r.status,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		ok: r.status === 0,
		error: r.error?.message ?? null,
	};
}

/** Run the integrated skill CLI with the agent home explicitly injected. */
export function runSkill(args, opts = {}) {
	if (!submodulePresent()) {
		return {
			code: 1,
			stdout: "",
			stderr: "integrated skill implementation missing",
			ok: false,
			error: "missing-integrated-skill",
		};
	}
	const env = {
		...process.env,
		SKILL_CLI_HOME: HOME,
	};
	return normalize(
		spawnSync(process.execPath, [SUBMODULE_CLI, ...args], {
			encoding: "utf8",
			cwd: opts.cwd || process.cwd(),
			env,
			stdio: opts.stdio || "pipe",
		}),
	);
}

/** Create ~/.skill-cli/{store,config.yaml} if missing. */
export async function ensureSkillStore() {
	const actions = [];
	if (!(await exists(SKILL_STORE))) {
		await ensureDir(SKILL_STORE);
		actions.push("created-store");
	}
	if (!(await exists(SKILL_CONFIG))) {
		const yaml = `version: 1\nstore: ${SKILL_STORE}\ndefaults: []\n`;
		await writeFile(SKILL_CONFIG, yaml);
		actions.push("created-config");
	}
	return { ok: true, actions, store: SKILL_STORE, config: SKILL_CONFIG };
}

/** Report the integrated skill implementation as part of this app.
 *  Version is read statically (no subprocess) — status/brief/doctor no longer
 *  pay a Node child process per call. */
export function skillVersion() {
	return { version: SKILL_VERSION ?? null, source: "integrated", bin: null };
}

/**
 * Store skills still carrying pre-spec top-level extension fields
 * (triggers/version). Brief surfaces this as an upgrade warning pointing at
 * `agent-cli skill migrate`. listStore honors AGENT_CLI_HOME like the rest of
 * the CLI; returns [] when the store is absent.
 */
export function legacySkillFields() {
	try {
		return listStore()
			.filter((s) => s.legacyFields?.length)
			.map((s) => ({ name: s.name, legacyFields: s.legacyFields }));
	} catch {
		return [];
	}
}

export const PATHS = {
	SKILL_HOME,
	SKILL_STORE,
	SKILL_CONFIG,
	SUBMODULE_ROOT,
	SUBMODULE_CLI,
};
