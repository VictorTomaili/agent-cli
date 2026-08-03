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
