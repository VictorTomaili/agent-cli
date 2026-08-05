// src/config.js — ~/.agents/config.json load/save + helpers.
// Pointer-model schema: "enabled" targets are the ones that get a pointer stub.

import fs from "node:fs";
import {
	CONFIG_FILE,
	AGENTS_DIR,
	readIfExists,
	writeFile,
	writeFileSync,
	ensureDir,
} from "./util.js";
import { targetsWithScope } from "./targets.js";

export const CONFIG_VERSION = 2;
const CONFIG_CORRUPT = Symbol("configCorrupt");

/** M9: serialize a config object the way it lands on disk (pretty + newline). */
function serialize(cfg) {
	return JSON.stringify(cfg, null, 2) + "\n";
}

/**
 * M9: drop the `updatedAt` field from a serialized config so two writes that
 * differ only in the timestamp compare equal. Accepts a JSON string or object.
 */
function stripUpdatedAt(jsonOrObj) {
	if (typeof jsonOrObj === "string") {
		try {
			const parsed = JSON.parse(jsonOrObj);
			if (parsed && typeof parsed === "object") {
				const { updatedAt, ...rest } = parsed;
				return serialize(rest);
			}
		} catch {
			/* fall through to raw string */
		}
		return jsonOrObj;
	}
	const { updatedAt, ...rest } = jsonOrObj;
	return serialize(rest);
}

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
		sync: null, // git-backed brain sync: { remote, autoCommit, excluded, lastPull }
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

/**
 * P0-3: optimistic concurrency for config mutations.
 *
 * Reads the latest config, applies `mutator` to a fresh copy, and writes
 * atomically — retrying when a concurrent writer changed the file between the
 * read and the write (compare-and-swap on the serialized bytes). Mutations are
 * idempotent (enable adds-if-absent, disable removes-if-present), so re-running
 * the mutator on the freshest state converges: N concurrent `target enable`
 * calls all succeed with no lost update.
 *
 * Returns the final saved config. Throws if the config is corrupt or if the
 * retry budget is exhausted.
 */
/** Cross-process lock file for config mutations (P0-3). O_EXCL create is
 *  atomic on both POSIX and Windows; retry briefly if another writer holds it. */
function withConfigLock(fn, { timeoutMs = 2000 } = {}) {
	const lock = CONFIG_FILE + ".lock";
	fs.mkdirSync(AGENTS_DIR, { recursive: true });
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const fd = fs.openSync(lock, "wx");
			fs.closeSync(fd);
			break;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			if (Date.now() > deadline)
				throw new Error("config.json is locked by another writer");
			// brief backoff so concurrent writers don't spin hot
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	try {
		return fn();
	} finally {
		try {
			fs.unlinkSync(lock);
		} catch {
			/* best-effort */
		}
	}
}

export function mutateConfigSync(mutator, { retries = 8 } = {}) {
	return withConfigLock(() => {
		for (let attempt = 0; ; attempt++) {
		// Read the RAW bytes once — the CAS compares raw bytes, and the parse
		// (which injects defaults) is derived from the same snapshot.
		let raw;
		try {
			raw = fs.readFileSync(CONFIG_FILE, "utf8");
		} catch {
			raw = null; // file absent
		}
		const base = raw == null ? defaultConfig() : parseConfig(raw);
		if (isConfigCorrupt(base))
			throw new Error(
				"config.json is corrupt; repair or remove it before changing settings",
			);
		const next = { ...defaultConfig(), ...base };
		mutator(next);
		next.version = CONFIG_VERSION;

		// Compare-and-swap: only commit if the file still matches the raw bytes
		// we based the mutation on. A concurrent writer between read and rename
		// changes the bytes → retry with fresh state so idempotent mutations
		// converge (no lost update).
		let live;
		try {
			live = fs.readFileSync(CONFIG_FILE, "utf8");
		} catch {
			live = null;
		}
		if (live !== raw) {
			if (attempt >= retries)
				throw new Error("config.json write conflict; giving up after retries");
			continue;
		}

		// M9: byte-idempotency — a no-op mutation (e.g. `target enable` on an
		// already-enabled id, or re-running init) must not rewrite the file or
		// churn `updatedAt`, so repeated runs stay byte-identical and the synced
		// brain stays clean. Compare substantive fields only.
		if (raw != null && stripUpdatedAt(raw) === stripUpdatedAt(serialize(next))) {
			return next;
		}
		next.updatedAt = new Date().toISOString();
		writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n");
		return next;
		}
	});
}

export async function saveConfig(cfg) {
	if (isConfigCorrupt(cfg))
		throw new Error(
			"config.json is corrupt; repair or remove it before changing settings",
		);
	cfg.version = CONFIG_VERSION;
	// M9: skip the write when the substantive config is unchanged (compare
	// without updatedAt) so repeated saves are byte-idempotent.
	const live = await readIfExists(CONFIG_FILE);
	if (live != null && stripUpdatedAt(live) === stripUpdatedAt(cfg)) return;
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
	// M9: byte-idempotency (see saveConfig).
	let live = null;
	try {
		live = fs.readFileSync(CONFIG_FILE, "utf8");
	} catch {
		/* file absent */
	}
	if (live != null && stripUpdatedAt(live) === stripUpdatedAt(cfg)) return;
	cfg.updatedAt = new Date().toISOString();
	writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

export function isGlobalEnabled(cfg, id) {
	return cfg.global.includes(id);
}

// --- P0-3 atomic variants ------------------------------------------------
// The CLI mutates via loadConfig → enable* → saveConfig, which is a
// read-modify-write race under concurrency. These wrappers run the mutation
// inside withConfigLock so concurrent `target enable` calls cannot lose each
// other's updates.

export function atomicEnableGlobal(id) {
	return mutateConfigSync((cfg) => enableGlobal(cfg, id));
}

export function atomicDisableGlobal(id) {
	return mutateConfigSync((cfg) => disableGlobal(cfg, id));
}

export function atomicEnableProjectTarget(root, id) {
	return mutateConfigSync((cfg) => enableProjectTarget(cfg, root, id));
}

export function atomicDisableProjectTarget(root, id) {
	return mutateConfigSync((cfg) => disableProjectTarget(cfg, root, id));
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
