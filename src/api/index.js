// src/api/index.js — minimal programmatic SDK.
// In-process access to the read-only core of agent-cli. Every function returns
// the SAME `data` payload shape the CLI emits for the equivalent command, but
// without process.exit and without touching the network. Intended as the base
// layer for MCP/watch/hooks/cron and for in-process tests.
//
// Scope: read-only. Mutating commands are intentionally NOT exposed.

import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import {
	pretty,
	HOME,
	AGENTS_DIR,
	MASTER_FILE,
	exists,
	readFile,
} from "../util.js";
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
import {
	listAgents,
	identityInventory,
	computeOnboarding,
} from "../agents-lib.js";
import { listLessons, inboxLessons, coreFile } from "../lessons-lib.js";
import { inspectSpect } from "../spect.js";
import { listSnapshots, snapshot } from "../snapshot.js";
import { getAliases, getAlias } from "../models.js";

const PKG_VERSION = createRequire(import.meta.url)("../../package.json").version;

/** Project master path, mirroring cli.js masterPaths(). */
function masterPaths(scope = "global", cwd = process.cwd()) {
	if (scope === "project") {
		const abs = path.join(cwd, ".agents", "AGENTS.md");
		return { masterAbs: abs, masterTilde: pretty(abs) };
	}
	return { masterAbs: MASTER_FILE, masterTilde: pretty(MASTER_FILE) };
}

import { findUnresolvedModels } from "../agents-lib.js";

/** `agent status` payload. */
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
			pointer: visibleTargets.filter((t) => t.global?.state === "pointer")
				.length,
			missing: visibleTargets.filter((t) => t.global?.state === "missing")
				.length,
			stale: visibleTargets.filter(
				(t) => t.global?.state === "pointer-stale",
			).length,
			native: visibleTargets.filter((t) => t.global?.state === "native")
				.length,
		},
	};
}

/** `agent doctor` payload (issues + checks). */
export async function doctor({ cwd = process.cwd() } = {}) {
	const cfg = await loadConfig();
	const issues = [];
	const checks = [];
	const masterContent = await readMaster();
	const masterOk = masterContent != null;
	checks.push({
		check: "master-exists",
		ok: masterOk,
		detail: pretty(MASTER_FILE),
	});
	if (!masterOk) issues.push("Master missing — run `agent init`.");
	checks.push({
		check: "config-not-corrupt",
		ok: !isConfigCorrupt(cfg),
		detail: isConfigCorrupt(cfg) ? "config.json is corrupt" : "ok",
	});
	if (isConfigCorrupt(cfg))
		issues.push("config.json is corrupt — repair or remove it before changing settings");
	checks.push({
		check: "agent-cli-block",
		ok: hasAgentCliBlock(masterContent || ""),
		detail: "managed block in master",
	});
	if (masterOk && !hasAgentCliBlock(masterContent || ""))
		issues.push(
			"agent-cli block missing — run `agent skill refresh` or `agent init`.",
		);

	for (const id of cfg.global) {
		const t = TARGETS.find((x) => x.id === id);
		if (!t || !t.global) continue;
		const cls = await classify(t, "global");
		const ok = cls.state === "pointer";
		checks.push({
			check: "pointer:" + id,
			ok,
			detail: cls.state + " " + pretty(cls.path),
		});
		if (!ok && cls.state !== "missing")
			issues.push(`${id} pointer ${cls.state} — run \`agent link\`.`);
	}
	const skillOk = isSkillAvailable();
	checks.push({
		check: "skill-available",
		ok: skillOk,
		detail: skillOk ? "integrated" : "none",
	});
	if (!skillOk) issues.push("skill-cli unavailable — run `agent skill setup`.");

	// project skill.config health (parity with CLI doctor).
	const sgMod = await import("../skills-gate.js");
	const projSkillConfig = sgMod.readProjectConfig(cwd);
	const skillConfigOk = !projSkillConfig || projSkillConfig.ok !== false;
	checks.push({
		check: "skill-config",
		ok: skillConfigOk,
		detail:
			projSkillConfig && projSkillConfig.ok === false
				? "corrupt project skill.config"
				: "ok",
	});
	if (!skillConfigOk)
		issues.push("project skill.config is corrupt — repair or remove it");

	const inv = await identityInventory({ scope: "global", cwd });
	for (const f of inv.files) {
		if (f.exists && f.filled === false) {
			checks.push({
				check: "identity-filled:" + f.kind,
				ok: false,
				detail: "unfilled template",
			});
			issues.push(
				`${f.kind} is an unfilled template — edit it: agent edit ${f.kind}`,
			);
		}
	}
	const REQUIRED = new Set([
		"identity",
		"soul",
		"user",
		"lessons",
		"environments",
	]);
	const modelsMdPath = path.join(HOME, ".agents", "MODELS.md");
	const modelsMdExists = await exists(modelsMdPath);
	for (const f of inv.files) {
		if (!REQUIRED.has(f.kind)) continue;
		if (!f.exists) {
			checks.push({
				check: "file-exists:" + f.kind,
				ok: false,
				detail: "missing",
			});
			issues.push(
				`${f.kind} file missing (${pretty(f.path)}) — run \`agent init\` to seed it.`,
			);
		}
	}
	checks.push({
		check: "file-exists:models",
		ok: modelsMdExists,
		detail: modelsMdExists ? pretty(modelsMdPath) : "missing",
	});
	if (!modelsMdExists)
		issues.push(
			`MODELS.md missing (${pretty(modelsMdPath)}) — run \`agent init\` to seed it.`,
		);
	const subList = await listAgents({ includeProject: false });
	checks.push({
		check: "personalities-discoverable",
		ok: true,
		detail: `${subList.length} in ~/.agents/agents`,
	});
	const unresolvedModels = await findUnresolvedModels(cwd);
	checks.push({
		check: "models-resolved",
		ok: unresolvedModels.length === 0,
		detail: unresolvedModels.length
			? unresolvedModels.map((u) => `${u.name} (${u.model})`).join(", ")
			: "all model aliases resolve",
	});
	if (unresolvedModels.length)
		issues.push(
			`unresolved model aliases: ${unresolvedModels
				.map((u) => `${u.name} uses '${u.model}' — run ${u.guidance}`)
				.join("; ")}`,
		);
	// no personalities stranded in the old ~/.pi/agent/agents path
	const oldPiAgents = path.join(os.homedir(), ".pi", "agent", "agents");
	let orphans = 0;
	try {
		const fspD = await import("node:fs/promises");
		orphans = (await fspD.readdir(oldPiAgents)).filter((n) =>
			n.endsWith(".md"),
		).length;
	} catch {
		/* dir absent */
	}
	if (orphans > 0) {
		checks.push({
			check: "no-orphan-personalities",
			ok: false,
			detail: `${orphans} in old ~/.pi/agent/agents`,
		});
		issues.push(
			`${orphans} personalities stranded in old path ~/.pi/agent/agents — move them to ~/.agents/agents`,
		);
	} else {
		checks.push({
			check: "no-orphan-personalities",
			ok: true,
			detail: "old path clean",
		});
	}
	// npm latest version — cached only (read-only; no network)
	const npm = await import("../npm-check.js");
	const upd = npm.readCachedUpdate(cfg, PKG_VERSION);
	checks.push({
		check: "npm-update",
		ok: !upd.latest || upd.upToDate,
		detail: upd.latest
			? upd.upToDate
				? `latest ${upd.latest}`
				: `latest ${upd.latest} (installed ${PKG_VERSION})`
			: "unable to check",
	});
	if (upd.latest && !upd.upToDate)
		issues.push(`agent-cli ${upd.latest} is available (installed ${PKG_VERSION}).`);
	// staged update payloads awaiting migration
	const seed = await import("../seed.js");
	const staged = await seed.listStagedUpdates({ home: AGENTS_DIR });
	checks.push({
		check: "staged-updates",
		ok: staged.length === 0,
		detail: staged.length ? `${staged.length} payload(s)` : "none",
	});
	if (staged.length)
		issues.push(
			`${staged.length} staged update payload(s) under ~/.agents/update-* — review with the user and migrate (see: agent update list).`,
		);
	return { issues, checks };
}

/** `agent brief` payload (read-only; never hits the network). */
/** `agent brief` payload (read-only; never hits the network).
 *  Delegates to src/actions.js collectState/buildActions — the single source of
 *  truth for the session contract, so the SDK cannot drift from the CLI. */
export async function brief({ cwd = process.cwd() } = {}) {
	const actMod = await import("../actions.js");
	const s = await actMod.collectState({ cwd, offline: true });
	const actionsList = actMod.buildActions(s);
	const suggested = actMod.suggestedStrings(actionsList);
	const etag = actMod.computeEtag(s);
	const blockers = [];
	if (s.masterContent == null) blockers.push("master missing — run `agent init`");
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
