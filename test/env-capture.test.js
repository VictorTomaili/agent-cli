// Env-capture tests: detection + non-destructive ENVIRONMENTS.md filling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_CLI_HOME = mkdtempSync(path.join(tmpdir(), "agent-env-"));
const envc = await import("../src/env-capture.js");
const HOME = process.env.AGENT_CLI_HOME;

test("detectEnvironment returns local facts", () => {
	const d = envc.detectEnvironment();
	assert.ok(d.user.length > 0);
	assert.ok(d.os.length > 0);
	assert.ok(d.shell.length > 0);
	assert.ok(d.home.length > 0);
	assert.ok(d.arch.length > 0);
});

test("fillLocalFields fills only empty fields and preserves filled ones", () => {
	const content = [
		"# ENVIRONMENTS.md",
		"",
		"- User:",
		"- OS: Windows",
		"- Shell:",
		"- Home:",
	].join("\n");
	const detected = { user: "alice", os: "linux", shell: "/bin/zsh", home: "/home/alice" };
	const r = envc.fillLocalFields(content, detected);
	assert.equal(r.filled, 3); // User, Shell, Home were empty; OS was already filled
	assert.match(r.content, /- User: alice/);
	assert.match(r.content, /- OS: Windows/); // preserved, not overwritten
	assert.match(r.content, /- Shell: \/bin\/zsh/);
	assert.match(r.content, /- Home: \/home\/alice/);
});

test("captureAndApply writes filled fields to ENVIRONMENTS.md", async () => {
	const envFile = path.join(HOME, ".agents", "ENVIRONMENTS.md");
	mkdirSync(path.dirname(envFile), { recursive: true });
	writeFileSync(envFile, "# ENVIRONMENTS.md\n\n- User:\n- OS:\n- Shell:\n- Home:\n", "utf8");
	const r = await envc.captureAndApply({ scope: "global" });
	assert.equal(r.ok, true);
	assert.equal(r.filled, 4);
	const content = readFileSync(envFile, "utf8");
	assert.match(content, /- User: /);
	assert.match(content, /- OS: /);
	assert.match(content, /- Shell: /);
	assert.match(content, /- Home: /);
});

test("captureAndApply is non-destructive on already-filled files", async () => {
	const envFile = path.join(HOME, ".agents", "ENVIRONMENTS.md");
	writeFileSync(envFile, "# ENVIRONMENTS.md\n\n- User: custom-user\n- OS: custom-os\n- Shell: custom-shell\n- Home: custom-home\n", "utf8");
	const r = await envc.captureAndApply({ scope: "global" });
	assert.equal(r.filled, 0);
	assert.match(readFileSync(envFile, "utf8"), /- User: custom-user/);
});
