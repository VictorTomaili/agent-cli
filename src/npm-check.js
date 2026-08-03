// src/npm-check.js — compare the installed agent-cli version against the latest
// published version on the npm registry. Best-effort, network-optional: any
// failure resolves to `null`/unknown, never throwing. Results are cached daily
// inside config.json (`updateCheck`) so brief/doctor stay fast.

const REGISTRY = "https://registry.npmjs.org";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Fetch the latest published version of a package, or null on any failure. */
export async function fetchLatestVersion(
	pkgName,
	{ timeoutMs = 3000, fetchImpl } = {},
) {
	const fetchFn = fetchImpl || globalThis.fetch;
	if (typeof fetchFn !== "function") return null;
	const url = `${REGISTRY}/${encodeURIComponent(pkgName)}/latest`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetchFn(url, { signal: ctrl.signal });
		if (!res.ok) return null;
		const data = await res.json();
		return data?.version ?? null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Compare two semver-ish strings (ignores leading 'v' and pre-release). Returns -1|0|1. */
export function compareVersions(a, b) {
	const pa = String(a || "")
		.replace(/^v/, "")
		.split("+")[0]
		.split("-")[0]
		.split(".")
		.map((n) => parseInt(n, 10) || 0);
	const pb = String(b || "")
		.replace(/^v/, "")
		.split("+")[0]
		.split("-")[0]
		.split(".")
		.map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const x = pa[i] || 0;
		const y = pb[i] || 0;
		if (x < y) return -1;
		if (x > y) return 1;
	}
	return 0;
}

/**
 * Resolve the latest version, using a daily cache in cfg.updateCheck. Mutates cfg
 * when a fresh fetch succeeds. Returns { latest, upToDate, checkedAt, cached, refreshed }.
 * - upToDate is true when installed >= latest; null when latest is unknown.
 */
export async function ensureUpdateCheck(
	cfg,
	pkgName,
	installedVersion,
	{ force = false, timeoutMs = 3000, now = Date.now(), fetchImpl } = {},
) {
	const cached = cfg?.updateCheck;
	const cacheFresh =
		cached?.latestVersion &&
		cached?.checkedAt &&
		now - new Date(cached.checkedAt).getTime() < DAY_MS;

	if (!force && cacheFresh) {
		return {
			latest: cached.latestVersion,
			upToDate: compareVersions(installedVersion, cached.latestVersion) >= 0,
			checkedAt: cached.checkedAt,
			cached: true,
			refreshed: false,
		};
	}

	const latest = await fetchLatestVersion(pkgName, { timeoutMs, fetchImpl });
	if (latest) {
		cfg.updateCheck = {
			latestVersion: latest,
			checkedAt: new Date(now).toISOString(),
		};
		return {
			latest,
			upToDate: compareVersions(installedVersion, latest) >= 0,
			checkedAt: cfg.updateCheck.checkedAt,
			cached: false,
			refreshed: true,
		};
	}

	// Fetch failed: fall back to stale cache if present, else unknown.
	if (cached?.latestVersion) {
		return {
			latest: cached.latestVersion,
			upToDate: compareVersions(installedVersion, cached.latestVersion) >= 0,
			checkedAt: cached.checkedAt,
			cached: true,
			refreshed: false,
		};
	}
	return {
		latest: null,
		upToDate: null,
		checkedAt: null,
		cached: false,
		refreshed: false,
	};
}
