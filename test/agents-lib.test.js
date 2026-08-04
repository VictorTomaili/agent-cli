import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate HOME so validateAgent's config read + global agents dir are deterministic.
// MUST be set before importing agents-lib (HOME/GLOBAL_AGENTS_DIR are captured at import).
const HOME_TMP = mkdtempSync(path.join(tmpdir(), "agent-ag-home-"));
process.env.AGENT_CLI_HOME = HOME_TMP;

const agents = await import("../src/agents-lib.js");

const VALID_BODY =
	"## Delegation identity\nd\n## Goal\ng\n## Orchestrator contract\no\n## Role\nr\n## When to use\nw\n## Requires\nreq\n## Output style & format\no\n## Constraints\nc\n## Handoff\nh\n";
function writeConfigWithAlias(alias) {
	mkdirSync(path.join(HOME_TMP, ".agents"), { recursive: true });
	writeFileSync(
		path.join(HOME_TMP, ".agents", "config.json"),
		JSON.stringify({ models: { aliases: { [alias]: { model: "p/m" } } } }),
	);
}
function writeAgent(name, frontmatter, body) {
	const dir = path.join(HOME_TMP, ".agents", "agents");
	mkdirSync(dir, { recursive: true });
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
	const fp = path.join(dir, `${name}.md`);
	writeFileSync(fp, `---\n${fm}\n---\n${body}`);
	return fp;
}

test("isFilled: false for empty/template, true for real content", () => {
	assert.equal(agents.isFilled(""), false);
	assert.equal(agents.isFilled("# X\n\n## Role\n(your chosen name)\n"), false);
	assert.equal(
		agents.isFilled(
			"# X\n\n## Role\nA scout agent that reads code and returns structured findings about modules and their public interfaces.",
		),
		true,
	);
});

test("scaffoldAgent + listAgents + validateAgent (project scope, isolated cwd)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-cwd-"));
	const r = await agents.scaffoldAgent("tester", { scope: "project", cwd });
	assert.equal(r.created, true);
	const list = (await agents.listAgents({ includeProject: true, cwd })).filter(
		(a) => a.scope === "project",
	);
	assert.ok(list.find((a) => a.name === "tester"));
	// fresh scaffold still has placeholders → invalid
	const v = await agents.validateAgent(r.path);
	assert.equal(v.valid, false);
	assert.ok(v.issues.length > 0);
});

test("scaffoldAgent rejects traversal names", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-traversal-"));
	await assert.rejects(
		() => agents.scaffoldAgent("../../../outside", { scope: "project", cwd }),
		/agent name must be a simple filename/,
	);
});

test("project personality overrides global personality with the same name", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-override-"));
	await agents.scaffoldAgent("same", { scope: "global", cwd });
	await agents.scaffoldAgent("same", { scope: "project", cwd });
	const effective = await agents.showAgent("same", { cwd });
	assert.equal(effective.scope, "project");
});

test("listAgents dedupes by name with the project entry winning (no duplicates)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-dedupe-"));
	await agents.scaffoldAgent("same", { scope: "global", cwd });
	await agents.scaffoldAgent("same", { scope: "project", cwd });
	await agents.scaffoldAgent("only-global", { scope: "global", cwd });
	const list = await agents.listAgents({ includeProject: true, cwd });
	const same = list.filter((a) => a.name === "same");
	assert.equal(same.length, 1);
	assert.equal(same[0].scope, "project"); // project wins
	const only = list.filter((a) => a.name === "only-global");
	assert.equal(only.length, 1);
	assert.equal(only[0].scope, "global");
});

test("identityInventory runs in project scope", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-inv-"));
	const inv = await agents.identityInventory({ scope: "project", cwd });
	assert.equal(inv.scope, "project");
	assert.ok(inv.files.length >= 5);
});

test("identityInventory flags an unfilled IDENTITY.md (project scope)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-id-"));
	const agentsDir = path.join(cwd, ".agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		path.join(agentsDir, "IDENTITY.md"),
		"# IDENTITY.md\n\n## Name\n(your chosen name)\n\n## Role\nreal role text here\n",
	);
	const inv = await agents.identityInventory({ scope: "project", cwd });
	const id = inv.files.find((f) => f.kind === "identity");
	assert.equal(id.filled, false);
});

test("isFilled is tag-aware: empty AGENT_NAME tag = unfilled", () => {
	const unfilled =
		"# IDENTITY.md\n<AGENT_NAME></AGENT_NAME>\n<AGENT_ROLE>r</AGENT_ROLE>\n<AGENT_MISSION>m</AGENT_MISSION>\n<AGENT_PERSONA>p</AGENT_PERSONA>\n";
	assert.equal(agents.isFilled(unfilled, "identity"), false);
	const filled = unfilled.replace(
		"<AGENT_NAME></AGENT_NAME>",
		"<AGENT_NAME>Marvin</AGENT_NAME>",
	);
	assert.equal(agents.isFilled(filled, "identity"), true);
});

test("computeOnboarding: archetypeNeeded when an archetype field is missing", () => {
	const inv = {
		files: [
			{ kind: "identity", exists: true, gaps: ["AGENT_NAME", "AGENT_ROLE"] },
			{ kind: "user", exists: true, gaps: ["USER_GOALS"] },
			{ kind: "soul", exists: true, gaps: [] },
		],
	};
	const r = agents.computeOnboarding(inv);
	assert.equal(r.archetypeNeeded, true);
	assert.equal(r.gapRecommended, true);
	assert.deepEqual(r.gapReport, {
		identity: ["AGENT_NAME", "AGENT_ROLE"],
		user: ["USER_GOALS"],
	});
});

test("computeOnboarding: not archetypeNeeded when only the name is missing", () => {
	const r = agents.computeOnboarding({
		files: [{ kind: "identity", exists: true, gaps: ["AGENT_NAME"] }],
	});
	assert.equal(r.archetypeNeeded, false);
	assert.equal(r.gapRecommended, true);
});

test("computeOnboarding: archetypeNeeded when IDENTITY.md is absent", () => {
	const r = agents.computeOnboarding({
		files: [{ kind: "identity", exists: false, gaps: null }],
	});
	assert.equal(r.archetypeNeeded, true);
	assert.equal(r.gapRecommended, true);
});

test("computeOnboarding: nothing recommended when there are no gaps", () => {
	const r = agents.computeOnboarding({
		files: [{ kind: "identity", exists: true, gaps: [] }],
	});
	assert.equal(r.archetypeNeeded, false);
	assert.equal(r.gapRecommended, false);
	assert.deepEqual(r.gapReport, {});
});

test("parseFrontmatter: no frontmatter → empty fm, body as-is", () => {
	const { frontmatter, body } = agents.parseFrontmatter("# hi\n\nbody");
	assert.deepEqual(frontmatter, {});
	assert.equal(body, "# hi\n\nbody");
});

test("parseFrontmatter: reads keys; ignores colon-less / leading-colon lines", () => {
	const { frontmatter } = agents.parseFrontmatter(
		"---\nname: x\nbadline\n: leading\ntools: a, b\n---\nbody",
	);
	assert.equal(frontmatter.name, "x");
	assert.equal(frontmatter.tools, "a, b");
	assert.ok(!frontmatter.badline);
	assert.ok(!frontmatter[""]);
});

test("agentTemplate includes the name and all required sections", () => {
	const t = agents.agentTemplate("test-writer");
	assert.ok(t.includes("name: test-writer"));
	for (const sec of [
		"## Delegation identity",
		"## Goal",
		"## Orchestrator contract",
		"## Role",
		"## When to use",
		"## Requires",
		"## Output style",
		"## Constraints",
		"## Handoff",
	])
		assert.ok(t.includes(sec), `missing ${sec}`);
});

test("showAgent returns the agent by name or null", async () => {
	writeAgent("finder", { name: "finder", description: "d" }, VALID_BODY);
	const a = await agents.showAgent("finder");
	assert.ok(a);
	assert.equal(a.name, "finder");
	assert.equal(await agents.showAgent("does-not-exist"), null);
});

test("validateAgent: a complete agent is valid", async () => {
	writeConfigWithAlias("fast-model");
	const fp = writeAgent(
		"good",
		{ name: "good", description: "d", model: "fast-model" },
		VALID_BODY,
	);
	const v = await agents.validateAgent(fp);
	assert.equal(v.valid, true, v.issues.join("; "));
});

test("validateAgent: concrete provider/model accepted without config", async () => {
	const fp = writeAgent(
		"conc",
		{ name: "conc", description: "d", model: "openai/gpt-5" },
		VALID_BODY,
	);
	const v = await agents.validateAgent(fp);
	assert.equal(v.valid, true);
});

test("validateAgent: missing name + description are flagged", async () => {
	const fp = writeAgent("noname", {}, VALID_BODY);
	const v = await agents.validateAgent(fp);
	assert.equal(v.valid, false);
	assert.ok(v.issues.some((i) => i.includes("missing name")));
	assert.ok(v.issues.some((i) => i.includes("missing description")));
});

test("validateAgent: unknown model alias is a warning, not a structural failure", async () => {
	const fp = writeAgent(
		"badmodel",
		{ name: "bm", description: "d", model: "bogus-model" },
		VALID_BODY,
	);
	const v = await agents.validateAgent(fp);
	assert.equal(v.valid, true);
	assert.ok(v.warnings.some((i) => i.includes("unresolved")));
});

test("validateAgent: template placeholders in the body are flagged", async () => {
	const body =
		"## Role\n<one sentence>\n## When to use\nw\n## Requires\nr\n## Output style & format\no\n## Constraints\nc\n";
	const fp = writeAgent("placeholder", { name: "p", description: "d" }, body);
	const v = await agents.validateAgent(fp);
	assert.equal(v.valid, false);
	assert.ok(v.issues.some((i) => i.includes("placeholder")));
});

test("validateAgent: a missing required section is flagged", async () => {
	const body =
		"## Role\nr\n## When to use\nw\n## Requires\nreq\n## Output style & format\no\n";
	const fp = writeAgent("nosec", { name: "n", description: "d" }, body);
	const v = await agents.validateAgent(fp);
	assert.equal(v.valid, false);
	assert.ok(v.issues.some((i) => i.includes("## Constraints")));
});

test("validateAgent: missing file → valid:false", async () => {
	const v = await agents.validateAgent(path.join(HOME_TMP, "nope.md"));
	assert.equal(v.valid, false);
	assert.deepEqual(v.issues, ["file missing"]);
});

test("identityInventory reports per-field gaps for tagged files", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-gaps-"));
	const agentsDir = path.join(cwd, ".agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		path.join(agentsDir, "IDENTITY.md"),
		"# ID\n<AGENT_NAME></AGENT_NAME>\n<AGENT_ROLE>r</AGENT_ROLE>\n<AGENT_MISSION>m</AGENT_MISSION>\n<AGENT_PERSONA>p</AGENT_PERSONA>\n",
	);
	writeFileSync(
		path.join(agentsDir, "USER.md"),
		"# U\n<USER_PREFS>p</USER_PREFS>\n<USER_GOALS></USER_GOALS>\n<USER_CONTEXT></USER_CONTEXT>\n",
	);
	const inv = await agents.identityInventory({ scope: "project", cwd });
	const id = inv.files.find((f) => f.kind === "identity");
	const user = inv.files.find((f) => f.kind === "user");
	assert.deepEqual(id.gaps, ["AGENT_NAME"]);
	assert.deepEqual(user.gaps, ["USER_GOALS", "USER_CONTEXT"]);
});
