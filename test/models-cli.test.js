// CLI-level tests for `models lint|usage|test` and the composite commands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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
