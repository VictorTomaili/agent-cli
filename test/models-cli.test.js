// CLI-level tests for `models lint|usage|test` and the composite commands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const TMP = mkdtempSync(path.join(tmpdir(), "agent-modelscli-"));

function run(args, { home = TMP, cwd = process.cwd() } = {}) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		env: { ...process.env, AGENT_CLI_HOME: home, AGENT_OFFLINE: "1" },
		cwd,
	});
	let parsed = null;
	try { parsed = JSON.parse(r.stdout); } catch { /* non-JSON */ }
	return { status: r.status, parsed, stdout: r.stdout, stderr: r.stderr };
}

test("init then models lint/usage/test emit the envelope", () => {
	run(["init"]);
	// seed an alias + an agent that uses it
	run(["models", "set", "gpt", "openai/gpt-4o"]);
	mkdirSync(path.join(TMP, ".agents", "agents"), { recursive: true });
	writeFileSync(
		path.join(TMP, ".agents", "agents", "coder.md"),
		"---\nname: coder\nmodel: gpt\n---\n\nA coder agent.\n",
	);

	const lint = run(["models", "lint", "--json"]);
	assert.equal(lint.status, 0);
	assert.equal(lint.parsed.ok, true);
	assert.equal(lint.parsed.command, "models");
	assert.equal(lint.parsed.data.action, "lint");
	assert.ok(Array.isArray(lint.parsed.data.unresolved));
	assert.ok(Array.isArray(lint.parsed.data.unused));

	const usage = run(["models", "usage", "--json"]);
	assert.equal(usage.parsed.ok, true);
	assert.equal(usage.parsed.data.action, "usage");
	const gpt = usage.parsed.data.aliases.find((a) => a.alias === "gpt");
	assert.ok(gpt);
	assert.deepEqual(gpt.usedBy, ["coder"]);

	const t = run(["models", "test", "gpt", "--json"]);
	assert.equal(t.parsed.ok, true);
	assert.equal(t.parsed.data.valid, true);
	assert.equal(t.parsed.data.model, "openai/gpt-4o");

	const missing = run(["models", "test", "nope", "--json"]);
	assert.equal(missing.status, 1);
	assert.equal(missing.parsed.ok, false);
});

test("project init/detect + archetype export work standalone", () => {
	const proj = mkdtempSync(path.join(tmpdir(), "agent-proj-"));
	mkdirSync(proj, { recursive: true });
	const init = run(["project", "init", "--json"], { cwd: proj });
	assert.equal(init.parsed.ok, true);
	assert.ok(init.parsed.data.created.length >= 1);
	const detect = run(["project", "detect", "--json"], { cwd: proj });
	assert.equal(detect.parsed.ok, true);
	assert.ok(detect.parsed.data.name);
	const exp = run(["archetype", "export", "general-purpose", "--json"], { home: TMP });
	assert.equal(exp.parsed.ok, true);
	assert.ok(exp.parsed.data.content.includes("# IDENTITY.md"));
});

test("models rm deletes an alias, syncs MODELS.md, and 404s on an unknown one", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-modelsrm-"));
	run(["init"], { home });
	run(["models", "set", "keep-model", "openai/a"], { home });
	run(["models", "set", "drop-model", "openai/b"], { home });

	const rm = run(["models", "rm", "drop-model", "--json"], { home });
	assert.equal(rm.parsed.ok, true);
	assert.equal(rm.parsed.data.action, "rm");
	assert.equal(rm.parsed.data.removed.model, "openai/b");

	// `init` seeds its own default aliases, so assert on the two this test owns
	// rather than on the whole key set.
	const after = Object.keys(run(["models", "list", "--json"], { home }).parsed.data.aliases);
	assert.ok(after.includes("keep-model"));
	assert.ok(!after.includes("drop-model"));

	// MODELS.md is regenerated, so the removed alias is gone from the doc too
	const md = readFileSync(path.join(home, ".agents", "MODELS.md"), "utf8");
	assert.ok(md.includes("keep-model"));
	assert.ok(!md.includes("drop-model"));

	const missing = run(["models", "rm", "drop-model", "--json"], { home });
	assert.equal(missing.status, 1);
	assert.equal(missing.parsed.ok, false);
});

// The pre-P11 cleanup case: names like `smart-model <!-- why -->` that `models
// set` refuses to write but that already sit in config.json. Two argv shapes
// have to reach removeAlias intact — the quoted one, and the `--` one for a
// shell that splits the name into tokens (`-->` would otherwise parse as an
// option).
const MALFORMED = "smart-model <!-- reasoning matters -->";

function seedMalformed(home) {
	run(["init"], { home });
	const cfg = path.join(home, ".agents", "config.json");
	const parsed = JSON.parse(readFileSync(cfg, "utf8"));
	parsed.models = {
		aliases: {
			"good-model": { category: "coding", model: "openai/a" },
			[MALFORMED]: { category: "smart", model: "openai/gpt-5" },
		},
	};
	writeFileSync(cfg, JSON.stringify(parsed));
	return cfg;
}

test("models rm removes a malformed pre-P11 name when it is quoted", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-modelsrm2-"));
	seedMalformed(home);
	const rm = run(["models", "rm", MALFORMED, "--json"], { home });
	assert.equal(rm.parsed.ok, true);
	assert.equal(rm.parsed.data.removed.model, "openai/gpt-5");
	const after = run(["models", "list", "--json"], { home });
	assert.deepEqual(Object.keys(after.parsed.data.aliases), ["good-model"]);
});

test("models rm removes a malformed name split into argv tokens after --", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-modelsrm3-"));
	seedMalformed(home);
	const rm = run(
		["models", "rm", "--json", "--", ...MALFORMED.split(" ")],
		{ home },
	);
	assert.equal(rm.parsed.ok, true);
	assert.equal(rm.parsed.data.alias, MALFORMED);
	assert.equal(rm.parsed.data.removed.model, "openai/gpt-5");
});

test("models rm with no alias fails with usage", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-modelsrm4-"));
	run(["init"], { home });
	const r = run(["models", "rm", "--json"], { home });
	assert.equal(r.status, 1);
	assert.equal(r.parsed.ok, false);
});
