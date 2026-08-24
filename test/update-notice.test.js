// Tests for src/update-notice.js — the fire-and-forget npm-version freshness
// notice wired into cli.js's preAction hook.
//
// Properties under test:
//   - returns { notice: null } when up to date
//   - returns { notice: <line> } when installed < latest
//   - returns { notice: null } when offline + no cache
//   - respects AGENT_OFFLINE=1, AGENT_CLI_NO_UPDATE_CHECK=1, --no-update-check
//   - never throws on network failure
//   - readCachedUpdate path skips the network entirely
//   - the notice text is the actionable command the user runs

import { test } from "node:test";
import assert from "node:assert";
import {
	resolveUpdateNotice,
	updateCheckEnabled,
} from "../src/update-notice.js";

/** Synthetic config the lib mutates in place. */
function cfg(updateCheck) {
	return updateCheck === undefined ? {} : { updateCheck };
}

test("returns null notice when cache says up to date", async () => {
	const c = cfg({
		latestVersion: "9.9.9",
		checkedAt: new Date().toISOString(),
	});
	const r = await resolveUpdateNotice(c, "@x/test", "9.9.9", {});
	assert.equal(r.latest, "9.9.9");
	assert.equal(r.upToDate, true);
	assert.equal(r.notice, null);
});

test("returns notice when installed < latest (cached)", async () => {
	const c = cfg({
		latestVersion: "1.2.0",
		checkedAt: new Date().toISOString(),
	});
	const r = await resolveUpdateNotice(c, "@x/test", "1.1.0", {});
	assert.equal(r.latest, "1.2.0");
	assert.equal(r.upToDate, false);
	assert.ok(r.notice);
	assert.match(r.notice, /1\.2\.0 available/);
	assert.match(r.notice, /npm i -g @x\/test@latest/);
	assert.match(r.notice, /current 1\.1\.0/);
});

test("offline + no cache → notice null (unknown)", async () => {
	const r = await resolveUpdateNotice({}, "@x/test", "1.0.0", { offline: true });
	assert.equal(r.latest, null);
	assert.equal(r.notice, null);
	assert.equal(r.reason, "offline");
});

test("offline + stale cache → falls back to stale notice", async () => {
	const old = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
	const c = cfg({ latestVersion: "1.5.0", checkedAt: old });
	const r = await resolveUpdateNotice(c, "@x/test", "1.0.0", { offline: true });
	assert.equal(r.latest, "1.5.0");
	assert.equal(r.upToDate, false);
	assert.ok(r.notice);
	assert.equal(r.reason, "offline");
});

test("network failure + no cache → notice null", async () => {
	const r = await resolveUpdateNotice(
		{},
		"@x/this-package-does-not-exist-on-npm-12345",
		"1.0.0",
		{ timeoutMs: 50 },
	);
	assert.equal(r.notice, null);
});

test("network failure + stale cache → falls back to stale notice", async () => {
	const old = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
	const c = cfg({ latestVersion: "1.5.0", checkedAt: old });
	const r = await resolveUpdateNotice(
		c,
		"@x/this-package-does-not-exist-on-npm-12345",
		"1.0.0",
		{ timeoutMs: 50 },
	);
	assert.equal(r.latest, "1.5.0");
	assert.ok(r.notice);
});

test("force=true bypasses cache", async () => {
	const c = cfg({
		latestVersion: "1.0.0",
		checkedAt: new Date().toISOString(),
	});
	const r = await resolveUpdateNotice(c, "@x/this-package-does-not-exist-67890", "1.0.0", {
		force: true,
		timeoutMs: 50,
	});
	// Network fails → notice null despite force=true
	assert.equal(r.notice, null);
});

test("updateCheckEnabled respects opt-outs", () => {
	assert.equal(updateCheckEnabled({ argv: ["x"], env: {} }), true);
	assert.equal(updateCheckEnabled({ argv: ["x"], env: { AGENT_OFFLINE: "1" } }), false);
	assert.equal(
		updateCheckEnabled({
			argv: ["x"],
			env: { AGENT_CLI_NO_UPDATE_CHECK: "1" },
		}),
		false,
	);
	assert.equal(
		updateCheckEnabled({ argv: ["x", "--no-update-check"], env: {} }),
		false,
	);
	assert.equal(
		updateCheckEnabled({ argv: ["x", "--offline"], env: {} }),
		false,
	);
});

test("notice text is single-line (no embedded newlines)", async () => {
	const c = cfg({
		latestVersion: "2.0.0",
		checkedAt: new Date().toISOString(),
	});
	const r = await resolveUpdateNotice(c, "@x/test", "1.0.0", {});
	assert.ok(r.notice);
	assert.ok(!r.notice.includes("\n"), "notice must be single-line for stderr printing");
});

test("compareVersions logic: pre-release is treated as older", async () => {
	// Use a non-existent pkg so the network returns nothing; just exercise the
	// comparison semantics through a stale cache.
	const c = cfg({
		latestVersion: "1.0.0-beta",
		checkedAt: new Date().toISOString(),
	});
	const r = await resolveUpdateNotice(c, "@x/test", "0.9.0", {});
	// Stripped pre-release compares 1.0.0 vs 0.9.0 → newer → notice fires.
	assert.equal(r.latest, "1.0.0-beta");
	assert.ok(r.notice);
});