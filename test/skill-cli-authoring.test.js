// Subprocess tests for the skill sub-CLI authoring commands + verb merge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_CLI = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"skills",
	"cli.js",
);
const TMP = mkdtempSync(path.join(tmpdir(), "agent-skillcli-auth-"));
const WORK = mkdtempSync(path.join(tmpdir(), "agent-skillcli-work-"));

function run(args, { cwd = WORK, env = {} } = {}) {
	const r = spawnSync(process.execPath, [SKILL_CLI, ...args], {
		encoding: "utf8",
		cwd,
		env: { ...process.env, SKILL_CLI_HOME: TMP, ...env },
	});
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("create scaffolds a skill; validate/test/run pass; capture + lock work", async () => {
	const c = run(["create", "demo", "--tool", "--desc", "Demo skill"]);
	assert.equal(c.status, 0);
	const skillDir = path.join(WORK, "demo");
	assert.ok(existsSync(path.join(skillDir, "SKILL.md")));
	assert.ok(existsSync(path.join(skillDir, "SKILL.tool.js")));

	const v = run(["validate", "demo"]);
	assert.equal(v.status, 0);
	assert.ok(v.stdout.includes("valid"));

	// an invalid skill fails validation
	await import("node:fs").then((fs) =>
		fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\ndescription: no name\n---\n\nbody\n"),
	);
	const bad = run(["validate", "demo"]);
	assert.equal(bad.status, 1);

	// restore a valid SKILL.md
	await import("node:fs").then((fs) =>
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			"---\nname: demo\ndescription: Demo skill\nversion: 1.0.0\n---\n\nBody.\n",
		),
	);

	const t = run(["test", "demo"]);
	assert.equal(t.status, 0);
	assert.ok(t.stdout.includes("PASS"));

	const r = run(["run", "demo", "--", "hello"]);
	assert.equal(r.status, 0);
	assert.ok(r.stdout.includes("hello"));

	const cap = run(["capture", "demo", "always", "validate", "first"]);
	assert.equal(cap.status, 0);
	assert.ok(readFileSync(path.join(skillDir, "SKILL.md"), "utf8").includes("## Lessons"));

	const lock = run(["lock", "demo", "--source", "owner/repo"]);
	assert.equal(lock.status, 0);
	assert.ok(existsSync(path.join(skillDir, "skill.lock")));
	assert.ok(readFileSync(path.join(skillDir, "skill.lock"), "utf8").includes("owner/repo"));

	// install (non-TTY → no enable prompt) writes a lock too
	const inst = run(["install", skillDir]);
	assert.equal(inst.status, 0);
	assert.ok(!inst.stdout.includes("Enable")); // non-TTY: prompt skipped
	const storeLock = path.join(TMP, ".skill-cli", "store", "demo", "skill.lock");
	assert.ok(existsSync(storeLock));
});

test("defaults (plural) lists defaults; enable -g marks one; active is separate", () => {
	run(["install", path.join(WORK, "demo")]);
	const d0 = run(["defaults"]);
	assert.ok(d0.stdout.includes("No default skills"));
	run(["default", "demo"]);
	const d = run(["defaults"]);
	assert.equal(d.status, 0);
	assert.ok(d.stdout.includes("demo"));
	assert.ok(!d.stdout.includes("No default skills"));
	const active = run(["active"]);
	assert.equal(active.status, 0);
	assert.ok(active.stdout.includes("demo"));
	// `defaults` output mentions undefault (its management verb) — distinct from active
	assert.ok(d.stdout.includes("undefault"));
});

test("create scaffolds Agent Skills spec-conformant frontmatter", () => {
	const c = run(["create", "pdf-processing", "--desc", "Handle PDFs"]);
	assert.equal(c.status, 0);
	const md = readFileSync(path.join(WORK, "pdf-processing", "SKILL.md"), "utf8");
	// spec fields present…
	assert.match(md, /^name: pdf-processing$/m);
	assert.match(md, /^description: Handle PDFs$/m);
	assert.match(md, /^license: MIT$/m);
	// …extension version under the metadata namespace…
	assert.match(md, /^  agent-cli\.version: "1\.0\.0"$/m);
	// …and NO legacy top-level extension fields.
	assert.doesNotMatch(md, /^triggers:/m);
	assert.doesNotMatch(md, /^version:/m);
	// the scaffold validates clean under the full spec rules — zero warnings
	const v = run(["validate", "pdf-processing"]);
	assert.equal(v.status, 0);
	assert.ok(v.stdout.includes("valid"));
	assert.ok(!v.stdout.includes("⚠"), v.stdout);
});

test("create rejects names the Agent Skills spec forbids", () => {
	for (const bad of ["PDF-Processing", "pdf_processing", "a--b", "x".repeat(65)]) {
		const r = run(["create", bad]);
		assert.notEqual(r.status, 0, `create ${bad} should fail`);
		assert.ok(r.stderr.includes("Agent Skills spec"), r.stderr);
	}
	// store-side legacy names keep working — only the scaffold is strict
	assert.equal(run(["create", "pdf-processing-2"]).status, 0);
});
