// Skill authoring tests: create/validate/preview/test/run/lock/capture + gate
// single-sourcing + defaults verb merge.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import yamlMod from "yaml";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-skillauth-"));
process.env.AGENT_CLI_HOME = TMP;
process.env.SKILL_CLI_HOME = TMP; // paths.js prefers SKILL_CLI_HOME — isolate from any ambient value

const validateMod = await import("../src/skills/commands/validate.js");
const runMod = await import("../src/skills/commands/run.js");
const lockMod = await import("../src/skills/commands/lock.js");
const captureMod = await import("../src/skills/commands/capture.js");
const store = await import("../src/skills/lib/store.js");
const agentsMd = await import("../src/skills/lib/agents-md.js");
const gate = await import("../src/skills/lib/gate-policy.js");
const defaultsMod = await import("../src/skills/commands/defaults.js");
const skillConfig = await import("../src/skills/lib/config.js");

const GOOD = `---
name: demo
description: A demo skill
triggers: [/run, report]
version: 1.0.0
---

Do the thing.
`;

function tmpSkillDir(content = GOOD, { tool = false } = {}) {
	const d = mkdtempSync(path.join(tmpdir(), "agent-skill-auth-"));
	writeFileSync(path.join(d, "SKILL.md"), content);
	if (tool) {
		writeFileSync(
			path.join(d, "SKILL.tool.js"),
			`export async function run(argv = []) { return { ok: true, output: "ran:" + argv.join(",") } }`,
		);
	}
	return d;
}

test("validateSkill accepts a well-formed skill", () => {
	const v = validateMod.validateSkill(GOOD);
	assert.equal(v.ok, true);
	assert.equal(v.name, "demo");
	assert.equal(v.errors.length, 0);
	assert.deepEqual(v.triggers, ["run", "report"]);
});

test("validateSkill flags missing/invalid name and bad triggers", () => {
	const noName = validateMod.validateSkill("---\ndescription: x\n---\n\nbody\n");
	assert.equal(noName.ok, false);
	assert.ok(noName.errors.some((e) => e.includes("name")));

	const traversal = validateMod.validateSkill(
		"---\nname: ../evil\ndescription: x\n---\n\nbody\n",
	);
	assert.equal(traversal.ok, false);

	// Agent Skills spec: top-level triggers is an accepted extension, but each
	// portability warning fires alongside the trigger-quality warning.
	const badTrig = validateMod.validateSkill(
		"---\nname: a\ndescription: x\ntriggers: [has space]\n---\n\nbody\n",
	);
	assert.equal(badTrig.ok, true);
	assert.ok(badTrig.warnings.some((w) => w.includes("space")));
	assert.ok(badTrig.warnings.some((w) => w.includes("agent-cli extension")));
});

test("validateSkill errors on missing description (spec) and warns on missing body", () => {
	// The Agent Skills spec makes description REQUIRED — it was a warning
	// before the spec alignment. The missing body stays a warning.
	const v = validateMod.validateSkill("---\nname: a\n---\n\n");
	assert.equal(v.ok, false);
	assert.ok(v.errors.some((e) => e.includes("description")));
	assert.ok(v.warnings.some((w) => w.includes("body")));
});

test("validateSkill implements the Agent Skills spec name rules", () => {
	const mk = (name, dirName) =>
		validateMod.validateSkill(
			`---\nname: ${name}\ndescription: x\n---\n\nbody\n`,
			{ dirName },
		);
	assert.ok(mk("PDF-Processing").errors.some((e) => e.includes("lowercase")));
	assert.ok(mk("-pdf").errors.some((e) => e.includes("hyphen")));
	assert.ok(mk("pdf--processing").errors.some((e) => e.includes("consecutive")));
	assert.ok(mk("a".repeat(65)).errors.some((e) => e.includes("64")));
	assert.ok(
		mk("pdf_processing").errors.some((e) => e.includes("invalid characters")),
	);
	// spec: the name must match the parent directory (NFKC-normalized)
	assert.ok(
		mk("pdf-processing", "wrong-dir").errors.some((e) =>
			e.includes("must match"),
		),
	);
	assert.equal(mk("pdf-processing", "pdf-processing").errors.length, 0);
	// Deliberate deviation from skills-ref (which allows Unicode lowercase via
	// isalnum()): names are ASCII-only here because sanitizeSkillName doubles as
	// the path-traversal defense. A full-width "a" (U+FF41, NFKC-equivalent to
	// "a") is rejected, not normalized-and-accepted.
	const fw = validateMod.validateSkill(
		`---\nname: \uFF41\ndescription: x\n---\n\nbody\n`,
		{ dirName: "\uFF41" },
	);
	assert.ok(fw.errors.some((e) => e.includes("safe skill name")));
});

test("validateSkill enforces the spec closed allowlist and field limits", () => {
	const extra = validateMod.validateSkill(
		"---\nname: a\ndescription: x\nfoo: 1\nbar: 2\n---\n\nbody\n",
	);
	assert.equal(extra.ok, false);
	assert.ok(extra.errors.some((e) => e.includes("unexpected fields")));
	assert.ok(extra.errors.some((e) => e.includes("bar, foo")));
	// all six spec fields are accepted
	const spec = validateMod.validateSkill(
		[
			"---",
			"name: a",
			"description: x",
			"license: MIT",
			"allowed-tools: Read",
			"compatibility: Requires git",
			"metadata:",
			"  author: example",
			"---",
			"",
			"body",
			"",
		].join("\n"),
	);
	assert.equal(spec.ok, true);
	assert.deepEqual(spec.warnings, []);
	// compatibility > 500 chars → error
	const long = validateMod.validateSkill(
		`---\nname: a\ndescription: x\ncompatibility: ${"c".repeat(501)}\n---\n\nbody\n`,
	);
	assert.ok(long.errors.some((e) => e.includes("500")));
	// description > 1024 chars → error
	const longDesc = validateMod.validateSkill(
		`---\nname: a\ndescription: ${"d".repeat(1025)}\n---\n\nbody\n`,
	);
	assert.ok(longDesc.errors.some((e) => e.includes("1024")));
	// non-mapping metadata → error; non-string metadata values → warning
	const badMeta = validateMod.validateSkill(
		"---\nname: a\ndescription: x\nmetadata: [1,2]\n---\n\nbody\n",
	);
	assert.ok(badMeta.errors.some((e) => e.includes("metadata")));
	const nonStrMeta = validateMod.validateSkill(
		"---\nname: a\ndescription: x\nmetadata:\n  k: 3\n---\n\nbody\n",
	);
	assert.equal(nonStrMeta.ok, true);
	assert.ok(nonStrMeta.warnings.some((w) => w.includes("metadata value")));
});

test("spec extensions read dual-location: top-level legacy + metadata namespace", async () => {
	const fm = await import("../src/skills/lib/frontmatter.js");
	// legacy top-level
	assert.deepEqual(fm.getTriggers({ triggers: ["/Run", " report"] }), [
		"run",
		"report",
	]);
	assert.equal(fm.getVersion({ version: 1 }), "1");
	assert.equal(fm.getVersion({ version: "2.1.0" }), "2.1.0");
	// spec-conformant metadata namespace
	const specData = {
		metadata: {
			"agent-cli.triggers": "Research, /deep-work",
			"agent-cli.version": "1.0.0",
		},
	};
	assert.deepEqual(fm.getTriggers(specData), ["research", "deep-work"]);
	assert.equal(fm.getVersion(specData), "1.0.0");
	// top-level wins when both are present
	assert.equal(
		fm.getVersion({
			version: "3.0.0",
			metadata: { "agent-cli.version": "1.0.0" },
		}),
		"3.0.0",
	);
	// spec field readers
	assert.equal(fm.getLicense({ license: "MIT" }), "MIT");
	assert.equal(
		fm.getCompatibility({ compatibility: "Requires git" }),
		"Requires git",
	);
	assert.equal(
		fm.getAllowedTools({ "allowed-tools": "Bash(git:*) Read" }),
		"Bash(git:*) Read",
	);
	assert.deepEqual(fm.getMetadata({ metadata: { author: "x" } }), {
		author: "x",
	});
	assert.equal(fm.getMetadata({ metadata: "nope" }), null);
});

test("a spec-conformant skill carries its fields through the store listing", () => {
	// A pure Agent Skills skill (spec example shape) in the store: name,
	// description, license, compatibility, metadata — no agent-cli fields.
	const storeDir = path.join(TMP, ".skill-cli", "store", "pdf-processing");
	mkdirSync(storeDir, { recursive: true });
	writeFileSync(
		path.join(storeDir, "SKILL.md"),
		[
			"---",
			"name: pdf-processing",
			"description: Extract PDF text, fill forms, merge files. Use when handling PDFs.",
			"license: Apache-2.0",
			"compatibility: Requires Python 3.14+ and uv",
			"metadata:",
			"  author: example-org",
			'  version: "1.0"',
			"---",
			"",
			"Body.",
			"",
		].join("\n"),
	);
	const hit = store.listStore().find((s) => s.dir === "pdf-processing");
	assert.ok(hit, "spec skill listed");
	assert.equal(hit.license, "Apache-2.0");
	assert.equal(hit.compatibility, "Requires Python 3.14+ and uv");
	assert.equal(hit.version, "-");
	assert.deepEqual(hit.triggers, []);
	// and it validates clean under the full spec rules
	const v = validateMod.validateSkill(
		readFileSync(path.join(storeDir, "SKILL.md"), "utf8"),
		{ dirName: "pdf-processing" },
	);
	assert.equal(v.ok, true);
	assert.deepEqual(v.warnings, []);
	rmSync(storeDir, { recursive: true, force: true });
});

test("checkToolImports enforces the allowlist", () => {
	assert.equal(
		runMod.checkToolImports(
			`import fs from "node:fs"\nexport async function run(){return {ok:true}}`,
		).ok,
		true,
	);
	assert.equal(
		runMod.checkToolImports(`import { exec } from "node:child_process"\n`).ok,
		false,
	);
	assert.equal(
		runMod.checkToolImports(`import http from "node:http"\n`).ok,
		false,
	);
	assert.equal(
		runMod.checkToolImports(`import path from "node:path"\n`).ok,
		true,
	);
});

test("runSkillTool executes a tool module and returns its result", async () => {
	const d = tmpSkillDir(GOOD, { tool: true });
	const r = await runMod.runSkillTool(path.join(d, "SKILL.tool.js"), ["a", "b"]);
	assert.equal(r.ok, true);
	assert.equal(r.output, "ran:a,b");
});

test("runSkillTool rejects a module without run()", async () => {
	const d = tmpSkillDir(GOOD);
	writeFileSync(path.join(d, "SKILL.tool.js"), "export const x = 1\n");
	await assert.rejects(
		() => runMod.runSkillTool(path.join(d, "SKILL.tool.js")),
		/export a `run/,
	);
});

test("writeLock/readLock record source + content hash; hash changes with content", () => {
	const d = tmpSkillDir(GOOD);
	const lock = lockMod.writeLock(d, "owner/repo");
	assert.equal(lock.source, "owner/repo");
	assert.ok(lock.contentHash);
	assert.ok(lock.installedAt);
	const read = lockMod.readLock("__notinstalled__");
	assert.equal(read, null);
	// contentHash is deterministic for the same SKILL.md
	const lock2 = lockMod.writeLock(d, "owner/repo");
	assert.equal(lock.contentHash, lock2.contentHash);
	// hash changes when content changes
	writeFileSync(path.join(d, "SKILL.md"), `${GOOD}\nmore\n`);
	const lock3 = lockMod.writeLock(d, "owner/repo");
	assert.notEqual(lock.contentHash, lock3.contentHash);
});

test("capture appends a lesson; skillLessons reads it", () => {
	const d = tmpSkillDir(GOOD);
	captureMod.cmdCapture([d, "always", "validate", "first"]);
	const lessons = captureMod.skillLessons(d);
	assert.ok(lessons.some((l) => l.includes("always validate first")));
	const md = readFileSync(path.join(d, "SKILL.md"), "utf8");
	assert.ok(md.includes("## Lessons"));
});

test("AGENTS_BLOCK is single-sourced from gate-policy", () => {
	// The injected bootstrap block embeds the shared policy — no drift.
	assert.ok(
		agentsMd.AGENTS_BLOCK.includes(gate.GATE_POLICY_TEXT.trim().slice(0, 40)),
	);
	assert.ok(gate.GATE_POLICY_TEXT.includes("START GATE (mandatory)"));
	assert.ok(gate.GATE_DECIDE_HINT.includes("PROPOSE"));
	// cmdActive renders from the shared hint, not its own copy.
	const src = readFileSync(
		new URL("../src/skills/commands/defaults.js", import.meta.url),
		"utf8",
	);
	assert.ok(src.includes("GATE_DECIDE_HINT"));
	assert.ok(
		!/→ For EACH skill above, decide in your reply:\n/.test(
			src.replace(/GATE_DECIDE_HINT/g, ""),
		),
	);
});

test("cmdDefaults lists global defaults via computeDefaults (verb merge)", () => {
	// `skill defaults` (plural) is distinct from `skill active` and lists the
	// global default set. Verify it uses computeDefaults and prints an entry.
	const cfg = { ...skillConfig.readGlobalConfig() };
	cfg.defaults = ["demo"];
	const cfgPath = path.join(TMP, ".skill-cli", "config.yaml");
	mkdirSync(path.dirname(cfgPath), { recursive: true });
	writeFileSync(cfgPath, yamlMod.stringify(cfg));
	// install "demo" into the store so computeDefaults can resolve it
	const storeDir = path.join(TMP, ".skill-cli", "store");
	mkdirSync(path.join(storeDir, "demo"), { recursive: true });
	writeFileSync(path.join(storeDir, "demo", "SKILL.md"), GOOD);
	// capture stdout
	const logs = [];
	const orig = console.log;
	console.log = (...a) => logs.push(a.join(" "));
	defaultsMod.cmdDefaults();
	console.log = orig;
	assert.ok(logs.some((l) => l.includes("demo")));
	assert.ok(logs.some((l) => l.includes("undefault")));
	assert.ok(!logs.some((l) => l.includes("No default skills")));
});

test("cmdShow surfaces the Agent Skills spec fields + metadata-located extensions", async () => {
	const showMod = await import("../src/skills/commands/show.js");
	// a fully spec-conformant skill whose agent-cli extensions live under
	// metadata — show must surface license/compatibility AND the triggers
	// (dual-location read) + version from the metadata namespace.
	const dir = path.join(TMP, ".skill-cli", "store", "spec-demo");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, "SKILL.md"),
		[
			"---",
			"name: spec-demo",
			"description: Demonstrates spec field display.",
			"license: Apache-2.0",
			"compatibility: Requires git and node",
			"metadata:",
			'  agent-cli.triggers: "research, deep-work"',
			'  agent-cli.version: "2.1.0"',
			"---",
			"",
			"Body.",
			"",
		].join("\n"),
	);
	const logs = [];
	const orig = console.log;
	console.log = (...a) => logs.push(a.join(" "));
	try {
		showMod.cmdShow(["spec-demo"]);
	} finally {
		console.log = orig;
	}
	const out = logs.join("\n");
	assert.ok(out.includes("v2.1.0"), out);
	assert.ok(out.includes("Apache-2.0"), out);
	assert.ok(out.includes("Requires git and node"), out);
	assert.ok(out.includes("/research, /deep-work"), out);
});

test("planMigrate moves legacy extensions into the metadata namespace", async () => {
	const migrateMod = await import("../src/skills/commands/migrate.js");
	const legacy = [
		"---",
		"name: demo",
		"description: Demo skill",
		"license: MIT",
		"triggers: [/Run, report]",
		"version: 2.0.0",
		"---",
		"",
		"Body stays verbatim.",
		"",
	].join("\n");
	const plan = migrateMod.planMigrate(legacy);
	assert.equal(plan.needs, true);
	assert.ok(plan.moves.some((m) => m.includes("run, report")));
	assert.ok(plan.moves.some((m) => m.includes("2.0.0")));
	// top-level extensions gone; everything else + body preserved
	const fm = (await import("../src/skills/lib/frontmatter.js")).parseSkillMd(
		plan.next,
	);
	assert.equal(fm.data.triggers, undefined);
	assert.equal(fm.data.version, undefined);
	assert.equal(fm.data.name, "demo");
	assert.equal(fm.data.description, "Demo skill");
	assert.equal(fm.data.license, "MIT");
	assert.ok(fm.body.includes("Body stays verbatim."));
	// the migrated values read back through the dual-location readers
	const fmr = await import("../src/skills/lib/frontmatter.js");
	assert.deepEqual(fmr.getTriggers(fm.data), ["run", "report"]);
	assert.equal(fmr.getVersion(fm.data), "2.0.0");
	// existing metadata is MERGED, not clobbered
	const withMeta = [
		"---",
		"name: demo",
		"description: Demo",
		"metadata:",
		"  author: example-org",
		"version: 1.0.0",
		"---",
		"",
		"Body.",
		"",
	].join("\n");
	const plan2 = migrateMod.planMigrate(withMeta);
	const fm2 = (await import("../src/skills/lib/frontmatter.js")).parseSkillMd(
		plan2.next,
	);
	assert.equal(fm2.data.metadata["author"], "example-org");
	assert.equal(fm2.data.metadata["agent-cli.version"], "1.0.0");
});

test("planMigrate: empty triggers dropped, conformant/malformed are no-ops", async () => {
	const migrateMod = await import("../src/skills/commands/migrate.js");
	const empty = "---\nname: a\ndescription: x\ntriggers: []\n---\n\nbody\n";
	const plan = migrateMod.planMigrate(empty);
	assert.equal(plan.needs, true);
	assert.ok(plan.moves.some((m) => m.includes("dropped")));
	assert.ok(!plan.next.includes("agent-cli.triggers"));
	const conformant = "---\nname: a\ndescription: x\n---\n\nbody\n";
	assert.equal(migrateMod.planMigrate(conformant).needs, false);
	const broken = "---\nname: [unclosed\n---\n\nbody\n";
	const plan3 = migrateMod.planMigrate(broken);
	assert.equal(plan3.needs, false);
	assert.ok(plan3.parseError);
});
