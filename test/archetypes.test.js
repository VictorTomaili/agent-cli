import { test } from "node:test";
import assert from "node:assert";

const arc = await import("../src/archetypes.js");
const { readTag, fieldGaps } = await import("../src/fields.js");

test("identityContent emits all 4 tags with name empty", () => {
	const c = arc.identityContent("coding");
	assert.equal(readTag(c, "AGENT_NAME"), "");
	for (const t of ["AGENT_ROLE", "AGENT_MISSION", "AGENT_PERSONA"])
		assert.ok(readTag(c, t).length > 0, `${t} should be filled`);
});

test("identityContent for every known archetype is gap-free except name", () => {
	for (const key of Object.keys(arc.IDENTITIES)) {
		const gaps = fieldGaps(arc.identityContent(key), "identity");
		assert.deepEqual(
			gaps,
			["AGENT_NAME"],
			`${key} should only miss AGENT_NAME`,
		);
	}
});

test("identityContent UNKNOWN key falls back to default content", () => {
	const c = arc.identityContent("nonsense-key");
	const def = arc.identityContent("general-purpose");
	assert.equal(readTag(c, "AGENT_ROLE"), readTag(def, "AGENT_ROLE"));
	assert.equal(readTag(c, "AGENT_MISSION"), readTag(def, "AGENT_MISSION"));
	assert.equal(readTag(c, "AGENT_PERSONA"), readTag(def, "AGENT_PERSONA"));
});

test("soulContent emits all 4 soul tags filled, for every soul", () => {
	for (const key of Object.keys(arc.SOULS)) {
		const c = arc.soulContent(key);
		assert.deepEqual(
			fieldGaps(c, "soul"),
			[],
			`${key} soul should be complete`,
		);
	}
});

test("soulContent UNKNOWN key falls back to default soul content", () => {
	const c = arc.soulContent("does-not-exist");
	const def = arc.soulContent("pragmatist");
	assert.equal(
		readTag(c, "SOUL_PERSONALITY"),
		readTag(def, "SOUL_PERSONALITY"),
	);
});

test("userContent: filled PREFS, empty GOALS + CONTEXT", () => {
	const c = arc.userContent();
	assert.ok(readTag(c, "USER_PREFS").length > 0);
	assert.equal(readTag(c, "USER_GOALS"), "");
	assert.equal(readTag(c, "USER_CONTEXT"), "");
	assert.deepEqual(fieldGaps(c, "user"), ["USER_GOALS", "USER_CONTEXT"]);
});

test("workflowContent returns the WORKFLOW.md starter body", () => {
	const c = arc.workflowContent();
	assert.equal(typeof c, "string");
	assert.ok(c.startsWith("# WORKFLOW.md\n"), "must start with the H1 heading");
	assert.ok(c.endsWith("\n"), "must end with a trailing newline");
	assert.ok(c.length > 500, "starter body suspiciously small");
});

test("workflowContent documents both using and recording a workflow", () => {
	const c = arc.workflowContent();
	for (const heading of [
		"## Using a workflow",
		"## Recording a workflow",
		"## Entry format",
		"## Workflows",
	])
		assert.ok(c.includes(heading), `missing section: ${heading}`);
});

test("workflowContent ships a greppable entry format with the required fields", () => {
	const c = arc.workflowContent();
	for (const field of [
		"**Trigger:**",
		"**Inputs:**",
		"**Risk:**",
		"**Steps:**",
		"**Verify:**",
		"**Recorded:**",
	])
		assert.ok(c.includes(field), `entry format missing field: ${field}`);
});

test("workflowContent ships no literal calendar date", () => {
	const c = arc.workflowContent();
	// A date baked into the shipped seed is wrong for every user who runs `init`
	// after it, and — depending on when they install relative to the release —
	// can even be in their future. The example entries say the same thing
	// honestly with `Runs: 0` and `Last run: —`.
	assert.doesNotMatch(
		c,
		/\d{4}-\d{2}-\d{2}/,
		"the WORKFLOW.md seed must not hardcode a date",
	);
	// The format is still specified — as a placeholder, not a real day.
	assert.ok(c.includes("YYYY-MM-DD"), "entry format must still show the date shape");
});

test("workflowContent keeps the confirmation gate for recorded steps", () => {
	// A recorded recipe must never read as pre-approval for an irreversible
	// step — that is the whole safety contract of replaying a workflow.
	const c = arc.workflowContent();
	assert.match(c, /never pre-approves an irreversible/);
	assert.match(c, /irreversible/);
});

test("workflowContent refuses to record secrets", () => {
	const c = arc.workflowContent();
	assert.match(c, /Never write into a workflow/);
	assert.match(c, /never the value/);
});

test("workflowContent names models by alias only — no provider or version", () => {
	// Models are referred to by alias (`<model-alias>`, `coding-model`, …).
	// A concrete provider/model/version in a seeded brain file would rot and
	// would contradict MODELS.md being the single mapping surface.
	const c = arc.workflowContent().toLowerCase();
	assert.ok(c.includes("<model-alias>"), "must teach the alias placeholder");
	for (const forbidden of [
		"anthropic",
		"claude",
		"openai",
		"gpt-",
		"gemini",
		"llama",
		"mistral",
		"deepseek",
		"minimax",
		"glm-",
		"opus",
		"sonnet",
		"haiku",
	])
		assert.ok(
			!c.includes(forbidden),
			`seed content must not name a concrete model/provider: '${forbidden}'`,
		);
});

test("workflowContent is deterministic (same bytes on every call)", () => {
	assert.equal(arc.workflowContent(), arc.workflowContent());
});

test("onboardOptions covers every identity with key+label", () => {
	const opts = arc.onboardOptions();
	assert.equal(opts.length, Object.keys(arc.IDENTITIES).length);
	assert.ok(opts.every((o) => o.key && o.label));
});

test("DEFAULT_IDENTITY / DEFAULT_SOUL point at real catalog entries", () => {
	assert.ok(arc.IDENTITIES[arc.DEFAULT_IDENTITY]);
	assert.ok(arc.SOULS[arc.DEFAULT_SOUL]);
});

test("identityContent UNKNOWN key labels the header with the RESOLVED default", () => {
	const c = arc.identityContent("bogus");
	assert.ok(c.includes("(Archetype: general-purpose)"));
	assert.ok(!c.includes("(Archetype: bogus)"));
});

test("soulContent UNKNOWN key labels the header with the RESOLVED default", () => {
	const c = arc.soulContent("bogus");
	assert.ok(c.includes("(Soul variant: pragmatist)"));
	assert.ok(!c.includes("(Soul variant: bogus)"));
});
