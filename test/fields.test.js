import { test } from "node:test";
import assert from "node:assert";

const f = await import("../src/fields.js");

test("kindForFile maps the tagged files", () => {
	assert.equal(f.kindForFile("IDENTITY.md"), "identity");
	assert.equal(f.kindForFile("SOUL.md"), "soul");
	assert.equal(f.kindForFile("USER.md"), "user");
	assert.equal(f.kindForFile("FOO.md"), null);
});

test("readTag / setTag read, replace, and append", () => {
	const c = "# X\n\n<AGENT_NAME></AGENT_NAME>\n";
	assert.equal(f.readTag(c, "AGENT_NAME"), "");
	assert.equal(f.readTag(c, "AGENT_ROLE"), null);
	const c2 = f.setTag(c, "AGENT_NAME", "Marvin");
	assert.equal(f.readTag(c2, "AGENT_NAME"), "Marvin");
	// appends the tag when absent
	const c3 = f.setTag("# Y\n", "AGENT_ROLE", "coder");
	assert.ok(c3.includes("<AGENT_ROLE>coder</AGENT_ROLE>"));
});

test("isPlaceholder detects gaps", () => {
	assert.equal(f.isPlaceholder(null), true);
	assert.equal(f.isPlaceholder(""), true);
	assert.equal(f.isPlaceholder("   "), true);
	assert.equal(f.isPlaceholder("(your chosen name)"), true);
	assert.equal(f.isPlaceholder("<fill>"), true);
	assert.equal(f.isPlaceholder("Marvin"), false);
	assert.equal(f.isPlaceholder("A real role description"), false);
});

test("fieldGaps lists only empty/placeholder tags", () => {
	const c = `# X
<AGENT_NAME></AGENT_NAME>
<AGENT_ROLE>(fill in)</AGENT_ROLE>
<AGENT_MISSION>real mission</AGENT_MISSION>
<AGENT_PERSONA>real persona</AGENT_PERSONA>
`;
	assert.deepEqual(f.fieldGaps(c, "identity"), ["AGENT_NAME", "AGENT_ROLE"]);
});

test("fieldGaps returns [] when all identity tags are filled", () => {
	const c = `# X
<AGENT_NAME>Marvin</AGENT_NAME>
<AGENT_ROLE>r</AGENT_ROLE>
<AGENT_MISSION>m</AGENT_MISSION>
<AGENT_PERSONA>p</AGENT_PERSONA>
`;
	assert.deepEqual(f.fieldGaps(c, "identity"), []);
});

test("fieldGaps returns [] for a non-tagged kind", () => {
	assert.deepEqual(f.fieldGaps("# X\n", "environments"), []);
});

test("resolveField matches tag / label / section (case-insensitive)", () => {
	assert.equal(f.resolveField("identity", "AGENT_NAME").tag, "AGENT_NAME");
	assert.equal(f.resolveField("identity", "Name").tag, "AGENT_NAME");
	assert.equal(f.resolveField("identity", "name").tag, "AGENT_NAME");
	assert.equal(
		f.resolveField("soul", "Motivations & goals").tag,
		"SOUL_MOTIVATIONS",
	);
	assert.equal(f.resolveField("user", "goals").tag, "USER_GOALS");
	assert.equal(f.resolveField("environments", "x"), null);
});
