// test/mcp-write.test.js — Phase 6 write-side regression tests (T6.2.6).
//
// MASTER-PLAN §1 decision 10: in-process handleMessage tests are necessary but
// not sufficient for the MCP wire paths — the spawned stdio counterpart lives in
// test/serve-stdio.test.js (write-capability wire parity). This file is the
// in-process unit under test: it drives the real `handleMessage` in
// src/serve.js over the 10 v0.8.1 write tools and asserts the protocol contract.
//
// What this file covers (per the T6.2.6 scope):
//   1. Capability binding (A16) — tools/list exposes the 10 write tools only
//      after `initialize` offers `capabilities.experimental.agentCli.writeTools
//      === true` (exact boolean). Without the offer, tools/list hides them and
//      tools/call refuses with -32603 write_capability_required.
//   2. Every one of the 10 write tools returns the contract envelope shape
//      (`{ ok, command, apiVersion }` with apiVersion "2.0.0") through tools/call
//      after a write-capability initialize.
//   3. brain_write happy path: a valid SOUL write returns ok:true (dry-run
//      applyChanges:false so no file is touched).
//   4. Scope matrix (A17): brain_write IDENTITY + project scope rejects with
//      ok:false code=SCOPE_INVALID BEFORE any library call.
//   5. Dry-run defaults (master-plan §1 decision 4): lesson_consolidate and
//      memory_upgrade_apply both default applyChanges:false (ok:true, no
//      mutation).
//   6. Pre-init refusal (A19): tools/call brain_write BEFORE `initialize`
//      returns -32603 reason=init_required AND performs NO filesystem change
//      (verified via fs.existsSync on the would-be target).
//   7. Unknown write-tool name returns -32602 unknown tool.
//
// Isolation: AGENT_CLI_HOME is set to a fresh mkdtemp dir BEFORE `serve.js` is
// imported — the module chain (util.js, operation-lock.js) captures HOME at
// module load, so no real `~` is ever touched. AGENT_OFFLINE=1 +
// AGENT_CLI_NO_UPDATE_CHECK=1 keep the child deterministic and off the network.
//
// Per-module session state: `serverInitialized` / `writeCapabilityOffered` are
// module-global in serve.js. Every test resets them via `serve.resetSession()`
// so the pre-init refusal test is order-independent, and each capability test
// re-runs `initialize` on demand.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// HOME must be set BEFORE the async serve.js import (module-load capture).
process.env.AGENT_OFFLINE = "1";
process.env.AGENT_CLI_NO_UPDATE_CHECK = "1";
const TMP_HOME = mkdtempSync(path.join(tmpdir(), "agent-mcp-write-"));
process.env.AGENT_CLI_HOME = TMP_HOME;

const serve = await import("../src/serve.js");

/** Write-capability initialize (A16): host offers writeTools:true (exact boolean). */
async function runInit() {
	return serve.handleMessage({
		jsonrpc: "2.0",
		id: 0,
		method: "initialize",
		params: { capabilities: { experimental: { agentCli: { writeTools: true } } } },
	});
}

/** tools/call with an incrementing id. Returns the raw handleMessage response. */
let nextId = 100;
function callTool(name, args) {
	return serve.handleMessage({
		jsonrpc: "2.0",
		id: nextId++,
		method: "tools/call",
		params: { name, arguments: args },
	});
}

/** Unwrap the MCP content[0].text envelope (JSON) from a tools/call response. */
function envelope(res) {
	assert.ok(res && res.result, `expected a result envelope, got ${JSON.stringify(res)}`);
	const block = res.result.content && res.result.content[0];
	assert.ok(block && block.type === "text", "expected a single text content block");
	return JSON.parse(block.text);
}

/** Path the global SOUL file would land at — the "suspicious target" for A19. */
const SOUL_PATH = path.join(TMP_HOME, ".agents", "SOUL.md");

/** Wipe a path so a test's starting state is deterministic. */
function wipe(p) {
	rmSync(p, { recursive: true, force: true });
}

/** Wipe the brain target + the cross-process lock dir for a clean start. */
function wipeBrainState() {
	wipe(path.join(TMP_HOME, ".agents", "SOUL.md"));
	wipe(path.join(TMP_HOME, ".agents", ".locks"));
}

beforeEach(() => {
	// Reset per-module session state so the A19 pre-init test is order-independent.
	serve.resetSession();
});

// ---------------------------------------------------------------------------
// Capability binding (A16) — tools/list visibility + refusal
// ---------------------------------------------------------------------------

test("initialize with writeTools:true advertises the write capability", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { capabilities: { experimental: { agentCli: { writeTools: true } } } },
	});
	assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
	assert.ok(
		res.result.capabilities.experimental?.agentCli?.writeTools === true,
		"initialize response must advertise writeTools:true when the host offered it",
	);
});

test("tools/list exposes the 10 write tools after a write-capability initialize", async () => {
	await runInit();
	const res = await serve.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
	const names = res.result.tools.map((t) => t.name);
	const WRITE_NAMES = [
		"brain_write",
		"lesson_capture",
		"target_enable",
		"target_disable",
		"link",
		"unlink",
		"memory_upgrade_prepare",
		"memory_upgrade_apply",
		"snapshot_now",
		"lesson_consolidate",
	];
	// 6 read tools + 10 write tools = 16.
	assert.equal(res.result.tools.length, 16, `expected 16 tools, got ${res.result.tools.length}`);
	for (const n of WRITE_NAMES) {
		assert.ok(names.includes(n), `missing write tool ${n}`);
	}
	// Still exposes the read tools.
	for (const n of ["brief", "doctor", "search", "snapshot", "status", "spect_status"]) {
		assert.ok(names.includes(n), `missing read tool ${n}`);
	}
	// restore is NOT in v0.8.1 (deferred to v0.8.2).
	assert.ok(!names.includes("restore"), "restore must NOT be exposed in v0.8.1");
});

test("tools/list WITHOUT write capability hides the write tools", async () => {
	await serve.handleMessage({
		jsonrpc: "2.0",
		id: 3,
		method: "initialize",
		params: { capabilities: {} }, // host did NOT offer writeTools
	});
	const res = await serve.handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/list" });
	assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
	const names = res.result.tools.map((t) => t.name);
	assert.equal(res.result.tools.length, 6, `expected 6 read tools, got ${res.result.tools.length}`);
	for (const hidden of [
		"brain_write",
		"lesson_capture",
		"target_enable",
		"target_disable",
		"link",
		"unlink",
		"memory_upgrade_prepare",
		"memory_upgrade_apply",
		"snapshot_now",
		"lesson_consolidate",
	]) {
		assert.ok(!names.includes(hidden), `write tool ${hidden} must be hidden without capability`);
	}
	// Read tools still present.
	for (const n of ["brief", "doctor", "search", "snapshot", "status", "spect_status"]) {
		assert.ok(names.includes(n), `missing read tool ${n}`);
	}
});

test("tools/call a write tool WITHOUT capability refuses with -32603 write_capability_required", async () => {
	await serve.handleMessage({
		jsonrpc: "2.0",
		id: 5,
		method: "initialize",
		params: { capabilities: {} }, // offered, but writeTools NOT offered
	});
	const res = await callTool("brain_write", { kind: "SOUL", content: "x", applyChanges: false });
	assert.ok(res.error, `expected an error, got ${JSON.stringify(res)}`);
	assert.equal(res.error.code, -32603);
	assert.equal(res.error.data?.reason, "write_capability_required");
	assert.ok(!res.result, "must not return a result envelope when capability was not offered");
});

// ---------------------------------------------------------------------------
// Contract envelope shape — every write tool returns { ok, command, apiVersion }
// ---------------------------------------------------------------------------

test("every write tool returns the contract envelope (ok/command/apiVersion 2.0.0) via tools/call", async () => {
	await runInit();
	// Arguments chosen to produce a DEFINED SDK envelope (ok or err) so none of
	// them fall into serve.js's INTERNAL catch (which would drop apiVersion). For
	// dry-runnable tools use applyChanges:false; for the rest use an invalid-arg
	// shape that returns an err() envelope before any library call.
	const probes = [
		{ name: "brain_write", args: { kind: "SOUL", content: "env", applyChanges: false } },
		{ name: "lesson_capture", args: {} },
		{ name: "target_enable", args: {} },
		{ name: "target_disable", args: {} },
		{ name: "link", args: {} },
		{ name: "unlink", args: {} },
		{ name: "memory_upgrade_prepare", args: {} },
		{ name: "memory_upgrade_apply", args: {} },
		{ name: "snapshot_now", args: { applyChanges: false } },
		{ name: "lesson_consolidate", args: { scope: "bogus" } },
	];
	for (const probe of probes) {
		const parsed = envelope(await callTool(probe.name, probe.args));
		assert.equal(typeof parsed.ok, "boolean", `${probe.name}: ok must be a boolean`);
		assert.equal(
			parsed.command,
			probe.name,
			`${probe.name}: envelope command must echo the tool name`,
		);
		assert.equal(
			parsed.apiVersion,
			"2.0.0",
			`${probe.name}: apiVersion must be "2.0.0"`,
		);
	}
});

// ---------------------------------------------------------------------------
// brain_write happy path (dry-run) — ok:true, no file touched
// ---------------------------------------------------------------------------

test("brain_write valid SOUL write returns ok:true (applyChanges:false dry-run)", async () => {
	await runInit();
	wipeBrainState();
	const parsed = envelope(
		await callTool("brain_write", { kind: "SOUL", content: "hello world", applyChanges: false }),
	);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.command, "brain_write");
	assert.equal(parsed.apiVersion, "2.0.0");
	assert.equal(parsed.data.dryRun, true);
	assert.equal(parsed.data.kind, "SOUL");
	assert.equal(parsed.data.scope, "global");
	// A dry-run must NOT touch the filesystem.
	assert.ok(parsed.data.path, "dry-run should still report the would-be path");
});

// ---------------------------------------------------------------------------
// Scope matrix (A17) — IDENTITY is global-only
// ---------------------------------------------------------------------------

test("brain_write IDENTITY + project scope rejects with ok:false code=SCOPE_INVALID", async () => {
	await runInit();
	const parsed = envelope(
		await callTool("brain_write", { kind: "IDENTITY", content: "x", scope: "project", applyChanges: true }),
	);
	assert.equal(parsed.ok, false);
	assert.equal(parsed.apiVersion, "2.0.0");
	assert.equal(parsed.code, "SCOPE_INVALID");
	// Rejection happens BEFORE any library call — nothing should be written.
	assert.ok(!existsSync(SOUL_PATH), "SCOPE_INVALID must not write any brain file");
});

// ---------------------------------------------------------------------------
// A17 (T6.2.7 F1) — a host-supplied `cwd` is ignored; project scope resolves
// under the server launch dir (LAUNCH_CWD), never the caller-supplied path.
// ---------------------------------------------------------------------------

test("brain_write ignores a host-supplied cwd; project scope resolves under the launch dir", async () => {
	await runInit();
	// Dry-run so nothing is written to disk (a real write would otherwise
	// land in the repo's `.agents` when the suite runs from the repo root).
	const decoy = "/etc";
	const parsed = envelope(
		await callTool("brain_write", {
			kind: "SOUL",
			scope: "project",
			content: "# a17",
			applyChanges: false,
			cwd: decoy,
		}),
	);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.command, "brain_write");
	assert.equal(parsed.apiVersion, "2.0.0");
	assert.equal(parsed.data.scope, "project");
	// Separator-agnostic: the A17 property is "resolved under the launch dir's
	// .agents", not "spelled with a forward slash" — on Windows the resolved
	// path legitimately comes back as `...\.agents\SOUL.md`.
	assert.ok(
		typeof parsed.data.path === "string" &&
			parsed.data.path.split(path.sep).join("/").endsWith(".agents/SOUL.md"),
		`project scope must resolve to <.agents>/SOUL.md; got ${JSON.stringify(parsed.data.path)}`,
	);
	assert.ok(
		typeof parsed.data.path === "string" && !parsed.data.path.includes(decoy),
		`host-supplied cwd must be ignored (A17); path must not contain "${decoy}"`,
	);
	assert.ok(!existsSync(SOUL_PATH), "A17 dry-run must not write a brain file");
});

// ---------------------------------------------------------------------------
// Dry-run defaults (master-plan §1 decision 4)
// ---------------------------------------------------------------------------

test("lesson_consolidate defaults applyChanges:false (dry-run ok:true, no mutation)", async () => {
	// Seed a lessons dir so consolidate has something to act on and reports
	// dryRun:true in its data (the nothingToDo shape omits dryRun).
	const lessonsDir = path.join(TMP_HOME, ".agents", "lessons");
	wipe(lessonsDir);
	mkdirSync(lessonsDir, { recursive: true });
	const lessonBody = "---\noccurrences: 1\n---\nSome lesson\n";
	const lessonFile = path.join(lessonsDir, "a.md");
	writeFileSync(lessonFile, lessonBody);
	wipe(path.join(TMP_HOME, ".agents", "backups"));

	await runInit();
	const parsed = envelope(await callTool("lesson_consolidate", { scope: "global" }));
	assert.equal(parsed.ok, true);
	assert.equal(parsed.command, "lesson_consolidate");
	assert.equal(parsed.apiVersion, "2.0.0");
	assert.equal(parsed.data.dryRun, true, "lesson_consolidate must default to a dry run");
	// No mutation: the lesson file is untouched and NO transaction backup /
	// state marker was written.
	assert.equal(
		readFileSync(lessonFile, "utf8"),
		lessonBody,
		"dry-run must not mutate the lesson file",
	);
	assert.ok(
		!existsSync(path.join(TMP_HOME, ".agents", "backups")),
		"dry-run must not create a transaction backup",
	);
	assert.ok(
		!existsSync(path.join(TMP_HOME, ".agents", ".consolidate-state.json")),
		"dry-run must not write the consolidation state marker",
	);
});

test("memory_upgrade_apply defaults applyChanges:false (preview by default)", async () => {
	await runInit();
	const parsed = envelope(
		await callTool("memory_upgrade_apply", { id: "soul", scope: "global" }),
	);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.command, "memory_upgrade_apply");
	assert.equal(parsed.apiVersion, "2.0.0");
	assert.equal(parsed.data.dryRun, true, "memory_upgrade_apply must preview by default");
	assert.equal(
		typeof parsed.data.reason,
		"string",
		"preview must carry a reason explaining the opt-in gate",
	);
});

// ---------------------------------------------------------------------------
// Pre-init refusal (A19) — no write, no crash
// ---------------------------------------------------------------------------

test("tools/call brain_write BEFORE initialize returns -32603 init_required with NO fs change", async () => {
	// No runInit on purpose: beforeEach resetSession leaves serverInitialized=false.
	wipeBrainState();
	const res = await callTool("brain_write", { kind: "SOUL", content: "should-not-write", applyChanges: true });
	assert.ok(res.error, `expected an error, got ${JSON.stringify(res)}`);
	assert.equal(res.error.code, -32603);
	assert.equal(res.error.data?.reason, "init_required");
	assert.equal(res.error.message, "write tool not available: brain_write");
	assert.ok(!res.result, "pre-init refusal must NOT return a result envelope");
	// A19: the refusal happens before any SDK call — SOUL.md is never created.
	assert.ok(
		!existsSync(SOUL_PATH),
		"pre-init refusal must leave NO filesystem change at the suspicious target",
	);
});

// ---------------------------------------------------------------------------
// Unknown write-tool name — -32602
// ---------------------------------------------------------------------------

test("tools/call an unknown write-tool name returns -32602 unknown tool", async () => {
	await runInit();
	const res = await callTool("brain_rewrite", { kind: "SOUL", content: "x" });
	assert.ok(res.error, `expected an error, got ${JSON.stringify(res)}`);
	assert.equal(res.error.code, -32602);
	assert.equal(res.error.message, "unknown tool: brain_rewrite");
	assert.ok(!res.result, "unknown tool must NOT return a result envelope");
});
