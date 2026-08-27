// Structured session-contract tests: buildActions / suggestedStrings / etag / run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_CLI_HOME = mkdtempSync(path.join(tmpdir(), "agent-actions-"));
const actions = await import("../src/actions.js");
const CLI = path.resolve("src/cli.js");

function run(args) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		env: { ...process.env, AGENT_OFFLINE: "1" },
	});
	assert.equal(r.status, 0, `${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

function initHome() {
	run(["init"]);
}

test("buildActions produces structured, ordered actions", async () => {
	initHome();
	const s = await actions.collectState();
	const list = actions.buildActions(s);
	assert.ok(Array.isArray(list));
	for (const a of list) {
		assert.equal(typeof a.id, "string");
		assert.ok(["critical", "high", "medium", "low"].includes(a.severity));
		assert.equal(typeof a.safeToAutomate, "boolean");
		assert.equal(typeof a.idempotent, "boolean");
		assert.ok(a.command === "agent-cli" || a.command === "npm");
		assert.ok(Array.isArray(a.args));
	}
	// sorted by severity desc
	const severities = list.map((a) => actions.ACTION_SEVERITY[a.severity]);
	assert.deepEqual(severities, [...severities].sort((a, b) => b - a));
});

// agent-cli used to ship a hardcoded model catalog, so `init` could auto-pick
// an alias for every seeded persona and this asserted zero models:set actions.
// It ships no model data now, so a fresh machine genuinely cannot resolve an
// alias until a catalog is imported. The contract that matters is that the gap
// is VISIBLE as an action rather than silently left unresolved.
test("a fresh init surfaces unresolved aliases and offers the catalog import", async () => {
	initHome();
	const s = await actions.collectState();
	const list = actions.buildActions(s);
	assert.ok(
		list.some((a) => a.id.startsWith("models:set:")),
		"seeded personas with no catalog must surface models:set actions",
	);
	const fetch = list.find((a) => a.id === "models:research:fetch");
	assert.ok(fetch, "the catalog import must be offered when none was imported");
	assert.equal(
		fetch.safeToAutomate,
		false,
		"apply-safe must never make a live network call on the user's behalf",
	);
});
test("suggestedStrings derives legacy shell strings", async () => {
	initHome();
	// After auto-init, create drift so there's at least one action.
	run(["target", "enable", "claude", "-g"]);
	run(["unlink", "--target", "claude"]);
	const s = await actions.collectState();
	const strings = actions.suggestedStrings(actions.buildActions(s));
	assert.ok(Array.isArray(strings));
	assert.ok(strings.length >= 1);
});

test("computeEtag is stable for identical state and changes with drift", async () => {
	initHome();
	// A prior test may have created drift; relink so the baseline is clean.
	run(["link", "--target", "claude"]);
	const s1 = await actions.collectState();
	const e1 = actions.computeEtag(s1);
	const s2 = await actions.collectState();
	assert.equal(actions.computeEtag(s2), e1);
	const different = actions.computeEtag({ ...s1, drift: ["claude"] });
	assert.notEqual(different, e1);
});

test("applySafe runs safe actions and stops at the first unsafe one", async () => {
	initHome();
	run(["target", "enable", "claude", "-g"]);
	run(["unlink", "--target", "claude"]); // create pointer drift
	const s = await actions.collectState();
	const list = actions.buildActions(s);
	const linkAction = list.find((a) => a.id === "link:claude");
	assert.ok(linkAction, "expected a link:claude action");
	assert.equal(linkAction.safeToAutomate, true);
	const res = actions.applySafe(list);
	assert.ok(res.applied >= 1);
	assert.ok(res.receipts.some((r) => r.id === "link:claude" && r.applied));
	// after the fix, the pointer is restored
	const status = JSON.parse(run(["status", "--json"])).data;
	const claude = status.targets.find((t) => t.id === "claude");
	assert.equal(claude.global.state, "pointer");
});

test("runAction executes an agent-cli command", async () => {
	const r = actions.runAction({ command: "agent-cli", args: ["--version"] });
	assert.equal(r.ok, true);
	assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("verifyAction reports missing verification and runs real ones", async () => {
	const none = actions.verifyAction({ id: "x", verification: null });
	assert.equal(none.verified, null);
	const withV = actions.verifyAction({
		id: "y",
		verification: { command: "agent-cli", args: ["--version"] },
	});
	assert.equal(withV.verified, true);
});

test("buildActions adds a high-severity onboard action when the top gap is the identity archetype", () => {
	const base = {
		masterContent: "x",
		onboarding: {
			nextSuggestion: {
				kind: "identity",
				question: "What role should this agent have?",
				default: "general-purpose",
				options: [],
				souls: [],
			},
		},
		pointerTargets: [],
		unresolvedModels: [],
		stagedUpdates: [],
		inboxCount: 0,
		consG: { recommend: false },
		consP: { recommend: false },
		upd: { latest: null, upToDate: true },
		liveCatalogAge: null,
	};
	const list = actions.buildActions(base);
	const action = list.find((a) => a.id === "onboard");
	assert.ok(action, "expected an onboard action");
	assert.equal(action.severity, "high");
	assert.deepEqual(action.args, ["onboard", "suggest"]);
	assert.match(action.reason, /^identity gap: /);
	assert.equal(action.idempotent, true);
	assert.equal(action.safeToAutomate, false);
});

test("buildActions adds a medium-severity onboard action when the top gap is a non-identity field (e.g. USER.md)", () => {
	const base = {
		masterContent: "x",
		onboarding: {
			nextSuggestion: {
				kind: "user",
				tag: "USER_GOALS",
				question: "What are your goals in this context?",
				freeform: true,
			},
		},
		pointerTargets: [],
		unresolvedModels: [],
		stagedUpdates: [],
		inboxCount: 0,
		consG: { recommend: false },
		consP: { recommend: false },
		upd: { latest: null, upToDate: true },
		liveCatalogAge: null,
	};
	const list = actions.buildActions(base);
	const action = list.find((a) => a.id === "onboard");
	assert.ok(action, "expected an onboard action");
	assert.equal(action.severity, "medium");
	assert.deepEqual(action.args, ["onboard", "suggest"]);
	assert.match(action.reason, /^user gap: /);
});

test("buildActions omits the onboard action entirely when nextGapSuggestion returns null", () => {
	const base = {
		masterContent: "x",
		onboarding: { nextSuggestion: null },
		pointerTargets: [],
		unresolvedModels: [],
		stagedUpdates: [],
		inboxCount: 0,
		consG: { recommend: false },
		consP: { recommend: false },
		upd: { latest: null, upToDate: true },
		liveCatalogAge: null,
	};
	const list = actions.buildActions(base);
	assert.ok(!list.some((a) => a.id === "onboard"));
});

test("buildActions suggests --fetch when the live catalog is stale but not fresh", () => {
	const base = {
		masterContent: "x",
		archetypeNeeded: false,
		pointerTargets: [],
		unresolvedModels: [],
		stagedUpdates: [],
		inboxCount: 0,
		consG: { recommend: false },
		consP: { recommend: false },
		upd: { latest: null, upToDate: true },
	};
	// Fresh or never-fetched (null) → no suggestion.
	const fresh = actions.buildActions({ ...base, liveCatalogAge: 1 });
	assert.ok(!fresh.some((a) => a.id === "models:research:fetch"));

	const never = actions.buildActions({ ...base, liveCatalogAge: null });
	assert.ok(!never.some((a) => a.id === "models:research:fetch"));

	// >= 30 days → suggestion present, safe to automate.
	const stale = actions.buildActions({ ...base, liveCatalogAge: 30 });
	const action = stale.find((a) => a.id === "models:research:fetch");
	assert.ok(action, "expected models:research:fetch action for a 30-day-old catalog");
	assert.equal(action.safeToAutomate, true);
	assert.deepEqual(action.args, ["models", "research", "--fetch"]);
});
