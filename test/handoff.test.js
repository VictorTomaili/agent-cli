// Handoff artifact tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	existsSync,
	statSync,
	readdirSync,
} from "node:fs";
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
	// Containment is against the handoff dir of the home that was PASSED. This
	// asserted h.HANDOFF_DIR before, which passed only because the artifact
	// ignored `home` entirely — the escape and the misroute cancelled out.
	// Compare resolved dirnames, not a string prefix: `<dir>EVIL` startsWith
	// `<dir>`.
	assert.equal(
		path.resolve(path.dirname(r.artifactPath)),
		path.resolve(path.join(base, ".agents", "handoffs")),
		`artifact escaped the handoff dir: ${r.artifactPath}`,
	);
	assert.ok(
		!path.basename(r.artifactPath).includes(".."),
		`filename must not carry traversal segments: ${r.artifactPath}`,
	);
	// the raw id is still faithfully recorded in the (inert) document body
	const shown = await h.showHandoff(path.basename(r.artifactPath, ".md"), { home: base });
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

// `home` is honoured for the ledger read (handoffHome) but the artifact went to
// the module-level HANDOFF_DIR, frozen from util.HOME at import. The two paths
// have to agree, or a caller passing an explicit home reads one tree and writes
// another.
test("attachContextForTask writes under the home it was given", async () => {
	const argHome = mkdtempSync(path.join(tmpdir(), "agent-ho-arg-"));
	const session = "11111111-2222-3333-4444-555555555555";
	const logs = path.join(argHome, ".agents", ".logs");
	mkdirSync(logs, { recursive: true });
	writeFileSync(
		path.join(logs, `${session}.dispatch.log`),
		JSON.stringify({
			ts: "2026-08-01T00:00:00.000Z",
			session,
			role: "dev",
			task: "P1",
			model: "m",
			status: "succeeded",
			ms: 1,
			note: "did it",
		}) + "\n",
		"utf8",
	);

	const r = h.attachContextForTask({ taskId: "T", dependsOn: ["P1"], session, home: argHome });
	assert.equal(r.ok, true, r.reason);
	assert.equal(
		path.resolve(path.dirname(r.artifactPath)),
		path.resolve(path.join(argHome, ".agents", "handoffs")),
		`artifact must land under the given home, not ${h.HANDOFF_DIR}`,
	);
	assert.ok(existsSync(r.artifactPath));
	// The pairing the module promises: whatever home the artifact was written
	// under, the module's own reader opens it under that same home. Fixing the
	// write alone would only have moved the inconsistency into the reader.
	const shown = await h.showHandoff(path.basename(r.artifactPath, ".md"), { home: argHome });
	assert.equal(shown.ok, true);
	assert.match(shown.content, /# Handoff for T/);
	assert.deepEqual(
		(await h.listHandoffs({ home: argHome })).map((e) => e.file),
		[r.artifactPath],
	);
});

// Omitting `home` must keep landing in the module-level dir — the fix resolves
// an explicit home, it does not relocate the default.
test("attachContextForTask still defaults to HANDOFF_DIR when no home is given", () => {
	const base = process.env.AGENT_CLI_HOME;
	const session = "cccccccc-dddd-eeee-ffff-000000000000";
	mkdirSync(path.join(base, ".agents", ".logs"), { recursive: true });
	writeFileSync(
		path.join(base, ".agents", ".logs", `${session}.dispatch.log`),
		JSON.stringify({
			ts: "2026-08-02T00:00:00.000Z",
			session,
			role: "dev",
			task: "P1",
			model: "m",
			status: "succeeded",
			ms: 1,
			note: "n",
		}) + "\n",
		"utf8",
	);
	const r = h.attachContextForTask({ taskId: "DEF", dependsOn: ["P1"], session });
	assert.equal(r.ok, true, r.reason);
	assert.equal(path.resolve(path.dirname(r.artifactPath)), path.resolve(h.HANDOFF_DIR));
});

// The write is documented as atomic. A raw writeFileSync truncates first, so a
// concurrent reader can observe a partial (or empty) artifact; the atomic
// helper renames a fully-written temp file over the target instead. Assert the
// mechanism — a timing race would be flaky in CI.
test("attachContextForTask never truncates the artifact in place", async () => {
	const base = process.env.AGENT_CLI_HOME;
	const session = "99999999-8888-7777-6666-555555555555";
	const logs = path.join(base, ".agents", ".logs");
	mkdirSync(logs, { recursive: true });
	writeFileSync(
		path.join(logs, `${session}.dispatch.log`),
		JSON.stringify({
			ts: "2026-08-01T00:00:00.000Z",
			session,
			role: "dev",
			task: "P1",
			model: "m",
			status: "succeeded",
			ms: 1,
			note: "first",
		}) + "\n",
		"utf8",
	);

	const first = h.attachContextForTask({ taskId: "AT", dependsOn: ["P1"], session, home: base });
	assert.equal(first.ok, true, first.reason);
	const inode = statSync(first.artifactPath).ino;

	// Rewriting must replace the file, not reopen-and-truncate the same one.
	const second = h.attachContextForTask({ taskId: "AT", dependsOn: ["P1"], session, home: base });
	assert.equal(second.ok, true, second.reason);
	assert.equal(second.artifactPath, first.artifactPath);
	assert.notEqual(
		statSync(second.artifactPath).ino,
		inode,
		"a rename-over leaves a new inode; an in-place truncate reuses the old one",
	);

	// And no temp file is left behind next to it.
	assert.deepEqual(
		readdirSync(path.dirname(second.artifactPath)).filter((f) => f.endsWith(".tmp")),
		[],
	);
});
