// src/config.js — ~/.agents/config.json load/save + helpers.
// Pointer-model schema: "enabled" targets are the ones that get a pointer stub.

import {
	CONFIG_FILE,
	AGENTS_DIR,
	readIfExists,
	writeFile,
	ensureDir,
} from "./util.js";
import { targetsWithScope } from "./targets.js";

export const CONFIG_VERSION = 2;
const CONFIG_CORRUPT = Symbol("configCorrupt");

export function defaultConfig() {
	return {
		version: CONFIG_VERSION,
		global: [], // target ids with a pointer stub in ~ (home)
		project: null, // null = all known project-capable targets; or array of ids
		seed: null, // home-relative path the master was seeded from
		skillManaged: true, // agent-cli manages the skill-cli block inside the master
		seedVersion: null, // agent-cli version whose seed defaults were last installed/staged
		seedFiles: [], // seed paths known at the last install/stage, for deletion reconciliation
		updateCheck: null, // cached npm latest-version check: { latestVersion, checkedAt }
		updatedAt: null,
	};
}

export async function loadConfig() {
	const raw = await readIfExists(CONFIG_FILE);
	if (!raw) return defaultConfig();
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("config root must be an object");
		return { ...defaultConfig(), ...parsed };
	} catch {
		const fallback = defaultConfig();
		Object.defineProperty(fallback, CONFIG_CORRUPT, { value: true });
		return fallback;
	}
}

export function isConfigCorrupt(cfg) {
	return cfg?.[CONFIG_CORRUPT] === true;
}

export async function saveConfig(cfg) {
	if (isConfigCorrupt(cfg))
		throw new Error(
			"config.json is corrupt; repair or remove it before changing settings",
		);
	cfg.version = CONFIG_VERSION;
	cfg.updatedAt = new Date().toISOString();
	await ensureDir(AGENTS_DIR);
	await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

export function isGlobalEnabled(cfg, id) {
	return cfg.global.includes(id);
}

export function isProjectEnabled(cfg, id) {
	if (Array.isArray(cfg.project)) return cfg.project.includes(id);
	return true; // null means "all known project-capable targets"
}

/** Effective list of project target ids given config (null => all known). */
export function effectiveProjectIds(cfg) {
	if (Array.isArray(cfg.project)) return cfg.project;
	return targetsWithScope("project").map((t) => t.id);
}

export function enableGlobal(cfg, id) {
	if (!cfg.global.includes(id)) cfg.global.push(id);
}

export function disableGlobal(cfg, id) {
	cfg.global = cfg.global.filter((x) => x !== id);
}

export function enableProject(cfg, id) {
	const list = Array.isArray(cfg.project) ? cfg.project : [];
	if (!list.includes(id)) list.push(id);
	cfg.project = list;
}

export function disableProject(cfg, id) {
	if (!Array.isArray(cfg.project)) {
		cfg.project = targetsWithScope("project")
			.map((t) => t.id)
			.filter((x) => x !== id);
		return;
	}
	cfg.project = cfg.project.filter((x) => x !== id);
}
