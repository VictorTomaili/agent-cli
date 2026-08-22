// src/doctor-report.js — pure payload builder for `agent-cli doctor` (+ api.doctor).
// Given already-loaded config/master/update-check data, runs every read-only
// health check and returns { issues, checks }. No emit/log/process.exit, no
// network access, no writes — the caller (CLI command or SDK) owns all of
// that. Mirrors the collectState()/buildActions() split in src/actions.js.

import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { pretty, exists, AGENTS_DIR, MASTER_FILE } from "./util.js";
import { isConfigCorrupt } from "./config.js";
import { hasAgentCliBlock } from "./blocks.js";
import { getTarget } from "./targets.js";
import { classify } from "./pointer.js";
import { isSkillAvailable } from "./skill.js";
import {
	identityInventory,
	listAgents,
	findUnresolvedModels,
} from "./agents-lib.js";
import { MODELS_MD } from "./models.js";
import { readProjectConfig as readProjectSkillConfig } from "./skills-gate.js";
import { listStagedUpdates } from "./seed.js";
import { shareHealth, SHARE_SOURCES, isOurLink } from "./share.js";
import fsSync from "node:fs";

const REQUIRED_FILES = new Set([
	"identity",
	"soul",
	"user",
	"lessons",
	"environments",
]);

/**
 * Build the `doctor` checks/issues payload.
 *
 * @param {object} cfg - already-loaded config.json contents.
 * @param {object} data - already-collected inputs the report needs:
 *   - masterContent: string|null — result of readMaster().
 *   - upd: { latest, upToDate } — result of npm-check read/ensure (caller
 *     decides cached vs. forced-refresh; this function never hits the network).
 *   - version: installed agent-cli version string (for the npm-update detail).
 *   - cwd: working directory for scope-aware checks (skill.config, identity).
 */
export async function buildDoctorReport(
	cfg,
	{ masterContent, upd, version, cwd = process.cwd(), installed = [] },
) {
	const issues = [];
	const checks = [];
	const masterOk = masterContent != null;

	checks.push({
		check: "config-not-corrupt",
		ok: !isConfigCorrupt(cfg),
		detail: isConfigCorrupt(cfg) ? "config.json is corrupt" : "ok",
	});
	if (isConfigCorrupt(cfg))
		issues.push(
			"config.json is corrupt — repair or remove it before changing settings",
		);
	checks.push({
		check: "master-exists",
		ok: masterOk,
		detail: pretty(MASTER_FILE),
	});
	if (!masterOk) issues.push("Master missing — run `agent-cli init`.");
	checks.push({
		check: "agent-cli-block",
		ok: hasAgentCliBlock(masterContent || ""),
		detail: "managed block in master",
	});
	if (masterOk && !hasAgentCliBlock(masterContent || ""))
		issues.push(
			"agent-cli block missing — run `agent-cli skill refresh` or `agent-cli init`.",
		);

	for (const id of cfg.global) {
		const t = getTarget(id);
		if (!t || !t.global) continue;
		const cls = await classify(t, "global");
		const ok = cls.state === "pointer";
		checks.push({
			check: "pointer:" + id,
			ok,
			detail: cls.state + " " + pretty(cls.path),
		});
		if (!ok && cls.state !== "missing")
			issues.push(`${id} pointer ${cls.state} — run \`agent-cli link\`.`);
	}
	const skillOk = isSkillAvailable();
	checks.push({
		check: "skill-available",
		ok: skillOk,
		detail: skillOk ? "integrated" : "none",
	});
	if (!skillOk)
		issues.push("skill-cli unavailable — run `agent-cli skill setup`.");

	// project skill.config health (false-green guard — doctor must not report
	// all-clear when a broken project skill.config would break the skill gate).
	const projSkillConfig = readProjectSkillConfig(cwd);
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

	// #1 identity files filled?
	const inv = await identityInventory({ scope: "global", cwd });
	for (const f of inv.files) {
		if (f.exists && f.filled === false) {
			checks.push({
				check: "identity-filled:" + f.kind,
				ok: false,
				detail: "unfilled template",
			});
			issues.push(
				`${f.kind} is an unfilled template — edit it: agent-cli edit ${f.kind}`,
			);
		}
	}
	// required files must EXIST (false-green guard — doctor must not report
	// healthy when the load manifest would show files as missing).
	const modelsMdExists = await exists(MODELS_MD);
	for (const f of inv.files) {
		if (!REQUIRED_FILES.has(f.kind)) continue;
		if (!f.exists) {
			checks.push({
				check: "file-exists:" + f.kind,
				ok: false,
				detail: "missing",
			});
			issues.push(
				`${f.kind} file missing (${pretty(f.path)}) — run \`agent-cli init\` to seed it.`,
			);
		}
	}
	checks.push({
		check: "file-exists:models",
		ok: modelsMdExists,
		detail: modelsMdExists ? pretty(MODELS_MD) : "missing",
	});
	if (!modelsMdExists)
		issues.push(
			`MODELS.md missing (${pretty(MODELS_MD)}) — run \`agent-cli init\` to seed it.`,
		);
	// #2 integration: personalities discoverable + none stranded in old pi path
	const subList = await listAgents({ includeProject: false });
	checks.push({
		check: "personalities-discoverable",
		ok: true,
		detail: `${subList.length} in ~/.agents/agents`,
	});
	// #2b unresolved model aliases → actionable setup guidance
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
	const oldPiAgents = path.join(os.homedir(), ".pi", "agent", "agents");
	// ~/.pi/agent/agents is now the pi SHARE LINK target (agent-cli link agents):
	// when it is our symlink to ~/.agents/agents, it is the DESIRED state — only
	// real (non-link) files there are stranded orphans.
	if (isOurLink(oldPiAgents, SHARE_SOURCES.agents)) {
		checks.push({
			check: "no-orphan-personalities",
			ok: true,
			detail: "shared via link",
		});
	} else {
		let orphans = 0;
		try {
			orphans = (await fsp.readdir(oldPiAgents)).filter((n) =>
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
				`${orphans} personalities stranded in old path ~/.pi/agent/agents — move them to ~/.agents/agents (agent-cli link agents then shares them everywhere)`,
			);
		} else {
			checks.push({
				check: "no-orphan-personalities",
				ok: true,
				detail: "old path clean",
			});
		}
	}
	// Cross-tool share links (agents/skills): for every enabled, share-capable
	// target, the expected dir should be our link to the single source. Only
	// actionable when the source actually has content (an empty roster/store
	// gains nothing from being linked).
	const sourceHasContent = (dir) => {
		try {
			return fsSync.readdirSync(dir).some((n) => !n.startsWith("."));
		} catch {
			return false;
		}
	};
	const rosterLive = sourceHasContent(SHARE_SOURCES.agents);
	const storeLive = sourceHasContent(SHARE_SOURCES.skills);
	for (const h of shareHealth(cfg, { installed })) {
		const live = h.kind === "agents" ? rosterLive : storeLive;
		const ok = h.state === "linked" || !live;
		checks.push({
			check: `share-${h.kind}:${h.id}`,
			ok,
			detail: h.state + " " + pretty(h.path),
		});
		if (!ok)
			issues.push(
				`${h.id} ${h.kind} dir ${h.state} — run \`agent-cli link ${h.kind}\` to share the ${
					h.kind === "agents" ? "persona roster" : "skill store"
				} (manage once, use everywhere)`,
			);
	}
	// npm latest version — caller supplies `upd` (cached read or forced refresh);
	// this function never hits the network itself.
	checks.push({
		check: "npm-update",
		ok: !upd.latest || upd.upToDate,
		detail: upd.latest
			? upd.upToDate
				? `latest ${upd.latest}`
				: `latest ${upd.latest} (installed ${version})`
			: "unable to check",
	});
	if (upd.latest && !upd.upToDate)
		issues.push(`agent-cli ${upd.latest} is available (installed ${version}).`);
	// staged update payloads awaiting migration
	const staged = await listStagedUpdates({ home: AGENTS_DIR });
	checks.push({
		check: "staged-updates",
		ok: staged.length === 0,
		detail: staged.length ? `${staged.length} payload(s)` : "none",
	});
	if (staged.length)
		issues.push(
			`${staged.length} staged update payload(s) under ~/.agents/update-* — review with the user and migrate (see: agent-cli update list).`,
		);

	return { issues, checks };
}
