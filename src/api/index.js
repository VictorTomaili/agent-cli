// src/api/index.js — minimal programmatic SDK.
// In-process access to the read-only core of agent-cli. Every function returns
// the SAME `data` payload shape the CLI emits for the equivalent command, but
// without process.exit and without touching the network. Intended as the base
// layer for MCP/watch/hooks/cron and for in-process tests.
//
// Scope: read-only. Mutating commands are intentionally NOT exposed.

import path from "node:path";
import { createRequire } from "node:module";
import { pretty, HOME, AGENTS_DIR, MASTER_FILE } from "../util.js";
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
import { isSkillAvailable } from "../skill.js";
import { identityInventory } from "../agents-lib.js";
import { listLessons, inboxLessons, coreFile } from "../lessons-lib.js";
import { inspectSpect } from "../spect.js";
import { listSnapshots, snapshot } from "../snapshot.js";
import { getAliases, getAlias } from "../models.js";

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

/** `agent-cli status` payload. */
export async function status({ all = false, cwd = process.cwd() } = {}) {
	const cfg = await loadConfig();
	const masterContent = await readMaster();
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
		targetCount: targets.length,
		all,
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

export function snapshotNow() {
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
