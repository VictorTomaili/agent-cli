// test/mcp-concurrency.test.js — Phase 6 write-side race regression tests (T6.2.6).
//
// MASTER-PLAN §1 decision 10: spawned stdio tests are mandatory for the wire
// paths (see test/serve-stdio.test.js); the MASTER-PLAN T6.2.6 acceptance
// explicitly permits in-process Promise.all for the concurrency legs ("use
// spawned processes or in-process Promise.all"). The cross-process operation
// lock in src/operation-lock.js is a FILE lock keyed by pid/hostname, so two
// concurrent in-process legs still contend on `~/.agents/.locks/*` exactly as
// two separate processes would — the serialization guarantee is the same.
//
// THIS FILE IS NOT A SUBSTITUTE FOR MR1–MR4 IN THE PLAN — it covers the 5 race
// scenarios qa §3 / task T6.2.6 explicitly lists:
//   R1  two concurrent brain_write SOUL calls, different content → final file
//       is exactly one of the two (no torn/partial bytes), second waits or
//       refuses OPERATION_BUSY, never silently corrupts.
//   R2  brain_write racing lesson_capture → operation lock serializes (both
//       converge; an append to the inbox is never dropped, the brain is whole).
//   R3  snapshot_now while brain_write in flight → snapshot completes after the
//       write (or refuses OPERATION_BUSY); the brain is never half-written.
//   R4  consolidate racing lesson_capture → serialized by the consolidate lock;
//       a dry-run consolidate mutates nothing, the capture still lands.
//   R5  restore is NOT exposed in v0.8.1 (deferred to v0.8.2) — tools/list
//       omits it and tools/call restore returns -32602 unknown tool.
//
// Isolation: AGENT_CLI_HOME set to a fresh mkdtemp dir BEFORE the async
// serve.js import; AGENT_OFFLINE=1 + AGENT_CLI_NO_UPDATE_CHECK=1. A17
// (T6.2.7 F1): project scope ALWAYS resolves against the server's launch cwd
// (LAUNCH_CWD), NEVER a caller-supplied `cwd` arg — so the project legs are
// isolated by chdir-ing the server into a project dir under TMP_HOME BEFORE
// the serve.js import (write.js captures LAUNCH_CWD at module load). A host
// `cwd` arg is deliberately passed as a decoy and asserted to be ignored.
// Per-test beforeEach resets the module-global session state via
// serve.resetSession(). Every test wipes the brain target + lock dir first.
// No spawned children in this file; each test runs the real handleMessage
// in-process.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
	readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// HOME must be set BEFORE the async serve.js import (module-load capture).
process.env.AGENT_OFFLINE = "1";
process.env.AGENT_CLI_NO_UPDATE_CHECK = "1";
const TMP_HOME = mkdtempSync(path.join(tmpdir(), "agent-mcp-conc-"));
process.env.AGENT_CLI_HOME = TMP_HOME;
// A17 (T6.2.7 F1): project-scope writes must resolve under the server's
// launch cwd (LAUNCH_CWD), so launch the server from a project dir inside
// TMP_HOME — never the real repo. chdir BEFORE the serve.js import because
// write.js captures LAUNCH_CWD at module load.
const PROJECT_CWD = path.join(TMP_HOME, "proj");
mkdirSync(PROJECT_CWD, { recursive: true });
process.chdir(PROJECT_CWD);

// Host-supplied decoy `cwd` — A17 requires it be IGNORED for path resolution,
// so it must never appear in any resolved destination.
const A17_DECOY_CWD = "/tmp/a17-evil-cwd";

const serve = await import("../src/serve.js");

/** Write-capability initialize (A16). */
async function runInit() {
	return serve.handleMessage({
		jsonrpc: "2.0",
		id: 0,
		method: "initialize",
		params: { capabilities: { experimental: { agentCli: { writeTools: true } } } },
	});
}

let nextId = 100;
function callTool(name, args) {
	return serve.handleMessage({
		jsonrpc: "2.0",
		id: nextId++,
		method: "tools/call",
		params: { name, arguments: args },
	});
}

/** Unwrap content[0].text envelope (JSON) from a tools/call response. */
function envelope(res) {
	assert.ok(res && res.result, `expected a result envelope, got ${JSON.stringify(res)}`);
	const block = res.result.content && res.result.content[0];
	assert.ok(block && block.type === "text", "expected a single text content block");
	return JSON.parse(block.text);
}

/** Wipe a path so a test's starting state is deterministic. */
function wipe(p) {
	rmSync(p, { recursive: true, force: true });
}

const SOUL_PATH = path.join(TMP_HOME, ".agents", "SOUL.md");
const LOCK_DIR = path.join(TMP_HOME, ".agents", ".locks");
const GLOBAL_INBOX = path.join(TMP_HOME, ".agents", "lessons", ".inbox");

function wipeBrain() {
	wipe(path.join(TMP_HOME, ".agents", "SOUL.md"));
	wipe(LOCK_DIR);
}

beforeEach(() => {
	serve.resetSession();
});

// ---------------------------------------------------------------------------
// R1 — two concurrent brain_write SOUL calls with different content
// ---------------------------------------------------------------------------

test("R1: two concurrent brain_write SOUL calls never corrupt the file; the final content is one of the two", async () => {
	await runInit();
	wipeBrain();

	// Distinct, non-trivial bodies so a torn/interleaved write would be obvious.
	const A_CONTENT = "# SOUL A\n\n" + "alpha-".repeat(200);
	const B_CONTENT = "# SOUL B\n\n" + "beta-".repeat(200);

	const [ra, rb] = await Promise.all([
		callTool("brain_write", { kind: "SOUL", content: A_CONTENT, applyChanges: true }),
		callTool("brain_write", { kind: "SOUL", content: B_CONTENT, applyChanges: true }),
	]);

	const ea = envelope(ra);
	const eb = envelope(rb);
	// Both calls must surface a valid envelope (the second WAITS for the lock,
	// it does not silently drop). Neither may be an OPERATION_BUSY refusal here
	// because a single atomic write is far under the 5s lock timeout.
	assert.equal(ea.ok, true, `call A must succeed: ${JSON.stringify(ea)}`);
	assert.equal(eb.ok, true, `call B must succeed: ${JSON.stringify(eb)}`);
	assert.equal(ea.apiVersion, "2.0.0");
	assert.equal(eb.apiVersion, "2.0.0");

	// The final file is EXACTLY one of the two bodies — never a mix, never torn.
	const finalContent = readFileSync(SOUL_PATH, "utf8");
	assert.ok(
		finalContent === A_CONTENT || finalContent === B_CONTENT,
		`final brain_write content must be exactly one of the two; got ${finalContent.slice(0, 80)}... (len ${finalContent.length})`,
	);

	// Both legs released their lock — nothing is left behind.
	assert.ok(!existsSync(path.join(LOCK_DIR, "snapshot.lock")), "snapshot.lock must be released after both write legs");
});

// ---------------------------------------------------------------------------
// R2 — brain_write racing lesson_capture converges
// ---------------------------------------------------------------------------

test("R2: brain_write racing lesson_capture converges (operation lock serializes; capture not dropped)", async () => {
	await runInit();
	wipeBrain();
	wipe(GLOBAL_INBOX);
	mkdirSync(path.dirname(GLOBAL_INBOX), { recursive: true });

	const BRAIN_CONTENT = "brain-race-" + "zz".repeat(100);
	const [rw, rc] = await Promise.all([
		callTool("brain_write", { kind: "SOUL", content: BRAIN_CONTENT, applyChanges: true }),
		callTool("lesson_capture", { topic: "race-cap", cwd: A17_DECOY_CWD }),
	]);

	const ew = envelope(rw);
	const ec = envelope(rc);
	assert.equal(ew.ok, true, `brain_write must converge: ${JSON.stringify(ew)}`);
	assert.equal(ec.ok, true, `lesson_capture must converge: ${JSON.stringify(ec)}`);
	assert.equal(ew.apiVersion, "2.0.0");
	assert.equal(ec.apiVersion, "2.0.0");

	// The brain file is whole (exactly the written content), not half-written.
	assert.equal(
		readFileSync(SOUL_PATH, "utf8"),
		BRAIN_CONTENT,
		"the concurrent brain_write must leave the full content",
	);
	// lesson_capture appended to BOTH inboxes; the global one must be present
	// and the project one must be rooted inside TMP_HOME, never the real repo.
	const globalCapture = path.join(GLOBAL_INBOX, "race-cap.md");
	assert.ok(existsSync(globalCapture), "lesson_capture must land in the global inbox");
	assert.ok(
		!existsSync(path.join(REPO_ROOT, ".agents", "lessons", ".inbox", "race-cap.md")),
		"project-scope capture must NOT leak into the real repo",
	);
	// A17 (T6.2.7 F1): the project-scope capture must resolve under LAUNCH_CWD
	// (the server launch dir == PROJECT_CWD here), never the host-supplied arg.
	assert.ok(
		existsSync(path.join(PROJECT_CWD, ".agents", "lessons", ".inbox", "race-cap.md")),
		"project-scope capture must resolve under LAUNCH_CWD (the server launch dir)",
	);
	assert.ok(
		!existsSync(path.join(A17_DECOY_CWD, ".agents", "lessons", ".inbox", "race-cap.md")),
		"host-supplied cwd must be ignored (A17); the evasive path is never written",
	);
	// Both legs released their locks.
	assert.ok(!existsSync(path.join(LOCK_DIR, "snapshot.lock")), "snapshot.lock released");
	assert.ok(!existsSync(path.join(LOCK_DIR, "consolidate.lock")), "consolidate.lock released");
});

// ---------------------------------------------------------------------------
// R3 — snapshot_now while brain_write in flight
// ---------------------------------------------------------------------------

test("R3: snapshot_now while brain_write is in flight — brain is never half-written; snapshot completes or refuses OPERATION_BUSY", async () => {
	await runInit();
	wipeBrain();
	const snapDir = path.join(TMP_HOME, ".agents", "backups", "snapshots");
	wipe(snapDir);

	const BRAIN_CONTENT = "snap-race-" + "qq".repeat(150);
	const [rw, rs] = await Promise.all([
		callTool("brain_write", { kind: "SOUL", content: BRAIN_CONTENT, applyChanges: true }),
		callTool("snapshot_now", { applyChanges: true }),
	]);

	const ew = envelope(rw);
	const es = envelope(rs);
	assert.equal(ew.ok, true, `brain_write must converge: ${JSON.stringify(ew)}`);

	// snapshot_next holds the SAME snapshot.lock as brain_write, so it either
	// (a) completes AFTER the write (its own snapshot dir appears), or
	// (b) refuses with OPERATION_BUSY (only if a leg overran the 5s timeout,
	// which a single atomic write cannot). Assert the disjunction.
	const snapOk = es.ok === true;
	const snapRefused = es.ok === false && es.code === "OPERATION_BUSY";
	assert.ok(
		snapOk || snapRefused,
		`snapshot_now must complete or refuse OPERATION_BUSY; got ${JSON.stringify(es)}`,
	);
	if (snapOk) {
		assert.ok(
			existsSync(snapDir) && readdirSync(snapDir).length >= 1,
			"a completed snapshot must create a snapshot dir",
		);
	}

	// Unconditional: the brain is never half-written.
	assert.equal(
		readFileSync(SOUL_PATH, "utf8"),
		BRAIN_CONTENT,
		"the brain file must never be half-written during a snapshot race",
	);
	assert.ok(!existsSync(path.join(LOCK_DIR, "snapshot.lock")), "snapshot.lock released");
});

// ---------------------------------------------------------------------------
// R4 — consolidate racing lesson_capture
// ---------------------------------------------------------------------------

test("R4: consolidate racing lesson_capture is serialized by the consolidate lock", async () => {
	await runInit();
	wipeBrain();
	const lessonsDir = path.join(TMP_HOME, ".agents", "lessons");
	wipe(lessonsDir);
	mkdirSync(lessonsDir, { recursive: true });
	const lessonBody = "---\noccurrences: 1\n---\nSome lesson\n";
	const lessonFile = path.join(lessonsDir, "a.md");
	writeFileSync(lessonFile, lessonBody);
	wipe(GLOBAL_INBOX);
	mkdirSync(path.dirname(GLOBAL_INBOX), { recursive: true });
	wipe(path.join(TMP_HOME, ".agents", "backups"));

	const [rc, rcap] = await Promise.all([
		callTool("lesson_consolidate", { scope: "global" }), // default dry-run
		callTool("lesson_capture", { topic: "consolidate-race", cwd: A17_DECOY_CWD }),
	]);

	const ec = envelope(rc);
	const ecap = envelope(rcap);
	assert.equal(ec.ok, true, `consolidate must converge: ${JSON.stringify(ec)}`);
	assert.equal(ecap.ok, true, `lesson_capture must converge: ${JSON.stringify(ecap)}`);
	assert.equal(ec.apiVersion, "2.0.0");
	assert.equal(ecap.apiVersion, "2.0.0");

	// Serialized by the consolidate lock: the dry-run consolidate mutated
	// nothing (lesson file intact, no backup, no state marker), yet the capture
	// still landed — neither leg dropped the other's work.
	assert.equal(
		readFileSync(lessonFile, "utf8"),
		lessonBody,
		"dry-run consolidate must not mutate the lesson file",
	);
	assert.ok(
		existsSync(path.join(GLOBAL_INBOX, "consolidate-race.md")),
		"lesson_capture must land in the global inbox",
	);
	assert.ok(
		!existsSync(path.join(REPO_ROOT, ".agents", "lessons", ".inbox", "consolidate-race.md")),
		"project-scope capture must NOT leak into the real repo",
	);
	// A17 (T6.2.7 F1): project-scope capture resolves under LAUNCH_CWD, not the
	// host-supplied decoy cwd.
	assert.ok(
		existsSync(path.join(PROJECT_CWD, ".agents", "lessons", ".inbox", "consolidate-race.md")),
		"project-scope capture must resolve under LAUNCH_CWD (the server launch dir)",
	);
	assert.ok(
		!existsSync(path.join(A17_DECOY_CWD, ".agents", "lessons", ".inbox", "consolidate-race.md")),
		"host-supplied cwd must be ignored (A17); the evasive path is never written",
	);
	assert.ok(!existsSync(path.join(LOCK_DIR, "consolidate.lock")), "consolidate.lock released");
	assert.ok(!existsSync(path.join(LOCK_DIR, "snapshot.lock")), "snapshot.lock released");
});

// ---------------------------------------------------------------------------
// R5 — restore is NOT exposed in v0.8.1 (deferred to v0.8.2)
// ---------------------------------------------------------------------------

test("R5: restore is NOT exposed — tools/list omits it and tools/call returns -32602 unknown tool", async () => {
	await runInit();

	const list = await serve.handleMessage({ jsonrpc: "2.0", id: 200, method: "tools/list" });
	assert.ok(list.result, `expected tools/list result, got ${JSON.stringify(list)}`);
	const names = list.result.tools.map((t) => t.name);
	assert.ok(!names.includes("restore"), "restore must not be advertised in v0.8.1");

	// WRITE_TOOLS (src/serve/registry.js) does not contain restore, so (per the
	// MASTER-PLAN §10.3 C1 deferral) tools/call restore is an UNKNOWN tool, not a
	// capability gated write — -32602 is the correct spec response.
	const res = await callTool("restore", { name: "some-snapshot", applyChanges: true });
	assert.ok(res.error, `expected an error, got ${JSON.stringify(res)}`);
	assert.equal(res.error.code, -32602);
	assert.equal(res.error.message, "unknown tool: restore");
	assert.ok(!res.result, "restore must NOT return a result envelope");
});
