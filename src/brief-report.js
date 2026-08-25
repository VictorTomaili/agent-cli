// src/brief-report.js — pure payload assembly for `agent-cli brief`.
// Takes the already-collected session state from src/actions.js#collectState
// (the single source of truth for the session contract, shared with `agent-cli
// run`/`agent-cli action verify`/the SDK) plus a couple of CLI-only extras, and
// returns the exact JSON envelope `agent-cli brief` emits. No emit/log/
// process.exit/network/writes — the caller owns all of that.

import fs from "node:fs";
import { pretty, MASTER_FILE } from "./util.js";
import { hasAgentCliBlock } from "./blocks.js";
import { isSkillAvailable, legacySkillFields } from "./skill.js";
import { shareHealth, SHARE_SOURCES } from "./share.js";
import { buildActions, suggestedStrings, computeEtag } from "./actions.js";
import { detectDevTeamDrift } from "./seed.js";

/**
 * @param {object} s - state from actions.js#collectState(...).
 * @param {object} [opts]
 * @param {object|null} [opts.forTask] - { query, hits } from task-aware
 *   retrieval (CLI `--for`/`--for-task`). Omitted from the payload when null.
 * @param {string} opts.version - installed agent-cli version string.
 */
export function buildBriefPayload(s, { forTask = null, version } = {}) {
	const actionsList = buildActions(s);
	const suggested = suggestedStrings(actionsList);
	const etag = computeEtag(s);
	// P1 / F1: content-hash staleness — the version-compare machinery reports
	// up-to-date when only the seed CONTENT moved. Surface a live-drift signal
	// when the live dev-team tree lags the expected (staged-or-seed) content.
	const devTeam = detectDevTeamDrift();

	const blockers = [];
	if (s.masterContent == null)
		blockers.push("master missing — run `agent-cli init`");
	const warnings = [];
	if (s.archetypeNeeded) warnings.push("identity onboarding incomplete");
	if (s.unresolvedModels.length)
		warnings.push(`${s.unresolvedModels.length} unresolved model alias(es)`);
	if (s.consG.recommend || s.consP.recommend)
		warnings.push("lesson consolidation recommended");
	if (s.upd.latest && !s.upd.upToDate)
		warnings.push(`agent-cli ${s.upd.latest} available`);
	if (s.session)
		warnings.push(
			`session open since ${s.session.startedAt} — run \`agent-cli session end\` to close it out and capture lesson candidates`,
		);
	// Agent Skills spec alignment: skills still carrying pre-spec top-level
	// extension fields (triggers/version) read fine, but migrating them makes
	// the store portable to every spec client. Surface once, with the fix.
	const legacySkills = isSkillAvailable() ? legacySkillFields() : [];
	if (legacySkills.length)
		warnings.push(
			`${legacySkills.length} skill(s) use legacy top-level ${[
				...new Set(legacySkills.flatMap((x) => x.legacyFields)),
			].join(
				"/",
			)} — run \`agent-cli skill migrate --apply\` (Agent Skills spec upgrade; dry-run without --apply)`,
		);
	// P1 / F1: seed content is newer than the installed live copy even when the
	// version strings match — make it loud so the agent acts instead of trusting
	// a false "up to date".
	if (devTeam.drift) warnings.push(devTeam.message);

	// Cross-tool sharing (manage once, use everywhere): enabled, share-capable
	// tools whose agents/skills dir is not linked to the single source.
	{
		const live = (d) => {
			try {
				return fs.readdirSync(d).some((n) => !n.startsWith("."));
			} catch {
				return false;
			}
		};
		const unlinked = shareHealth(s.cfg, { installed: s.installed ?? [] }).filter(
			(h) =>
				h.state !== "linked" &&
				live(h.kind === "agents" ? SHARE_SOURCES.agents : SHARE_SOURCES.skills),
		);
		if (unlinked.length) {
			const byKind = [...new Set(unlinked.map((u) => u.kind))].sort();
			warnings.push(
				`${unlinked.length} share link(s) missing (${byKind
					.map(
						(k) =>
							`${k}: ${unlinked
								.filter((u) => u.kind === k)
								.map((u) => u.id)
								.join(", ")}`,
					)
					.join("; ")}) — run \`agent-cli link ${byKind.join(
					"\` and \`agent-cli link ",
				)}\` (manage once, use everywhere)`,
			);
		}
	}

	return {
		tool: "agent-cli",
		version,
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
		...(forTask ? { forTask } : {}),
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
			legacyFields: legacySkills,
		},
		suggestedActions: suggested,
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
			installedVersion: version,
			latest: s.upd.latest,
			upToDate: s.upd.upToDate,
			checkedAt: s.upd.checkedAt,
			stagedUpdates: s.stagedUpdates,
		},
		// P1 / F1: content-level drift between the live dev-team tree and the
		// expected seed (or staged payload). Files lists the divergent relpaths;
		// message is the human-facing upgrade hint (also pushed to `warnings`).
		liveDrift: {
			drift: devTeam.drift,
			count: devTeam.count,
			files: devTeam.files,
			source: devTeam.source,
			message: devTeam.message,
		},
		onboarding: s.onboarding,
		sessionStart: { load: s.sessionLoad },
		session: s.session,
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
	};
}
