// src/brief-report.js — pure payload assembly for `agent brief`.
// Takes the already-collected session state from src/actions.js#collectState
// (the single source of truth for the session contract, shared with `agent
// run`/`agent action verify`/the SDK) plus a couple of CLI-only extras, and
// returns the exact JSON envelope `agent brief` emits. No emit/log/
// process.exit/network/writes — the caller owns all of that.

import { pretty, MASTER_FILE } from "./util.js";
import { hasAgentCliBlock } from "./blocks.js";
import { isSkillAvailable } from "./skill.js";
import { buildActions, suggestedStrings, computeEtag } from "./actions.js";

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

	const blockers = [];
	if (s.masterContent == null)
		blockers.push("master missing — run `agent init`");
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
			`session open since ${s.session.startedAt} — run \`agent session end\` to close it out and capture lesson candidates`,
		);

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
