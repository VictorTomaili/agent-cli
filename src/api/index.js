// src/api/index.js — minimal programmatic SDK.
// In-process access to the read-only core of agent-cli. Every function returns
// the SAME `data` payload shape the CLI emits for the equivalent command, but
// without process.exit and without touching the network. Intended as the base
// layer for MCP/watch/hooks/cron and for in-process tests.
//
// Scope: read-only. Mutating commands are intentionally NOT exposed.

import path from "node:path";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import { pretty, HOME, AGENTS_DIR, MASTER_FILE, readFile } from "../util.js";
import {
	loadConfig,
	isGlobalEnabled,
	isProjectEnabled,
	isConfigCorrupt,
} from "../config.js";
import { readMaster } from "../store.js";
import { hasAgentCliBlock } from "../blocks.js";
import { TARGETS, pathFor } from "../targets.js";
import { detectInstalled } from "../detect.js";
import { classify } from "../pointer.js";
import {
	isSkillAvailable,
	listInstalledSkills,
	getInstalledSkill,
} from "../skill.js";
import { identityInventory, parseFrontmatter } from "../agents-lib.js";
import { listLessons } from "../lessons-lib.js";
import { readCoreLessons } from "../lessons-lib.js";
import { inspectSpect } from "../spect.js";
import { listSnapshots, snapshot } from "../snapshot.js";
import { getAliases, getAlias } from "../models.js";
import { currentSession } from "../session.js";

const PKG_VERSION = createRequire(import.meta.url)(
	"../../package.json",
).version;

/** Project master path, mirroring cli.js masterPaths(). */
function masterPaths(scope = "global", cwd = process.cwd()) {
	if (scope === "project") {
		const abs = path.join(cwd, ".agents", "AGENTS.md");
		return { masterAbs: abs, masterTilde: pretty(abs) };
	}
	return { masterAbs: MASTER_FILE, masterTilde: pretty(MASTER_FILE) };
}

/**
 * Collect the targets[] payload (same shape `status()` surfaces) and apply the
 * visibility filter. Single source of truth so the new `targets()` SDK
 * producer and `status()` cannot drift. Pure read: loads config, calls
 * detectInstalled() + classify() — no writes, no fs mutations.
 */
async function collectTargetsPayload({ all = true } = {}) {
	const cfg = await loadConfig();
	const targets = [];
	for (const t of TARGETS) {
		const installed = (await detectInstalled()).includes(t.id);
		const gEnabled = isGlobalEnabled(cfg, t.id);
		const gcls = t.global ? await classify(t, "global") : null;
		targets.push({
			id: t.id,
			name: t.name,
			installed,
			globalEnabled: gEnabled,
			projectEnabled: isProjectEnabled(cfg, t.id),
			global: gcls ? { path: gcls.path, state: gcls.state } : null,
			project: t.project ? pathFor(t, "project") : null,
		});
	}
	const visibleTargets = all
		? targets
		: targets.filter(
				(t) =>
					t.installed ||
					t.globalEnabled ||
					t.projectEnabled ||
					(t.global && t.global.state !== "pointer"),
			);
	return { targets: visibleTargets, targetCount: targets.length, all };
}

/** `agent-cli status` payload. */
export async function status({ all = false } = {}) {
	const cfg = await loadConfig();
	const masterContent = await readMaster();
	const targetsPayload = await collectTargetsPayload({ all });
	const visibleTargets = targetsPayload.targets;
	return {
		master: {
			path: MASTER_FILE,
			exists: masterContent != null,
			hasAgentCliBlock: hasAgentCliBlock(masterContent || ""),
			size: masterContent ? masterContent.length : 0,
		},
		config: {
			global: cfg.global,
			project: cfg.project,
			version: cfg.version,
			corrupt: isConfigCorrupt(cfg) ? true : false,
		},
		skill: {
			available: isSkillAvailable(),
			backend: "integrated",
		},
		targets: visibleTargets,
		targetCount: targetsPayload.targetCount,
		all: targetsPayload.all,
		targetsSummary: {
			pointer: visibleTargets.filter((t) => t.global?.state === "pointer").length,
			missing: visibleTargets.filter((t) => t.global?.state === "missing").length,
			stale: visibleTargets.filter((t) => t.global?.state === "pointer-stale")
				.length,
			native: visibleTargets.filter((t) => t.global?.state === "native").length,
		},
	};
}

/** `agent-cli doctor` payload (issues + checks). Delegates to
 *  src/doctor-report.js#buildDoctorReport — the same pure builder the CLI
 *  uses — so the SDK cannot drift from the CLI's checks. Read-only: the npm
 *  update check is always the cached read, never a live fetch. */
export async function doctor({ cwd = process.cwd() } = {}) {
	const cfg = await loadConfig();
	const masterContent = await readMaster();
	const npm = await import("../npm-check.js");
	const upd = npm.readCachedUpdate(cfg, PKG_VERSION);
	const { buildDoctorReport } = await import("../doctor-report.js");
	const installed = await detectInstalled();
	return buildDoctorReport(cfg, {
		masterContent,
		upd,
		version: PKG_VERSION,
		cwd,
		installed,
	});
}

/** `agent-cli brief` payload (read-only; never hits the network). */
/** `agent-cli brief` payload (read-only; never hits the network).
 *  Delegates to src/actions.js collectState/buildActions — the single source of
 *  truth for the session contract, so the SDK cannot drift from the CLI. */
export async function brief({ cwd = process.cwd() } = {}) {
	const actMod = await import("../actions.js");
	const s = await actMod.collectState({ cwd, offline: true });
	const actionsList = actMod.buildActions(s);
	const suggested = actMod.suggestedStrings(actionsList);
	const etag = actMod.computeEtag(s);
	const blockers = [];
	if (s.masterContent == null)
		blockers.push("master missing — run `agent-cli init`");
	const warnings = [];
	if (s.archetypeNeeded) warnings.push("identity onboarding incomplete");
	if (s.unresolvedModels.length)
		warnings.push(`${s.unresolvedModels.length} unresolved model alias(es)`);
	if (s.consG.recommend || s.consP.recommend)
		warnings.push("lesson consolidation recommended");
	const sessionMod = await import("../session.js");
	const session = sessionMod.currentSession();
	return {
		tool: "agent-cli",
		version: PKG_VERSION,
		schemaVersion: "1.1.0",
		health:
			s.masterContent == null ||
			s.drift.length > 0 ||
			s.archetypeNeeded ||
			s.unresolvedModels.length > 0
				? "degraded"
				: "ready",
		warnings,
		blockers,
		etag,
		actions: actionsList,
		suggestedActions: suggested,
		master: {
			path: pretty(MASTER_FILE),
			absolute: MASTER_FILE,
			exists: s.masterContent != null,
			hasAgentCliBlock: hasAgentCliBlock(s.masterContent || ""),
		},
		enabledGlobal: s.cfg.global,
		installed: s.installed,
		pointerTargets: s.pointerTargets,
		drift: s.drift,
		skill: {
			available: isSkillAvailable(),
		},
		consolidation: {
			global: {
				score: s.consG.score,
				recommend: s.consG.recommend,
				reasons: s.consG.reasons,
				metrics: s.consG.metrics,
			},
			project: {
				score: s.consP.score,
				recommend: s.consP.recommend,
				reasons: s.consP.reasons,
				metrics: s.consP.metrics,
			},
		},
		update: {
			installedVersion: PKG_VERSION,
			latest: s.upd.latest,
			upToDate: s.upd.upToDate,
			checkedAt: s.upd.checkedAt,
			stagedUpdates: s.stagedUpdates,
		},
		onboarding: s.onboarding,
		sessionStart: { load: s.sessionLoad },
		lessons: {
			count: s.lessonsIndex.length,
			index: s.lessonsIndex,
			inbox: s.inboxCount,
			core: s.coreContent,
			coreScope: s.coreScope,
		},
		modelAliases: { unresolved: s.unresolvedModels },
		project: {
			spect: s.spect,
			...(s.spectHeadline ? { spectHeadline: s.spectHeadline } : {}),
		},
		...(session ? { session } : {}),
	};
}

// --- thin read-only wrappers (same payloads as the CLI commands) ---

export async function files(scope = "global", cwd = process.cwd()) {
	return identityInventory({ scope, cwd });
}

export async function lessonsList({ includeProject = true, cwd } = {}) {
	return listLessons({ includeProject, cwd });
}

export async function inboxList({ includeProject = true, cwd } = {}) {
	return inboxLessons({ includeProject, cwd });
}

export async function spectStatus(cwd = process.cwd()) {
	return inspectSpect(cwd);
}

export function snapshotsList() {
	return listSnapshots();
}

export async function snapshotNow() {
	return snapshot();
}

export function modelsList() {
	return getAliases();
}

export function modelsResolve(alias) {
	return getAlias(alias);
}

export function skillStatus() {
	return {
		available: isSkillAvailable(),
		backend: "integrated",
	};
}

// Mirror of the CLI `search` command payload (same data shape).
export async function search(
	query,
	{ kind = "all", project = false, limit = 10, cwd = process.cwd() } = {},
) {
	const mod = await import("../search.js");
	return mod.searchAll(query, { kind, project, limit, cwd });
}

/** Resolve project vs global master paths (same as cli.js masterPaths). */
export { masterPaths };

export { HOME, AGENTS_DIR, MASTER_FILE };

// --- T6.1.1 read SDK producers (Phase 6.1) -----------------------------------
// Consumers: src/serve.js resources/list + resources/read handlers (T6.1.2).
// Read-only — no fs writes. Import-boundary: this file is a consumer of lib,
// not the reverse (only serve.js may import api/**).

/**
 * Closed kind set for the brain file SDK producer (per MASTER-PLAN §10.2 /
 * meeting A2). UPPER-CASE on purpose: the canonical `brain://files/SOUL.md`
 * URIs use the same case as the on-disk filenames, and `AGENTS.md` is
 * deliberately excluded (NG6 — AGENTS.md is the master, never a brain_write
 * target, and never a brain_file read target either).
 */
export const BRAIN_FILE_KINDS = Object.freeze([
	"SOUL",
	"IDENTITY",
	"USER",
	"LESSONS",
	"ENVIRONMENTS",
	"MODELS",
]);

/** Resolve the on-disk path for a brain-file kind under the chosen scope. */
function brainFilePath(kind, scope, cwd) {
	const base =
		scope === "project" ? path.join(cwd, ".agents") : path.join(HOME, ".agents");
	return path.join(base, `${kind}.md`);
}

/**
 * Read one of the six Phase 6 brain files and return the metadata-shaped
 * payload contract (A3). Returns `{ exists: false, ... }` when the file is
 * missing, and `{ exists: false, symlink: true, ... }` when the path is a
 * symlink or junction (A8 — closes the secrets-leak vector where a symlinked
 * `SOUL.md` would otherwise be followed into `~/.agents/secrets/*`). On
 * `exists: false` or `symlink: true` the `content` field is OMITTED so the
 * symlinked target cannot leak through any consumer of this payload.
 *
 * Scope: accepts both `global` (default) and `project`. The serve.js wire-up
 * restricts the v0.8.0 resource URIs to global per the open follow-up in the
 * Phase 6 spec (project-scoped reads are not exposed in v0.8.0), but this
 * SDK function itself honours both scopes.
 *
 * Invalid `kind` throws a structured error
 * `{ code: "INVALID_KIND", kind, allowed: [...BRAIN_FILE_KINDS] }` — never
 * returns a payload for an unknown kind.
 */
export async function brainFile(kind, { scope = "global", cwd = process.cwd() } = {}) {
	if (!BRAIN_FILE_KINDS.includes(kind)) {
		const err = new Error(`invalid brain kind: ${kind}`);
		err.code = "INVALID_KIND";
		err.kind = kind;
		err.allowed = [...BRAIN_FILE_KINDS];
		throw err;
	}
	const filePath = brainFilePath(kind, scope, cwd);
	const uri = `brain://files/${kind}.md`;
	const basePayload = {
		uri,
		kind,
		scope,
		exists: false,
		symlink: false,
		schemaVersion: null,
		lastModified: null,
		size: null,
	};

	// lstat FIRST — do not stat (stat would follow the link).
	let st;
	try {
		st = await fsp.lstat(filePath);
	} catch (e) {
		if (e?.code === "ENOENT") return basePayload; // missing — content omitted
		throw e;
	}

	// A8: symlink/junction refusal — refuse BEFORE reading the target.
	if (st.isSymbolicLink()) {
		return { ...basePayload, exists: false, symlink: true };
	}

	// Non-regular (socket, fifo, device) — also refuse, no usable content.
	if (!st.isFile()) return basePayload;

	const content = await readFile(filePath);
	const { frontmatter } = parseFrontmatter(content);

	// T6.1.6 (meeting D6): bound the wire payload so a grown SOUL.md / LESSONS.md
	// cannot OOM the host. `size` keeps reporting the on-disk file size
	// (it's metadata, not the truncated payload size); `originalSize` is the
	// pre-truncation content length so the host can detect truncation and
	// re-fetch the full file via the CLI if it needs to. UTF-16 `length` is
	// char-count, which is byte-identical for the ASCII-only content of the
	// brain files we ship — non-ASCII content would make `length` <= bytes,
	// still a safe upper bound.
	const CONTENT_CAP = 64 * 1024; // 65536 chars
	const truncated = content.length > CONTENT_CAP;
	const contentForPayload = truncated ? content.slice(0, CONTENT_CAP) : content;
	return {
		...basePayload,
		exists: true,
		symlink: false,
		schemaVersion: frontmatter.schemaVersion ?? "0",
		lastModified: st.mtime.toISOString(),
		size: st.size,
		content: contentForPayload,
		...(truncated ? { truncated: true, originalSize: content.length } : {}),
	};
}

/**
 * Same `targets[]` payload shape `status()` produces — extracted from
 * status() so both surfaces stay in lock-step. Read-only; uses the existing
 * config / detectInstalled / classify primitives.
 */
export async function targets({ all = true } = {}) {
	return collectTargetsPayload({ all });
}

/**
 * Always-on core lessons — the `## Core` section of `LESSONS.md`. Project
 * scope preferred; falls back to global. Pure read; never throws on missing
 * files. Source-of-truth: `readCoreLessons` in `src/lessons-lib.js`
 * (extracted as part of T6.1.1; `actions.js#collectState` was refactored to
 * use the same helper so the SDK and the brief cannot drift).
 */
export async function lessonsCore({ cwd = process.cwd() } = {}) {
	return readCoreLessons({ cwd });
}

/**
 * Current active session — `src/session.js#currentSession()`. Returns the
 * session object (with `startedAt`, `cwd`, `repo`, `branch`, `task`,
 * `lessonsCaptured`) or `null` when no session is active. Synchronous,
 * matching the source function.
 */
export function sessionCurrent() {
	return currentSession();
}

/**
 * Installed-skill list (integrated backend) — `{ name, version, source,
 * scope }` per skill. Backed by `listInstalledSkills` in `src/skill.js`,
 * which in turn calls `listStore()` from the skills subsystem (single
 * sanctioned bridge is `src/skill.js`, per `test/import-boundaries.test.js`).
 */
export function skillsList() {
	return { skills: listInstalledSkills() };
}

/**
 * One installed skill by name — `{ name, version, source, scope, manifest,
 * body, path }` on success; `{ ok: false, reason: "..." }` on any failure
 * (invalid name = path-traversal attempt; missing skill = not installed).
 * The `manifest` is the parsed SKILL.md frontmatter (untrusted — same shape
 * `agent-cli skill show` surfaces).
 */
export function skillManifest(name) {
	return getInstalledSkill(name);
}

// --- T6.3.1 prompt SDK helpers (Phase 6.3) ------------------------------
//
// Each helper delegates to the same path the corresponding CLI command
// uses, so the SDK and the CLI cannot drift. The MCP prompts/list +
// prompts/get wire-up lands in T6.3.2 (dev-3).

/**
 * Dynamic system-prompt recommendation — equivalent of
 * `agent-cli prompt [--for "<task>"]`. Returns the Markdown body string.
 * Delegates to `src/prompt-report.js#buildPromptPayload` (the same builder
 * the CLI command uses), fed from the shared `collectState` snapshot so the
 * SDK cannot drift from the CLI.
 *
 * When `{ for: task }` is supplied, the matching top-5 search hits are
 * included as `forTaskHits`, biasing the prompt toward relevant
 * tools/commands and lesson/master excerpts.
 */
export async function sessionStartPrompt({ for: task } = {}) {
	const actMod = await import("../actions.js");
	const state = await actMod.collectState({
		cwd: process.cwd(),
		offline: true,
		pkgName: "@victortomaili/agent-cli",
	});
	let forTaskHits = null;
	if (task) {
		const searchMod = await import("../search.js");
		const sr = await searchMod.searchAll(task, { project: true });
		forTaskHits = sr.results.slice(0, 5).map((r) => ({
			path: r.path,
			title: r.title || null,
			snippet: r.snippet || null,
			score: r.score,
		}));
	}
	const promptMod = await import("../prompt-report.js");
	const payload = promptMod.buildPromptPayload(state, {
		version: PKG_VERSION,
		forTask: task || null,
		forTaskHits,
	});
	return payload.content;
}

/**
 * Canonical LLM-facing guide — equivalent of `agent-cli instructions`.
 * Returns the static `INSTRUCTIONS_MARKDOWN` string from `src/instructions.js`
 * — the same constant the CLI command prints, so the SDK cannot drift from
 * the CLI.
 */
export async function instructionsPrompt() {
	const instrMod = await import("../instructions.js");
	return instrMod.INSTRUCTIONS_MARKDOWN;
}

/**
 * Planning-mode brief — equivalent of `agent-cli --json brief --plan
 * [--for "<task>"]`. Returns the FULL `buildBriefPayload` envelope
 * (`tool`, `version`, `schemaVersion`, `health`, `warnings`, `blockers`,
 * `etag`, `actions`, `forTask`, `master`, `enabledGlobal`, `installed`,
 * `pointerTargets`, `drift`, `skill`, `suggestedActions`, `consolidation`,
 * `update`, `onboarding`, `sessionStart`, `session`, `lessons`,
 * `modelAliases`, `project`) — the exact shape `agent-cli brief` emits, so
 * the MCP `prompts/get` wire cannot drift from the CLI. Delegates to the
 * same `collectState` + `searchAll` + `buildBriefPayload` pipeline the CLI
 * `brief --plan --for` command (`src/commands/session-core.js`) uses.
 */
export async function briefPlanPrompt({ for: task } = {}) {
	const actMod = await import("../actions.js");
	const state = await actMod.collectState({
		cwd: process.cwd(),
		offline: true,
		pkgName: "@victortomaili/agent-cli",
	});
	// `--for`: task-aware retrieval, identical to the CLI brief command (which
	// builds `forTask = { query, hits }` with up to 5 hits). Omitted when null.
	let forTask = null;
	if (task) {
		const searchMod = await import("../search.js");
		const sr = await searchMod.searchAll(task, { project: true });
		forTask = { query: task, hits: sr.results.slice(0, 5) };
	}
	const { buildBriefPayload } = await import("../brief-report.js");
	return buildBriefPayload(state, { forTask, version: PKG_VERSION });
}

// --- Phase 6.2 write SDK (T6.2.1) ---------------------------------------------
//
// Per MASTER-PLAN §1 decision 1 the SDK split is explicit: the read-side
// half above stays documented as "read-only", and the write-side lives in
// its own file. Re-exporting here means a single `import * as sdk from
// "./api/index.js"` in src/serve.js still sees both halves — no consumer
// change required.
//
// The 8 functions (brainWrite, lessonCapture, targetEnable, targetDisable,
// link, unlink, memoryUpgradePrepare, memoryUpgradeApply) map 1:1 to the 8
// tool names in src/serve/registry.js's WRITE_TOOLS set; T6.2.5 wires
// serve.js handlers through these exports.
export * from "./write.js";
