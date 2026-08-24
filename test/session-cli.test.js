// CLI-level tests for `session end --if-active` (SessionEnd-hook no-op mode).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"cli.js",
);

function home() {
	return mkdtempSync(path.join(tmpdir(), "agent-sessioncli-"));
}

function run(args, envHome) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		env: { ...process.env, AGENT_CLI_HOME: envHome, AGENT_OFFLINE: "1" },
	});
	let parsed = null;
	try {
		parsed = JSON.parse(r.stdout);
	} catch {
		/* non-JSON */
	}
	return { status: r.status, parsed, stdout: r.stdout };
}

test("session end without a session errors (interactive semantics kept)", () => {
	const h = home();
	const r = run(["session", "end", "--json"], h);
	assert.equal(r.status, 1);
	assert.equal(r.parsed.ok, false);
	assert.match(r.parsed.data.reason, /no active session/);
});

test("session end --if-active with no session is a clean no-op (hook mode)", () => {
	const h = home();
	const r = run(["session", "end", "--if-active", "--json"], h);
	assert.equal(r.status, 0);
	assert.equal(r.parsed.ok, true);
	assert.equal(r.parsed.data.noop, true);
	assert.equal(r.parsed.data.noActiveSession, true);
});

test("session end --if-active still ends a real session", () => {
	const h = home();
	const start = run(["session", "start", "hook verify", "--json"], h);
	assert.equal(start.status, 0);
	const r = run(["session", "end", "--if-active", "--json"], h);
	assert.equal(r.status, 0);
	assert.equal(r.parsed.ok, true);
	assert.notEqual(r.parsed.data.noop, true);
	assert.ok(r.parsed.data.durationMs >= 0);
	// after the real end, a second call no-ops again
	const again = run(["session", "end", "--if-active", "--json"], h);
	assert.equal(again.status, 0);
	assert.equal(again.parsed.data.noop, true);
});
