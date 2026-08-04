// src/config.js — ~/.agents/config.json load/save + helpers.
// Pointer-model schema: "enabled" targets are the ones that get a pointer stub.

import fs from "node:fs";
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

function isStringArray(v) {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function isPlainObject(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isAliasesObject(v) {
	return isPlainObject(v) && Object.values(v).every(isPlainObject);
}
function isProjectTargets(v) {
	return (
		isPlainObject(v) &&
		Object.values(v).every((val) => val === null || isStringArray(val))
	);
}

/**
 * Nested-field schema check. Wrong shapes (global not a string array, project
 * neither null nor a string array, non-array seedFiles, non-object
 * models.aliases, etc.) are classified as CORRUPT at the load boundary — we
 * never silently repair them or let them reach code that assumes arrays/objects.
 */
function validShape(p) {
	if (p.global !== undefined && !isStringArray(p.global)) return false;
	if (
		p.project !== undefined &&
		p.project !== null &&
		!isStringArray(p.project)
	)
		return false;
	if (p.seedFiles !== undefined && !isStringArray(p.seedFiles)) return false;
	if (
		p.models !== undefined &&
		p.models !== null &&
		!isPlainObject(p.models)
	)
		return false;
	if (
		p.models &&
		p.models.aliases !== undefined &&
		!isAliasesObject(p.models.aliases)
	)
		return false;
	if (p.projectTargets !== undefined && !isProjectTargets(p.projectTargets))
		return false;
	return true;
}

export function defaultConfig() {
	return {
		version: CONFIG_VERSION,
		global: [], // target ids with a pointer stub in ~ (home)
		project: null, // legacy fallback: null = all known project-capable targets; or array of ids
		projectTargets: {}, // per-project-root state: { rootAbs: null | string[] }
		seed: null, // home-relative path the master was seeded from
		skillManaged: true, // agent-cli manages the skill-cli block inside the master
		seedVersion: null, // agent-cli version whose seed defaults were last installed/staged
		seedFiles: [], // seed paths known at the last install/stage, for deletion reconciliation
		updateCheck: null, // cached npm latest-version check: { latestVersion, checkedAt }
		updatedAt: null,
	};
}

function corruptConfig() {
	const fallback = defaultConfig();
	Object.defineProperty(fallback, CONFIG_CORRUPT, { value: true });
	return fallback;
}

/** Parse + validate raw config bytes. Returns a corrupt-marked config on any problem. */
function parseConfig(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return corruptConfig();
	}
	if (!isPlainObject(parsed) || !validShape(parsed)) return corruptConfig();
	return { ...defaultConfig(), ...parsed };
}

export async function loadConfig() {
	const raw = await readIfExists(CONFIG_FILE);
	if (!raw) return defaultConfig();
	return parseConfig(raw);
}

/** Sync variant for modules that cannot await (models.js). */
export function loadConfigSync() {
	let raw;
	try {
		raw = fs.readFileSync(CONFIG_FILE, "utf8");
	} catch {
		return defaultConfig();
	}
	return parseConfig(raw);
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

/** Sync variant for modules that cannot await (models.js). */
export function saveConfigSync(cfg) {
	if (isConfigCorrupt(cfg))
		throw new Error(
			"config.json is corrupt; repair or remove it before changing settings",
		);
	cfg.version = CONFIG_VERSION;
	cfg.updatedAt = new Date().toISOString();
	fs.mkdirSync(AGENTS_DIR, { recursive: true });
	const tmp = `${CONFIG_FILE}.${process.pid}.${Date.now()}.${Math.random()
		.toString(16)
		.slice(2)}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
		try {
			fs.renameSync(tmp, CONFIG_FILE);
		} catch (error) {
			if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
			fs.rmSync(CONFIG_FILE, { force: true });
			fs.renameSync(tmp, CONFIG_FILE);
		}
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

export function isGlobalEnabled(cfg, id) {
	return cfg.global.includes(id);
}

/**
 * Resolve the project allowlist for ONE project root: null = "all
 * project-capable targets". Per-root entries in `projectTargets` win; otherwise
 * we fall back to the legacy global `project` field for backward compat.
 */
function projectTargetList(cfg, root) {
	if (
		cfg.projectTargets &&
		Object.prototype.hasOwnProperty.call(cfg.projectTargets, root)
	)
		return cfg.projectTargets[root]; // null or string[]
	return Array.isArray(cfg.project) ? cfg.project : null;
}

export function isProjectEnabled(cfg, id, root = process.cwd()) {
	const list = projectTargetList(cfg, root);
	if (list === null) return true; // null means "all known project-capable targets"
	return list.includes(id);
}

/** Effective list of project target ids for a root (null => all known). */
export function effectiveProjectIds(cfg, root = process.cwd()) {
	const list = projectTargetList(cfg, root);
	if (list === null) return targetsWithScope("project").map((t) => t.id);
	return list;
}

export function enableGlobal(cfg, id) {
	if (!cfg.global.includes(id)) cfg.global.push(id);
}

export function disableGlobal(cfg, id) {
	cfg.global = cfg.global.filter((x) => x !== id);
}

/**
 * Enable a project target in ONE project root. When the root's state is null
 * ("all project targets"), enabling is a no-op: we record the root as explicitly
 * "all" rather than collapsing it into a one-item allowlist (which would silently
 * disable every other project target — the Finding 9 regression).
 */
export function enableProjectTarget(cfg, root, id) {
	if (!isPlainObject(cfg.projectTargets)) cfg.projectTargets = {};
	const list = projectTargetList(cfg, root);
	if (list === null) {
		cfg.projectTargets[root] = null;
		return;
	}
	cfg.projectTargets[root] = list.includes(id) ? list : [...list, id];
}

/**
 * Disable a project target in ONE project root. From "all", materialize the
 * allowlist excluding the id (mirrors legacy disableProject). Other roots are
 * untouched.
 */
export function disableProjectTarget(cfg, root, id) {
	if (!isPlainObject(cfg.projectTargets)) cfg.projectTargets = {};
	const list = projectTargetList(cfg, root);
	if (list === null) {
		cfg.projectTargets[root] = targetsWithScope("project")
			.map((t) => t.id)
			.filter((x) => x !== id);
		return;
	}
	cfg.projectTargets[root] = list.filter((x) => x !== id);
}

// Legacy helpers operating on the global `project` field. Kept for
// backward-compat (and existing tests); new code should use the per-root
// enableProjectTarget/disableProjectTarget above.
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
