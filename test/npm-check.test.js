import { test } from "node:test";
import assert from "node:assert";

const npm = await import("../src/npm-check.js");

test("compareVersions basics", () => {
	assert.equal(npm.compareVersions("0.1.0", "0.2.0"), -1);
	assert.equal(npm.compareVersions("0.2.0", "0.2.0"), 0);
	assert.equal(npm.compareVersions("0.2.1", "0.2.0"), 1);
	assert.equal(npm.compareVersions("v0.2.0", "0.2.0"), 0);
	assert.equal(npm.compareVersions("1.0.0", "1.0"), 0); // missing segment = 0
});

test("compareVersions ignores pre-release/build metadata", () => {
	assert.equal(npm.compareVersions("1.0.0-rc.1", "1.0.0"), 0);
	assert.equal(npm.compareVersions("1.2.3+sha", "1.2.3"), 0);
});

test("fetchLatestVersion returns version from registry (mocked)", async () => {
	const fetchImpl = async () => ({
		ok: true,
		json: async () => ({ version: "1.2.3" }),
	});
	const v = await npm.fetchLatestVersion("@victortomaili/agent-cli", { fetchImpl });
	assert.equal(v, "1.2.3");
});

test("fetchLatestVersion returns null on http error", async () => {
	const fetchImpl = async () => ({
		ok: false,
		status: 404,
		json: async () => ({}),
	});
	const v = await npm.fetchLatestVersion("@victortomaili/agent-cli", { fetchImpl });
	assert.equal(v, null);
});

test("fetchLatestVersion returns null on throw", async () => {
	const fetchImpl = async () => {
		throw new Error("network down");
	};
	const v = await npm.fetchLatestVersion("@victortomaili/agent-cli", {
		fetchImpl,
		timeoutMs: 50,
	});
	assert.equal(v, null);
});

test("ensureUpdateCheck fetches fresh then caches for a day", async () => {
	let calls = 0;
	const fetchImpl = async () => {
		calls++;
		return { ok: true, json: async () => ({ version: "0.3.0" }) };
	};
	const cfg = {};
	const now = Date.now();
	const a = await npm.ensureUpdateCheck(cfg, "@victortomaili/agent-cli", "0.2.0", {
		fetchImpl,
		now,
	});
	assert.equal(a.latest, "0.3.0");
	assert.equal(a.upToDate, false);
	assert.equal(a.refreshed, true);
	assert.equal(calls, 1);
	assert.equal(cfg.updateCheck.latestVersion, "0.3.0");

	// within a day → cached, no new call
	const b = await npm.ensureUpdateCheck(cfg, "@victortomaili/agent-cli", "0.2.0", {
		fetchImpl,
		now: now + 1000,
	});
	assert.equal(b.cached, true);
	assert.equal(b.refreshed, false);
	assert.equal(calls, 1);

	// after a day → refresh
	const c = await npm.ensureUpdateCheck(cfg, "@victortomaili/agent-cli", "0.2.0", {
		fetchImpl,
		now: now + 26 * 60 * 60 * 1000,
	});
	assert.equal(c.refreshed, true);
	assert.equal(calls, 2);
});

test("ensureUpdateCheck force=true bypasses cache", async () => {
	let calls = 0;
	const fetchImpl = async () => {
		calls++;
		return { ok: true, json: async () => ({ version: "0.4.0" }) };
	};
	const cfg = {};
	await npm.ensureUpdateCheck(cfg, "@victortomaili/agent-cli", "0.2.0", { fetchImpl });
	await npm.ensureUpdateCheck(cfg, "@victortomaili/agent-cli", "0.2.0", {
		fetchImpl,
		force: true,
	});
	assert.equal(calls, 2);
});

test("ensureUpdateCheck falls back to stale cache when fetch fails", async () => {
	const good = async () => ({
		ok: true,
		json: async () => ({ version: "0.3.0" }),
	});
	const bad = async () => {
		throw new Error("down");
	};
	const cfg = {};
	await npm.ensureUpdateCheck(cfg, "@victortomaili/agent-cli", "0.2.0", {
		fetchImpl: good,
	});
	const r = await npm.ensureUpdateCheck(cfg, "@victortomaili/agent-cli", "0.2.0", {
		fetchImpl: bad,
		force: true,
	});
	assert.equal(r.latest, "0.3.0"); // stale cache served
	assert.equal(r.refreshed, false);
});

test("ensureUpdateCheck unknown when no cache and fetch fails", async () => {
	const bad = async () => {
		throw new Error("down");
	};
	const r = await npm.ensureUpdateCheck({}, "@victortomaili/agent-cli", "0.2.0", {
		fetchImpl: bad,
	});
	assert.equal(r.latest, null);
	assert.equal(r.upToDate, null);
});
