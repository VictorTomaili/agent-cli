// test/serve-stdio.test.js — Phase 6 MCP prompts stdio parity (T6.3.3).
//
// MASTER-PLAN §1 decision 10: in-process handleMessage tests are necessary
// but NOT sufficient for the MCP wire paths. A spawned stdio parity test
// is the load-bearing check that the wire and the real CLI cannot drift.
//
// What this file does:
//   1. Spawns `agent-cli serve` over newline-delimited JSON-RPC.
//   2. Sends `initialize` + `prompts/get` for each canonical prompt.
//   3. Spawns the corresponding real CLI command.
//   4. Byte-compares the wire `text` field against the CLI's `.data.content`
//      (after unwrapping the JSON envelope).
//
// Test isolation: fresh AGENT_CLI_HOME per test (mkdtempSync) +
// AGENT_OFFLINE=1 + AGENT_CLI_NO_UPDATE_CHECK=1. spawnSync timeout: 10_000
// so a hanging child cannot wedge the suite. On the serve child we also
// drain stdout/stderr to keep the OS pipe buffer from filling (the same
// Windows-flake pattern documented in commit f596417's tests).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const CLI = path.resolve("src/cli.js");
const FOR_TASK = "phase-6-mcp";

/** Fresh per-test HOME — keep test deterministic + isolated. */
function freshHome() {
	return mkdtempSync(path.join(tmpdir(), "agent-serve-stdio-"));
}

/** Synchronous CLI invocation. timeout=10_000 — a hanging child wedges the suite. */
function runCli(args, home) {
	return spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			AGENT_OFFLINE: "1",
			AGENT_CLI_NO_UPDATE_CHECK: "1",
			AGENT_CLI_HOME: home,
		},
		timeout: 10_000,
	});
}

/** Spawn `agent-cli serve` over stdio. Capture newline-delimited JSON-RPC into `lines`. */
function startServe(home) {
	const child = spawn(process.execPath, [CLI, "serve"], {
		env: {
			...process.env,
			AGENT_OFFLINE: "1",
			AGENT_CLI_NO_UPDATE_CHECK: "1",
			AGENT_CLI_HOME: home,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let buf = "";
	const lines = [];
	child.stdout.on("data", (d) => {
		buf += d.toString("utf8");
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			lines.push(buf.slice(0, i));
			buf = buf.slice(i + 1);
		}
	});
	let stderr = "";
	child.stderr.on("data", (d) => {
		stderr += d.toString("utf8");
	});
	// Guard against the libuv exit race fixed in commit f596417: drain pipes
	// AND await the exit event. Killing on timeout is a last resort — the
	// serve child should exit cleanly when stdin closes after all messages
	// have been written.
	const exited = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already dead */
			}
			reject(
				new Error(
					`agent-cli serve did not exit within 10s; stderr=${stderr.slice(0, 400)}`,
				),
			);
		}, 10_000);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stderr });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
	return { child, lines, exited };
}

function sendMessage(child, msg) {
	child.stdin.write(JSON.stringify(msg) + "\n");
}

/** Find the JSON-RPC response with the given id from the captured lines. */
function findResponse(lines, id) {
	for (const l of lines) {
		if (!l.trim()) continue;
		try {
			const m = JSON.parse(l);
			if (m.id === id) return m;
		} catch {
			/* skip non-JSON lines */
		}
	}
	return null;
}

/** Belt-and-braces kill of a still-running child after the test body exits. */
function reap(child) {
	if (child.exitCode === null && child.signalCode === null) {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already dead */
		}
	}
}

// ---------------------------------------------------------------------------
// prompts/get session-start  ↔  agent-cli --json prompt
// ---------------------------------------------------------------------------

test("stdio parity: prompts/get session-start text matches `agent-cli --json prompt`", async () => {
	const home = freshHome();
	const { child, lines, exited } = startServe(home);
	let wireText;
	try {
		sendMessage(child, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {} },
		});
		sendMessage(child, {
			jsonrpc: "2.0",
			id: 2,
			method: "prompts/get",
			params: { name: "session-start" },
		});
		child.stdin.end();
		const { code, stderr } = await exited;
		assert.equal(code, 0, `serve exited code=${code}; stderr=${stderr}`);
		const resp = findResponse(lines, 2);
		assert.ok(
			resp && resp.result,
			`no response with id=2; lines=${JSON.stringify(lines)}`,
		);
		wireText = resp.result.messages[0].content.text;
		assert.equal(
			typeof wireText,
			"string",
			"session-start text is not a string",
		);
		assert.ok(wireText.length > 0, "session-start text is empty");
	} finally {
		reap(child);
	}

	// Real CLI comparison: `agent-cli --json prompt` returns the canonical
	// envelope `{ ok, command, apiVersion, data: { content, ... } }`. Strip
	// the envelope to get the same string the wire carries.
	const r = runCli(["--json", "prompt"], home);
	assert.equal(
		r.status,
		0,
		`agent-cli --json prompt failed (exit ${r.status}): ${r.stderr}`,
	);
	const cliEnv = JSON.parse(r.stdout);
	assert.ok(cliEnv && cliEnv.data && typeof cliEnv.data.content === "string",
		`CLI prompt envelope missing data.content: ${r.stdout.slice(0, 400)}`);
	const cliContent = cliEnv.data.content;
	assert.ok(cliContent.length > 0, "CLI prompt .data.content is empty");

	assert.equal(
		wireText,
		cliContent,
		"wire prompts/get session-start text differs from `agent-cli --json prompt` .data.content",
	);
});

// ---------------------------------------------------------------------------
// prompts/get instructions  ↔  agent-cli --json instructions
// ---------------------------------------------------------------------------

test("stdio parity: prompts/get instructions text matches `agent-cli --json instructions`", async () => {
	const home = freshHome();
	const { child, lines, exited } = startServe(home);
	let wireText;
	try {
		sendMessage(child, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {} },
		});
		sendMessage(child, {
			jsonrpc: "2.0",
			id: 2,
			method: "prompts/get",
			params: { name: "instructions" },
		});
		child.stdin.end();
		const { code, stderr } = await exited;
		assert.equal(code, 0, `serve exited code=${code}; stderr=${stderr}`);
		const resp = findResponse(lines, 2);
		assert.ok(
			resp && resp.result,
			`no response with id=2; lines=${JSON.stringify(lines)}`,
		);
		wireText = resp.result.messages[0].content.text;
		assert.equal(typeof wireText, "string", "instructions text is not a string");
		assert.ok(wireText.length > 0, "instructions text is empty");
	} finally {
		reap(child);
	}

	const r = runCli(["--json", "instructions"], home);
	assert.equal(
		r.status,
		0,
		`agent-cli --json instructions failed (exit ${r.status}): ${r.stderr}`,
	);
	const cliEnv = JSON.parse(r.stdout);
	assert.ok(cliEnv && cliEnv.data && typeof cliEnv.data.content === "string",
		`CLI instructions envelope missing data.content: ${r.stdout.slice(0, 400)}`);
	const cliContent = cliEnv.data.content;
	assert.ok(cliContent.length > 0, "CLI instructions .data.content is empty");

	assert.equal(
		wireText,
		cliContent,
		"wire prompts/get instructions text differs from `agent-cli --json instructions` .data.content",
	);
});

// ---------------------------------------------------------------------------
// prompts/get brief-plan  ↔  agent-cli --json brief --plan --for "phase-6-mcp"
//
// Byte-for-byte comparison: the wire returns
// `JSON.stringify(briefPlanPrompt({for}), null, 2)` from
// src/api/index.js#briefPlanPrompt — a slim payload of {tool, version,
// schemaVersion, for, suggestedActions, actions, pending}. The CLI's
// `brief --plan` returns the FULL buildBriefPayload envelope (master,
// drift, consolidation, lessons, …) via brief-report.js#buildBriefPayload.
// These shapes are NOT identical by design; this test documents the
// divergence as a finding the way the test framework expects: it fails
// with a clear, actionable message rather than papering over the drift.
// ---------------------------------------------------------------------------

test("stdio parity: prompts/get brief-plan text matches `agent-cli --json brief --plan --for`", async () => {
	const home = freshHome();
	const { child, lines, exited } = startServe(home);
	let wireText;
	try {
		sendMessage(child, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {} },
		});
		sendMessage(child, {
			jsonrpc: "2.0",
			id: 2,
			method: "prompts/get",
			params: { name: "brief-plan", arguments: { for: FOR_TASK } },
		});
		child.stdin.end();
		const { code, stderr } = await exited;
		assert.equal(code, 0, `serve exited code=${code}; stderr=${stderr}`);
		const resp = findResponse(lines, 2);
		assert.ok(
			resp && resp.result,
			`no response with id=2; lines=${JSON.stringify(lines)}`,
		);
		wireText = resp.result.messages[0].content.text;
		assert.equal(typeof wireText, "string", "brief-plan text is not a string");
	} finally {
		reap(child);
	}

	// Real CLI comparison. We pass --for so the CLI's brief envelope includes
	// `forTask`, matching the wire's `for` field on the slim payload.
	const r = runCli(["--json", "brief", "--plan", "--for", FOR_TASK], home);
	assert.equal(
		r.status,
		0,
		`agent-cli --json brief --plan --for failed (exit ${r.status}): ${r.stderr}`,
	);

	// Strip the CLI's envelope and compare against the wire text. The wire
	// payload is JSON.stringify(briefPlanPrompt, null, 2) — i.e. JSON.parse-able
	// already. The CLI's data payload is the same JSON object after a second
	// JSON.stringify(..., null, 2) round-trip.
	const cliEnv = JSON.parse(r.stdout);
	assert.ok(cliEnv && cliEnv.data, `CLI brief envelope missing data: ${r.stdout.slice(0, 400)}`);
	const cliPlanJson = JSON.stringify(cliEnv.data, null, 2);

	if (wireText !== cliPlanJson) {
		// Document the divergence precisely: parse both and diff the key sets,
		// so a maintainer can see EXACTLY which fields drift instead of
		// eyeballing two long JSON blobs.
		const wireParsed = JSON.parse(wireText);
		const wireKeys = Object.keys(wireParsed);
		const cliKeys = Object.keys(cliEnv.data);
		const onlyInWire = wireKeys.filter((k) => !cliKeys.includes(k));
		const onlyInCli = cliKeys.filter((k) => !wireKeys.includes(k));
		assert.fail(
			`DIVERGENCE: wire prompts/get brief-plan text != CLI \`agent-cli --json brief --plan --for\` data.\n` +
				`  wire bytes: ${wireText.length}, CLI bytes: ${cliPlanJson.length}\n` +
				`  wire keys (${wireKeys.length}): ${wireKeys.join(", ")}\n` +
				`  CLI  keys (${cliKeys.length}): ${cliKeys.join(", ")}\n` +
				`  only-in-wire: ${onlyInWire.join(", ") || "(none)"}\n` +
				`  only-in-cli:  ${onlyInCli.join(", ") || "(none)"}\n` +
				`This is the finding MASTER-PLAN §1 decision 10 requires: the wire SDK helper\n` +
				`(src/api/index.js#briefPlanPrompt) and the CLI command (src/brief-report.js#buildBriefPayload)\n` +
				`deliver different shapes for the same logical concept. Fix one side or the other before\n` +
				`closing T6.3.3.`,
		);
	}
	// wireText === cliPlanJson: byte-for-byte parity. (No-op — the assert.fail
	// above is the only way this assertion path runs today.)
});

// ---------------------------------------------------------------------------
// T6.2.6 — write-capability wire parity (spawned stdio, MASTER-PLAN §1 dec 10).
//
// In-process handleMessage tests (test/mcp-write.test.js) are necessary but not
// sufficient: the WRITE wire path must be exercised through a real stdin/stdout
// pipe to detect serializer drift. This spawns `agent-cli serve`, initializes
// with the write capability, drives tools/list (16 tools) + one brain_write
// dry-run, and asserts the JSON-RPC responses are well-formed and the write
// envelope carries apiVersion "2.0.0". The whole session stays off the real
// home (fresh AGENT_CLI_HOME) and off the network.
// ---------------------------------------------------------------------------

test("stdio write-capability: tools/list exposes 16 tools + brain_write dry-run envelope (T6.2.6)", async () => {
	const home = freshHome();
	const { child, lines, exited } = startServe(home);
	let listResp;
	let brainResp;
	try {
		// Offer the write capability (A16) — exact boolean true.
		sendMessage(child, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { capabilities: { experimental: { agentCli: { writeTools: true } } } },
		});
		sendMessage(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
		sendMessage(child, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "brain_write",
				arguments: { kind: "SOUL", content: "wire content", applyChanges: false },
			},
		});
		child.stdin.end();
		const { code, stderr } = await exited;
		assert.equal(code, 0, `serve exited code=${code}; stderr=${stderr}`);

		listResp = findResponse(lines, 2);
		brainResp = findResponse(lines, 3);
		assert.ok(listResp && listResp.result, `no tools/list response; lines=${JSON.stringify(lines)}`);
		assert.ok(brainResp && brainResp.result, `no brain_write response; lines=${JSON.stringify(lines)}`);
	} finally {
		reap(child);
	}

	// tools/list → 16 well-formed tools (6 read + 10 write). This asserts the
	// whole write inventory crossed the real wire, not just the in-process path.
	const tools = listResp.result.tools;
	assert.ok(Array.isArray(tools), "tools/list must return a tools array");
	assert.equal(tools.length, 16, `expected 16 tools, got ${tools.length}`);
	const names = tools.map((t) => t.name);
	for (const n of [
		"brain_write", "lesson_capture", "target_enable", "target_disable",
		"link", "unlink", "memory_upgrade_prepare", "memory_upgrade_apply",
		"snapshot_now", "lesson_consolidate",
	]) {
		assert.ok(names.includes(n), `missing write tool ${n} on the wire`);
	}
	for (const n of ["brief", "doctor", "search", "snapshot", "status", "spect_status"]) {
		assert.ok(names.includes(n), `missing read tool ${n} on the wire`);
	}
	assert.ok(!names.includes("restore"), "restore must NOT cross the wire in v0.8.1");
	// Every advertised tool carries an inputSchema (wire-shape contract).
	for (const t of tools) assert.ok(t.inputSchema, `missing inputSchema for ${t.name}`);

	// brain_write dry-run envelope carries the contract shape + apiVersion 2.0.0.
	assert.equal(brainResp.result.content[0].type, "text");
	const parsed = JSON.parse(brainResp.result.content[0].text);
	assert.equal(typeof parsed.ok, "boolean");
	assert.equal(parsed.command, "brain_write");
	assert.equal(parsed.apiVersion, "2.0.0");
	assert.equal(parsed.data.dryRun, true, "applyChanges:false must stay a dry run on the wire");
	assert.ok(!brainResp.result.isError, "a dry-run brain_write must not be surfaced as an error");
});