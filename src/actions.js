// src/actions.js — the executable session contract.
// Extracts the brief's state computation so `brief`, `agent run`, and
// `agent action verify` share one source of truth. Actions are structured
// { id, command, args, reason, severity, idempotent, safeToAutomate,
//   precondition, verification, rollback } — machine-executable, unlike the
// legacy free-form suggestedActions strings.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
	pretty,
	AGENTS_DIR,
	MASTER_FILE,
	exists,
	readFile,
} from "./util.js";
import { loadConfig } from "./config.js";
import { readMaster } from "./store.js";
import { hasAgentCliBlock } from "./blocks.js";
import { getTarget } from "./targets.js";
import { detectInstalled } from "./detect.js";
import { classify } from "./pointer.js";
import { isSkillAvailable } from "./skill.js";
import {
	identityInventory,
	computeOnboarding,
	findUnresolvedModels,
} from "./agents-lib.js";

const SELF = fileURLToPath(import.meta.url);
const CLI_DIR = path.resolve(path.dirname(SELF), "cli.js");
const PKG_VERSION = createRequire(import.meta.url)("../package.json").version;

export const ACTION_SEVERITY = { critical: 3, high: 2, medium: 1, low: 0 };

/** Collect the full session state the brief reports (shared with agent run / api). */
export async function collectState(opts = {}) {
	const cwd = opts.cwd || process.cwd();
	const cfg = await loadConfig();
	const masterContent = await readMaster();
	const installed = await detectInstalled();
	const conMod = await import("./consolidate.js");
	const consG = conMod.assess({ scope: "global", cwd });
	const consP = conMod.assess({ scope: "project", cwd });
	const npm = await import("./npm-check.js");
	const offline =
		opts.offline ||
		opts.network === false ||
		process.env.AGENT_OFFLINE === "1";
	let upd;
	if (opts.refresh && !offline) {
		upd = await npm.ensureUpdateCheck(cfg, "agent-cli", PKG_VERSION, {
			force: true,
			offline,
		});
	} else {
		upd = npm.readCachedUpdate(cfg, PKG_VERSION);
	}
	const seed = await import("./seed.js");
	const stagedUpdates = await seed.listStagedUpdates({ home: AGENTS_DIR });
	const idMod = await import("./identity.js");
	const invG = await identityInventory({ scope: "global", cwd });
	const projectBase = path.join(cwd, ".agents");
	const invP = projectBase !== AGENTS_DIR ? await identityInventory({ scope: "project", cwd }) : null;
	const modelsMod = await import("./models.js");
	const modelsMdPath = modelsMod.MODELS_MD;
	const modelsMdExists = await exists(modelsMdPath);
	const spectMod = await import("./spect.js");
	const spect = await spectMod.inspectSpect(cwd);
	const spectHeadline =
		spect.initialized || spect.partial ? await spectMod.spectHeadline(cwd) : null;
	const { gapReport, archetypeNeeded, gapRecommended } = computeOnboarding(invG);
	const onboarding = {
		recommended: gapRecommended,
		archetypeNeeded,
		gaps: gapReport,
		...(archetypeNeeded ? idMod.onboardSuggest() : {}),
	};
	// load manifest
	const sessionLoad = [];
	for (const gF of invG.files) {
		sessionLoad.push({ kind: gF.kind, scope: "global", path: gF.path, exists: gF.exists, filled: gF.filled, gaps: gF.gaps, globalOnly: !!gF.globalOnly });
		// Project-scope override is ONLY for kinds that allow it. Kinds flagged
		// `globalOnly` (identity / user / models) have a single canonical home —
		// they don't vary per project — so we never load a project version.
		if (invP && !gF.globalOnly) {
			const pF = invP.files.find((x) => x.kind === gF.kind);
			if (pF) sessionLoad.push({ kind: pF.kind, scope: "project", path: pF.path, exists: pF.exists, filled: pF.filled, gaps: pF.gaps, globalOnly: false });
		}
	}
	if (spect.initialized || spect.partial)
		for (const file of new Set([...(spect.load || []), ...(spect.missingFiles || [])]))
			sessionLoad.push({
				kind: "spect",
				scope: "project",
				path: file,
				exists: !(spect.missingFiles || []).includes(file),
				filled: !(spect.missingFiles || []).includes(file),
				gaps: (spect.missingFiles || []).includes(file) ? ["missing"] : null,
			});
	const { listLessons, coreFile } = await import("./lessons-lib.js");
	const lessonsIndex = (await listLessons({ includeProject: true, cwd }))
		.map((l) => ({ path: l.path, scope: l.scope, occurrences: l.occurrences, marked: l.marked }))
		.sort((a, b) => a.path.localeCompare(b.path));
	const inboxCount = (consG.metrics.inbox || 0) + (consP.metrics.inbox || 0);
	let coreContent = null;
	let coreScope = null;
	for (const scope of ["project", "global"]) {
		try {
			const md = await readFile(coreFile(scope, cwd));
			const idx = md.indexOf("## Core");
			if (idx >= 0) {
				const cleaned = md.slice(idx + "## Core".length).replace(/<!--[\s\S]*?-->/g, "").trim();
				if (cleaned) {
					coreContent = cleaned;
					coreScope = scope;
					break;
				}
			}
		} catch {
			/* no core */
		}
	}
	const unresolvedModels = await findUnresolvedModels(cwd);
	const pointerTargets = [];
	const drift = [];
	for (const id of cfg.global) {
		const t = getTarget(id);
		if (!t || !t.global) continue;
		const cls = await classify(t, "global");
		pointerTargets.push({ id, scope: "global", state: cls.state, path: cls.path });
		if (cls.state !== "pointer") drift.push(id);
	}
	return {
		cwd,
		cfg,
		masterContent,
		installed,
		consG,
		consP,
		upd,
		stagedUpdates,
		invG,
		invP,
		modelsMdPath,
		modelsMdExists,
		liveCatalogAge: modelsMod.liveCatalogAgeDays(),
		spect,
		spectHeadline,
		gapReport,
		gapRecommended,
		archetypeNeeded,
		onboarding,
		sessionLoad,
		lessonsIndex,
		inboxCount,
		coreContent,
		coreScope,
		unresolvedModels,
		pointerTargets,
		drift,
	};
}

/** Build the structured action list from collected state. */
export function buildActions(s) {
	const actions = [];
	const add = (a) => actions.push({ id: a.id, ...a });
	if (s.masterContent == null)
		add({
			id: "init",
			command: "agent",
			args: ["init"],
			reason: "no master at ~/AGENTS.md",
			severity: "critical",
			idempotent: true,
			safeToAutomate: false,
			precondition: "no existing master",
			verification: null,
			rollback: "remove created files",
		});
	if (s.archetypeNeeded)
		add({
			id: "onboard",
			command: "agent",
			args: ["onboard", "suggest"],
			reason: "identity onboarding incomplete",
			severity: "high",
			idempotent: true,
			safeToAutomate: false,
			precondition: "identity gaps present",
			verification: null,
			rollback: null,
		});
	for (const t of s.pointerTargets) {
		if (t.state === "native")
			add({
				id: `pull:${t.id}`,
				command: "agent",
				args: ["pull", t.id],
				reason: `${t.id} holds native content to adopt`,
				severity: "medium",
				idempotent: true,
				safeToAutomate: false,
				precondition: `${t.id} native file exists`,
				verification: null,
				rollback: `agent link --target ${t.id} --force`,
			});
		if (t.state !== "pointer")
			add({
				id: `link:${t.id}`,
				command: "agent",
				args: ["link", "--target", t.id],
				reason: `${t.id} pointer ${t.state}`,
				severity: "high",
				idempotent: true,
				safeToAutomate: true,
				precondition: `${t.id} enabled in config`,
				verification: { command: "agent", args: ["status", "--json"] },
				rollback: `agent unlink --target ${t.id}`,
			});
	}
	if (!isSkillAvailable())
		add({
			id: "skill:setup",
			command: "agent",
			args: ["skill", "setup"],
			reason: "skill-cli store unavailable",
			severity: "medium",
			idempotent: true,
			safeToAutomate: true,
			precondition: null,
			verification: null,
			rollback: null,
		});
	if (s.consG.recommend)
		add({
			id: "consolidate",
			command: "agent",
			args: ["consolidate"],
			reason: "global lessons consolidation recommended",
			severity: "low",
			idempotent: false,
			safeToAutomate: false,
			precondition: "consolidation score above threshold",
			verification: null,
			rollback: "restore from backups",
		});
	if (s.consP.recommend)
		add({
			id: "consolidate:project",
			command: "agent",
			args: ["consolidate", "-p"],
			reason: "project lessons consolidation recommended",
			severity: "low",
			idempotent: false,
			safeToAutomate: false,
			precondition: "project consolidation score above threshold",
			verification: null,
			rollback: "restore from backups",
		});
	if (s.upd.latest && !s.upd.upToDate)
		add({
			id: "update:agent-cli",
			command: "npm",
			args: ["i", "-g", "agent-cli@latest"],
			reason: `agent-cli ${s.upd.latest} available`,
			severity: "low",
			idempotent: true,
			safeToAutomate: false,
			precondition: null,
			verification: null,
			rollback: "install previous version",
		});
	if (s.stagedUpdates.length)
		add({
			id: "update:list",
			command: "agent",
			args: ["update", "list"],
			reason: `${s.stagedUpdates.length} staged update payload(s)`,
			severity: "medium",
			idempotent: true,
			safeToAutomate: false,
			precondition: null,
			verification: null,
			rollback: null,
		});
	if (s.inboxCount >= 10)
		add({
			id: "lessons:triage",
			command: "agent",
			args: ["lessons", "inbox"],
			reason: `${s.inboxCount} raw captures to triage`,
			severity: "low",
			idempotent: true,
			safeToAutomate: false,
			precondition: null,
			verification: null,
			rollback: null,
		});
	for (const u of s.unresolvedModels)
		add({
			id: `models:set:${u.name}`,
			command: "agent",
			args: ["models", "set", u.name, "<provider/model>"],
			reason: `personality '${u.name}' uses unresolved alias '${u.model}'`,
			severity: "medium",
			idempotent: true,
			safeToAutomate: false,
			precondition: "choose a provider/model",
			verification: null,
			rollback: null,
		});
	if (s.liveCatalogAge != null && s.liveCatalogAge >= 30)
		add({
			id: "models:research:fetch",
			command: "agent",
			args: ["models", "research", "--fetch"],
			reason: `live model catalog is ${s.liveCatalogAge} day(s) old — refresh to keep model picks current`,
			severity: "low",
			idempotent: true,
			safeToAutomate: true,
			precondition: "network available",
			verification: null,
			rollback: null,
		});
	// deterministic order: severity desc, then id
	return actions.sort(
		(a, b) =>
			ACTION_SEVERITY[b.severity] - ACTION_SEVERITY[a.severity] ||
			a.id.localeCompare(b.id),
	);
}
/** Map (kind, field) gap tuples to actionable 'Run: agent <cmd>' lines so the
 * brief's human output tells the user exactly which command fills the gap. */
export function gapFixHints(gapReport) {
	const out = [];
	for (const [kind, fields] of Object.entries(gapReport || {})) {
		for (const f of fields) {
			if (kind === "identity") {
				out.push(`agent identity set ${f.replace(/^AGENT_/, "").toLowerCase()} "<value>"`);
			} else if (kind === "user") {
				out.push(`agent user set ${f.replace(/^USER_/, "").toLowerCase()} "<value>"`);
			} else if (kind === "environments") {
				out.push(`agent env set ${f.replace(/^ENV_LOCAL_/, "").toLowerCase()} "<value>"  (or: agent env capture to auto-detect)`);
			} else if (kind === "lessons") {
				out.push(`agent lessons add <topic/descriptive-name> --body "..."  (or just run agents — they capture lessons automatically)`);
			} else {
				out.push(`fill ${kind}.${f} in the relevant markdown file`);
			}
		}
	}
	return out;
}

/** Compat: legacy free-form suggestedActions strings derived from actions.
 * Always shows the runnable command so a blind user can copy-paste or run
 * 'agent run <id>'. When the command contains a placeholder (e.g. <provider/model>)
 * the placeholder is highlighted and the action id is appended for the run path. */
export function suggestedStrings(actions) {
	return actions.map((a) => {
		const joined = a.command === "agent" ? `agent ${a.args.join(" ")}` : `${a.command} ${a.args.join(" ")}`;
		const needsInput = a.args.some((x) => /<[^>]+>/.test(String(x)));
		return needsInput
			? `${a.reason} → ${joined}  ${a.id ? `(or: agent run ${a.id})` : ""}`
			: joined;
	});
}

/** Stable etag over the actionable state (for --since caching). */
export function computeEtag(s) {
	const hash = crypto.createHash("sha1");
	hash.update(
		JSON.stringify({
			master: s.masterContent == null ? 0 : 1,
			drift: s.drift,
			archetype: s.archetypeNeeded ? 1 : 0,
			unresolved: s.unresolvedModels.map((u) => u.name).sort(),
			consG: s.consG.recommend ? 1 : 0,
			consP: s.consP.recommend ? 1 : 0,
			staged: s.stagedUpdates.length,
			inbox: s.inboxCount,
			latest: s.upd.latest,
			skill: isSkillAvailable() ? 1 : 0,
		}),
	);
	return hash.digest("hex").slice(0, 16);
}

/** Execute one action's command. */
export function runAction(action) {
	if (action.command === "agent") {
		const r = spawnSync(process.execPath, [CLI_DIR, ...action.args], {
			encoding: "utf8",
			env: { ...process.env, AGENT_CLI_HOME: process.env.AGENT_CLI_HOME },
		});
		return { ok: r.status === 0, code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
	}
	const r = spawnSync(action.command, action.args, { encoding: "utf8" });
	return { ok: r.status === 0, code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Apply the safeToAutomate prefix of the plan; stop before user/destructive. */
export function applySafe(actions) {
	const receipts = [];
	let stoppedAt = null;
	for (const a of actions) {
		if (!a.safeToAutomate) {
			stoppedAt = a.id;
			receipts.push({ id: a.id, applied: false, skipped: true, reason: "not safe to automate" });
			break;
		}
		const r = runAction(a);
		receipts.push({
			id: a.id,
			applied: r.ok,
			code: r.code,
			stdout: (r.stdout || "").slice(0, 500),
			stderr: (r.stderr || "").slice(0, 300),
		});
		if (!r.ok) break;
	}
	return {
		receipts,
		applied: receipts.filter((r) => r.applied).length,
		skipped: receipts.filter((r) => r.skipped).length,
		stoppedAt,
	};
}

/** Run an action's verification command, if any. */
export function verifyAction(action) {
	const v = action.verification;
	if (!v) return { ok: true, verified: null, reason: "no verification command" };
	const r = v.command === "agent" ? runAction({ command: "agent", args: v.args }) : { ok: false, code: 1, stdout: "", stderr: "unsupported verification command" };
	return { ok: r.ok, verified: r.ok, code: r.code, output: ((r.stdout || "") + (r.stderr || "")).slice(0, 800) };
}
