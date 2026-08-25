// Handoff artifact tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_CLI_HOME = mkdtempSync(path.join(tmpdir(), "agent-ho-"));
const h = await import("../src/handoff.js");

test("createHandoff requires to + task", async () => {
	const missing = await h.createHandoff({ task: "x" });
	assert.equal(missing.ok, false);
	const ok = await h.createHandoff({ to: "worker", task: "fix parser" });
	assert.equal(ok.ok, true);
	assert.equal(ok.status, "open");
	assert.match(ok.id, /^h-/);
});

test("list/show/accept/close lifecycle", async () => {
	const before = (await h.listHandoffs()).length;
	const created = await h.createHandoff({ to: "reviewer", task: "review PR" });
	assert.equal((await h.listHandoffs()).length, before + 1);
	const shown = await h.showHandoff(created.id);
	assert.match(shown.content, /review PR/);
	const accepted = await h.acceptHandoff(created.id);
	assert.equal(accepted.status, "accepted");
	const closed = await h.closeHandoff(created.id, { lesson: "git/review-pr" });
	assert.equal(closed.status, "closed");
	assert.ok(closed.lesson && closed.lesson.file);
});

test("handoff count increments and missing id is clean", async () => {
	const before = (await h.listHandoffs()).length;
	const missing = await h.showHandoff("h-nope");
	assert.equal(missing.ok, false);
	await h.createHandoff({ to: "scout", task: "research" });
	assert.equal((await h.listHandoffs()).length, before + 1);
});

test("P8 smoke: an attachContextForTask artifact is readable by the existing reader", async () => {
	const base = process.env.AGENT_CLI_HOME;
	const session = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
	const logs = path.join(base, ".agents", ".logs");
	mkdirSync(logs, { recursive: true });
	const entry = JSON.stringify({
		ts: "2026-08-01T00:00:00.000Z",
		session,
		role: "dev",
		task: "P1",
		model: "openai/gpt-5",
		status: "succeeded",
		ms: 120,
		note: "built the parser",
	});
	writeFileSync(path.join(logs, `${session}.dispatch.log`), entry + "\n", "utf8");

	const r = h.attachContextForTask({ taskId: "T", dependsOn: ["P1"], session, home: base });
	assert.equal(r.ok, true);
	assert.ok(r.artifactPath, "expected an artifact path");
	assert.ok(
		r.artifactPath.startsWith(h.HANDOFF_DIR),
		`artifact must live under the handoff dir: ${r.artifactPath}`,
	);

	// The existing reader opens the artifact unchanged (no regression).
	const id = path.basename(r.artifactPath, ".md");
	const shown = await h.showHandoff(id);
	assert.equal(shown.ok, true);
	assert.match(shown.content, /# Handoff for T/);
	assert.match(shown.content, /## P1/);
	assert.match(shown.content, /- summary: built the parser/);
	assert.match(shown.content, /- ledger line: \{/);
});
