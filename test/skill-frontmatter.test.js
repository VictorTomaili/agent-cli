// GAP-6 + GAP-15 regression tests: untrusted SKILL.md frontmatter must never
// crash display paths (non-string name/description/version) and YAML parse
// errors must surface (bounded) instead of silently becoming empty fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Isolated store: env homes must be set BEFORE the skill modules are imported
// (paths.js resolves STORE_DIR at module load).
const TMP = mkdtempSync(path.join(tmpdir(), "agent-skill-fm-"));
process.env.AGENT_CLI_HOME = TMP;
process.env.SKILL_CLI_HOME = TMP;

const frontmatter = await import("../src/skills/lib/frontmatter.js");
const store = await import("../src/skills/lib/store.js");
const { validateSkill } = await import("../src/skills/commands/validate.js");
const paths = await import("../src/skills/lib/paths.js");

const SKILL_CLI = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"skills",
	"cli.js",
);

const STORE_DIR = paths.STORE_DIR;

function plant(dir, md) {
	const d = path.join(STORE_DIR, dir);
	mkdirSync(d, { recursive: true });
	writeFileSync(path.join(d, "SKILL.md"), md);
	return d;
}

function run(args) {
	const r = spawnSync(process.execPath, [SKILL_CLI, ...args], {
		encoding: "utf8",
		cwd: TMP,
		env: { ...process.env, SKILL_CLI_HOME: TMP, AGENT_CLI_HOME: TMP },
	});
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---- parseSkillMd: parse errors surface (GAP-15) -----------------------------

test("parseSkillMd: malformed YAML sets parseError, keeps body, data = {}", () => {
	const md = "---\nname: [unclosed\n  bad: yaml: here:\n---\n\nbody text\n";
	const { data, body, parseError } = frontmatter.parseSkillMd(md);
	assert.ok(parseError && parseError.length > 0, "parseError must be non-empty");
	assert.ok(typeof parseError === "string");
	assert.deepEqual(data, {});
	// pre-existing body semantics: the blank separator line stays with the body
	assert.equal(body, "\nbody text\n");
});

test("parseSkillMd: non-mapping frontmatter (array/scalar/null) sets parseError", () => {
	for (const fm of ["---\n[1, 2]\n---\n\nb", "---\n42\n---\n\nb"]) {
		const { data, parseError } = frontmatter.parseSkillMd(fm);
		assert.ok(parseError, `expected parseError for frontmatter ${fm}`);
		assert.deepEqual(data, {});
	}
});

test("parseSkillMd: valid frontmatter → parseError null; BOM stripped", () => {
	const md = "\uFEFF---\nname: ok\ndescription: fine\n---\n\nbody";
	const { data, body, parseError } = frontmatter.parseSkillMd(md);
	assert.equal(parseError, null);
	assert.equal(data.name, "ok");
	assert.equal(body, "\nbody");
});

test("parseSkillMd: parse error is bounded (≤ ~200 chars)", () => {
	const huge = "---\nname: [\n" + "x".repeat(50_000) + "\n---\n\nb";
	const { parseError } = frontmatter.parseSkillMd(huge);
	assert.ok(parseError.length <= 220, `parseError not bounded: ${parseError.length}`);
});

// ---- stringField (GAP-6) ------------------------------------------------------

test("stringField: only real non-empty strings pass; everything else falls back", () => {
	assert.equal(frontmatter.stringField("ok"), "ok");
	assert.equal(frontmatter.stringField("  ", "fb"), "fb", "blank-only string rejects");
	assert.equal(frontmatter.stringField(42, "fb"), "fb", "number rejects");
	assert.equal(frontmatter.stringField(0, "fb"), "fb");
	assert.equal(frontmatter.stringField({ a: 1 }, "fb"), "fb", "object rejects");
	assert.equal(frontmatter.stringField(["x"], "fb"), "fb", "array rejects");
	assert.equal(frontmatter.stringField(true, "fb"), "fb");
	assert.equal(frontmatter.stringField(null, "fb"), "fb");
	assert.equal(frontmatter.stringField(undefined, "fb"), "fb");
});

// ---- listStore/readSkill read boundary (GAP-6) -------------------------------

test("GAP-6: numeric/object frontmatter fields never surface from listStore", () => {
	plant("numname", "---\nname: 42\ndescription: 7\nversion: true\n---\n\nbody\n");
	plant("objdesc", "---\nname: objdesc\ndescription:\n  nested: object\nversion: [1]\n---\n\nbody\n");
	const list = store.listStore();
	const num = list.find((s) => s.dir === "numname");
	assert.ok(num, "numname listed");
	assert.equal(num.name, "numname", "numeric name falls back to dir name");
	assert.equal(typeof num.name, "string");
	assert.equal(num.description, "", "numeric description rejects to empty");
	assert.equal(num.version, "-", "boolean version rejects to '-'");
	const obj = list.find((s) => s.dir === "objdesc");
	assert.ok(obj, "objdesc listed");
	assert.equal(obj.description, "", "object description rejects to empty");
	assert.equal(obj.version, "-", "array version rejects to '-'");
	// the whole list must stay sortable (localeCompare on strings only)
	assert.doesNotThrow(() => store.listStore());
});

test("GAP-6: readSkill coerces a numeric name to a safe string", () => {
	plant("readnum", "---\nname: 42\n---\n\nbody\n");
	const s = store.readSkill("readnum");
	assert.ok(s, "readSkill resolves by dir");
	assert.equal(typeof s.name, "string");
	assert.equal(s.name, "readnum");
});

// ---- GAP-15 surfacing at the display paths ------------------------------------

test("GAP-15: listStore carries parseError; skill list exits 0 and shows it", () => {
	plant("badyaml", "---\nname: [broken\n---\n\nbody\n");
	const list = store.listStore();
	const bad = list.find((s) => s.dir === "badyaml");
	assert.ok(bad, "badyaml still listed");
	assert.ok(bad.parseError, "entry carries parseError");
	assert.equal(bad.name, "badyaml", "falls back to dir name");
	// CLI-level: the whole listing must not crash and must surface the marker
	const r = run(["list"]);
	assert.equal(r.status, 0, `skill list crashed or failed: ${r.stderr}`);
	assert.match(r.stdout, /frontmatter/);
});

test("GAP-15: skill show surfaces the parse error instead of empty silence", () => {
	plant("showbad", "---\nname: [broken\n---\n\nbody\n");
	const r = run(["show", "showbad"]);
	assert.equal(r.status, 0);
	assert.match(r.stdout, /parse error/);
});

test("GAP-15: validate reports the YAML root cause, not a misleading cascade", () => {
	const v = validateSkill("---\nname: [broken\n---\n\nbody\n");
	assert.equal(v.ok, false);
	assert.ok(
		v.errors.some((e) => e.includes("not valid YAML")),
		`expected YAML root-cause error, got: ${v.errors.join(" | ")}`,
	);
});

test("valid skills keep validating clean (no false positives from the new guard)", () => {
	const v = validateSkill(
		"---\nname: good-skill\ndescription: works\nversion: 1.2.3\n---\n\nbody\n",
	);
	assert.equal(v.ok, true);
	assert.deepEqual(v.errors, []);
});
