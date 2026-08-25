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

// --- Path containment -------------------------------------------------------
// A task id reaches attachContextForTask from the orchestrator's task DAG and is
// interpolated into a FILENAME. Before the fix, `../../../PWNED` wrote the
// artifact three levels above HANDOFF_DIR.

test("attachContextForTask keeps a traversal task id inside the handoff dir", async () => {
	const base = mkdtempSync(path.join(tmpdir(), "agent-ho-escape-"));
	const logs = path.join(base, ".agents", ".logs");
	mkdirSync(logs, { recursive: true });
	const session = "s-escape";
	const evil = "../../../PWNED";
	const lines = [
		JSON.stringify({
			ts: "2026-01-01T00:00:00.000Z",
			session,
			role: "dev",
			task: "P1",
			model: "m",
			status: "succeeded",
			ms: 1,
			note: "pred",
		}),
		JSON.stringify({
			ts: "2026-01-01T00:00:01.000Z",
			session,
			role: "dev",
			task: evil,
			model: "m",
			status: "succeeded",
			ms: 1,
			note: JSON.stringify({ dependsOn: ["P1"] }),
		}),
	].join("\n");
	writeFileSync(path.join(logs, `${session}.dispatch.log`), lines + "\n", "utf8");

	const r = h.attachContextForTask({ taskId: evil, session, home: base });
	assert.equal(r.ok, true);
	assert.ok(
		r.artifactPath.startsWith(h.HANDOFF_DIR),
		`artifact escaped the handoff dir: ${r.artifactPath}`,
	);
	assert.ok(
		!path.basename(r.artifactPath).includes(".."),
		`filename must not carry traversal segments: ${r.artifactPath}`,
	);
	// the raw id is still faithfully recorded in the (inert) document body
	const shown = await h.showHandoff(path.basename(r.artifactPath, ".md"));
	assert.equal(shown.ok, true);
	assert.match(shown.content, /# Handoff for \.\.\/\.\.\/\.\.\/PWNED/);
});

test("showHandoff / setHandoffStatus refuse a traversal id", async () => {
	const created = await h.createHandoff({ to: "worker", task: "contained" });
	// sanity: the real id still resolves
	assert.equal((await h.showHandoff(created.id)).ok, true);
	// a crafted id must not walk out of HANDOFF_DIR — setHandoffStatus WRITES
	// through the same resolver, so this is a write-containment check too.
	const escaped = await h.showHandoff("../../../../etc/passwd");
	assert.equal(escaped.ok, false);
	const written = await h.setHandoffStatus("../../../../etc/passwd", "closed");
	assert.equal(written.ok, false);
});
