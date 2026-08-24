// src/update-notice.js — fire-and-forget npm-version freshness notice.
//
// Purpose: every CLI invocation should remind them, via a single line on
// stderr, when their installed agent-cli is older than the latest published
// version. The notice is opt-out via `--no-update-check`, `AGENT_OFFLINE=1`,
// or `AGENT_CLI_NO_UPDATE_CHECK=1`.
//
// Properties enforced here:
//   - Non-blocking: callers await it from the postAction hook; a 1.5s timeout
//     caps the network so a slow registry cannot delay a fast command.
//   - Idempotent: results are cached in config.json (daily). Once cached, the
//     notice is read from the cache (no network) until the cache expires or
//     `force=true` is passed.
//   - Honest: any failure (no network, parse error, missing package) resolves
//     to `{ notice: null }` — never blocks the user, never throws.
//   - JSON-safe: the notice text is included in the JSON envelope's top-level
//     `updateNotice` field when --json is requested, so an LLM driving the
//     CLI can react to it programmatically.

import { ensureUpdateCheck, readCachedUpdate, compareVersions } from "./npm-check.js";

/** Default timeout for the network round-trip when refreshing the cache. */
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Resolve the update notice (best-effort). Caller passes the cfg so we can
 * read/write the same shape every other consumer uses (no duplication).
 *
 * @param {object} cfg - already-loaded config.json (mutated only when `force && fetchOk`)
 * @param {string} pkgName
 * @param {string} installedVersion
 * @param {object} [opts]
 * @param {boolean} [opts.force] - bypass cache, hit the network
 * @param {boolean} [opts.offline] - never hit the network (use stale cache or none)
 * @param {number} [opts.timeoutMs] - network timeout (default 1500ms)
 * @param {typeof globalThis.fetch} [opts.fetchImpl]
 *
 * Returns { latest, upToDate, checkedAt, notice, reason }:
 *   notice - null when up to date / unknown / opted out; otherwise a single
 *            human-readable line ready to print on stderr ("! agent-cli X.Y.Z
 *            available — run: npm i -g @victortomaili/agent-cli@latest").
 *   reason - "fresh" | "cached" | "offline" | "opt-out" | "network-failed"
 *            so tests + callers can introspect without parsing the message.
 */
export async function resolveUpdateNotice(
	cfg,
	pkgName,
	installedVersion,
	opts = {},
) {
	const {
		force = false,
		offline = false,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		fetchImpl,
	} = opts;
	let upd;
	if (force && !offline) {
		upd = await ensureUpdateCheck(cfg, pkgName, installedVersion, {
			force: true,
			offline,
			timeoutMs,
			fetchImpl,
		});
	} else if (offline) {
		upd = readCachedUpdate(cfg, installedVersion);
		upd.reason = "offline";
	} else {
		upd = readCachedUpdate(cfg, installedVersion);
		// If cache is stale OR missing, opportunistically refresh — but bounded
		// by the timeout, and we never block the user (caller awaits us).
		if (!upd.cached) {
			upd = await ensureUpdateCheck(cfg, pkgName, installedVersion, {
				force: false,
				offline: false,
				timeoutMs,
				fetchImpl,
			});
			upd.reason = upd.refreshed ? "fresh" : "network-failed";
		} else {
			upd.reason = "cached";
		}
	}
	if (!upd.latest) {
		return {
			latest: null,
			upToDate: null,
			checkedAt: upd.checkedAt,
			notice: null,
			reason: upd.reason,
		};
	}
	if (compareVersions(installedVersion, upd.latest) >= 0) {
		return {
			latest: upd.latest,
			upToDate: true,
			checkedAt: upd.checkedAt,
			notice: null,
			reason: upd.reason,
		};
	}
	return {
		latest: upd.latest,
		upToDate: false,
		checkedAt: upd.checkedAt,
		notice: `agent-cli ${upd.latest} available — run: npm i -g ${pkgName}@latest  (current ${installedVersion})`,
		reason: upd.reason,
	};
}

/** Should the CLI check for updates given argv and env? Pure helper. */
export function updateCheckEnabled({ argv = process.argv, env = process.env } = {}) {
	if (env.AGENT_OFFLINE === "1") return false;
	if (env.AGENT_CLI_NO_UPDATE_CHECK === "1") return false;
	if (argv.includes("--no-update-check")) return false;
	if (argv.includes("--offline")) return false;
	return true;
}