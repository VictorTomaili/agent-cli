// MCP stdio server tests (in-process message handler).
//
// T6.1.3 — Phase 6 resource regression tests (MASTER-PLAN §4.1 acceptance
// 6.1.3 + 6.1.4). One named test per canonical resource URI plus negative
// cases for the A4 rejection shapes and a `resources/list` count assertion.
//
// T6.1.3 + 6.1.4 enumerate 11 canonical resource URIs (10 concrete + 1
// RFC 6570 URI template `brain://skills/{name}`). The skills case is tested
// twice — happy path (an installed skill name) and sad path (no such skill).
//
// T6.3.3 prompt regression tests appended below.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED_SKILL_DIR = path.join(REPO_ROOT, "seed", "skills", "dev-team");

// HOME must be set BEFORE `await import("../src/serve.js")` — serve.js (and
// the SDK chain it imports) captures HOME at module load. AGENT_CLI_HOME is
// the project's single sanctioned override for tests.
process.env.AGENT_CLI_HOME = mkdtempSync(path.join(tmpdir(), "agent-serve-"));
const TMP_HOME = process.env.AGENT_CLI_HOME;

// Pre-install the `dev-team` skill into the temp skill store so the
// `brain://skills/dev-team` happy-path test has a real installed skill to
// resolve. listStore() scans `<HOME>/.skill-cli/store/<name>/SKILL.md`.
const TMP_STORE = path.join(TMP_HOME, ".skill-cli", "store", "dev-team");
let hasInstalledSkill = false;
if (existsSync(SEED_SKILL_DIR)) {
	mkdirSync(TMP_STORE, { recursive: true });
	cpSync(SEED_SKILL_DIR, TMP_STORE, { recursive: true });
	hasInstalledSkill = existsSync(path.join(TMP_STORE, "SKILL.md"));
}

// Seed an active session so `brain://session/current` returns a non-null
// payload — the SDK's sessionCurrent() reads `<HOME>/.agents/.session.json`
// (filters anything with endedAt). Without an active session, serve.js's
// resources/read would surface the SDK's `null` as a misleading "invalid
// skill URI: <uri>" error (a pre-existing serve.js shape we do NOT want to
// rely on for the happy-path test).
const SESSION_FILE = path.join(TMP_HOME, ".agents", ".session.json");
mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
writeFileSync(
	SESSION_FILE,
	JSON.stringify({
		startedAt: new Date().toISOString(),
		cwd: TMP_HOME,
		repo: "agent-cli",
		branch: "main",
		task: "T6.1.3 regression",
		lessonsCaptured: [],
	}) + "\n",
);

const serve = await import("../src/serve.js");

// --- initialize helpers -------------------------------------------------------
// Run `initialize` once before each test to put the server in a sane state.
// T6.1.2's `serverInitialized` flag may matter for some handlers (not yet
// wired in v0.8.0 read-side, but A19 + T6.2.5 add it for writes); initialize
// unconditionally here so future write-tool tests can extend the same setup.
async function init() {
	return serve.handleMessage({
		jsonrpc: "2.0",
		id: 0,
		method: "initialize",
		params: { capabilities: {} },
	});
}

before(async () => {
	await init();
});

// --- existing v0.8.0 smoke tests (unchanged) -----------------------------------

test("initialize returns protocol version + server info", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-06-18", capabilities: {} },
	});
	assert.equal(res.id, 1);
	assert.equal(res.result.protocolVersion, "2025-06-18");
	assert.equal(res.result.serverInfo.name, "agent-cli");
	assert.ok(res.result.capabilities.tools);
});

test("tools/list exposes the read-only tool set", async () => {
	const res = await serve.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	const names = res.result.tools.map((t) => t.name);
	for (const expected of ["brief", "doctor", "search", "snapshot", "status", "spect_status"]) {
		assert.ok(names.includes(expected), `missing tool ${expected}`);
	}
	// every tool has an inputSchema
	for (const t of res.result.tools) assert.ok(t.inputSchema, `no schema for ${t.name}`);
});

test("tools/call brief returns a text content block", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: { name: "brief", arguments: { offline: true } },
	});
	assert.equal(res.result.isError, false);
	assert.equal(res.result.content[0].type, "text");
	const parsed = JSON.parse(res.result.content[0].text);
	assert.ok("suggestedActions" in parsed || "health" in parsed);
});

test("tools/call unknown tool returns -32602", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 4,
		method: "tools/call",
		params: { name: "nope" },
	});
	assert.equal(res.error.code, -32602);
});

test("unknown method returns -32601; ping returns empty result", async () => {
	const res = await serve.handleMessage({ jsonrpc: "2.0", id: 5, method: "frobnicate" });
	assert.equal(res.error.code, -32601);
	const pong = await serve.handleMessage({ jsonrpc: "2.0", id: 6, method: "ping" });
	assert.deepEqual(pong.result, {});
});

test("notifications produce no response", async () => {
	const res = await serve.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	assert.equal(res, null);
});

// --- T6.1.3: 11 named resources/read tests (one per canonical URI) -----------
//
// Each test asserts the contract documented in serve.js#resources/read:
//   result.contents[0].uri === uri
//   result.contents[0].mimeType === "application/json"
//   result.contents[0].text parses as JSON
// (The SDK guarantees this contract; resources/read never throws — failures
// surface as structured error responses.)

const CONCRETE_URIS = [
	"brain://files/SOUL.md",
	"brain://files/IDENTITY.md",
	"brain://files/USER.md",
	"brain://files/LESSONS.md",
	"brain://files/ENVIRONMENTS.md",
	"brain://files/MODELS.md",
	"brain://targets",
	"brain://lessons/inbox",
	"brain://lessons/core",
	"brain://session/current",
];

for (const uri of CONCRETE_URIS) {
	test(`resources/read ${uri} returns contents with metadata`, async () => {
		await init();
		const res = await serve.handleMessage({
			jsonrpc: "2.0",
			id: 100,
			method: "resources/read",
			params: { uri },
		});
		assert.ok(res.result, `expected result for ${uri}, got ${JSON.stringify(res)}`);
		const contents = res.result.contents;
		assert.ok(Array.isArray(contents) && contents.length === 1, `expected 1 content block for ${uri}`);
		assert.equal(contents[0].uri, uri);
		assert.equal(contents[0].mimeType, "application/json");
		// text must be valid JSON — the SDK contract is application/json
		assert.doesNotThrow(() => JSON.parse(contents[0].text), `text for ${uri} is not valid JSON`);
	});
}

// --- brain://skills/{name} — happy path (installed skill) ---------------------
//
// Parametrized: the URI template resolves to an installed skill name. We seeded
// `dev-team` into the temp store above; if seeding failed (e.g. seed removed),
// skip rather than fail spuriously — the sad-path test below still covers the
// production failure shape.
test("resources/read brain://skills/dev-team (installed) returns the skill manifest", async () => {
	if (!hasInstalledSkill) return; // seed missing — sad-path test still covers failure shape
	await init();
	const uri = "brain://skills/dev-team";
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 110,
		method: "resources/read",
		params: { uri },
	});
	assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
	const contents = res.result.contents;
	assert.ok(Array.isArray(contents) && contents.length === 1);
	assert.equal(contents[0].uri, uri);
	assert.equal(contents[0].mimeType, "application/json");
	const parsed = JSON.parse(contents[0].text);
	// Installed-skill envelope: name/version/source/scope per skill.js.
	assert.equal(parsed.name, "dev-team");
	assert.ok("manifest" in parsed, "skill envelope missing manifest");
});

// --- brain://skills/{name} — sad path (not installed) -------------------------
//
// Per sdk/index.js#skillManifest, getInstalledSkill returns
// `{ ok: false, reason: "..." }` for any failure — NOT a thrown error.
// resources/read propagates that into contents[0].text with mimeType
// "application/json" (the envelope shape), never an MCP `-32602`.
test("resources/read brain://skills/does-not-exist returns ok:false in text (no throw)", async () => {
	await init();
	const uri = "brain://skills/does-not-exist";
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 111,
		method: "resources/read",
		params: { uri },
	});
	// Must NOT throw — handleMessage returns the structured failure.
	assert.ok(res.result, `expected result envelope, got ${JSON.stringify(res)}`);
	const contents = res.result.contents;
	assert.ok(Array.isArray(contents) && contents.length === 1);
	assert.equal(contents[0].uri, uri);
	assert.equal(contents[0].mimeType, "application/json");
	const parsed = JSON.parse(contents[0].text);
	assert.equal(parsed.ok, false, `expected ok:false, got ${JSON.stringify(parsed)}`);
	assert.ok(parsed.reason, "expected a reason field on the ok:false envelope");
});

// --- T6.1.3 negative cases (acceptance 6.1.3) ---------------------------------

test("resources/read unknown uri returns -32602 'unknown resource: <uri>'", async () => {
	await init();
	const uri = "brain://nope/not-a-real-uri";
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 200,
		method: "resources/read",
		params: { uri },
	});
	assert.equal(res.error.code, -32602);
	assert.equal(res.error.message, `unknown resource: ${uri}`);
	// A4 — the rejection carries data.subscribable so the host can surface
	// the canonical subscribable set without a separate query.
	assert.ok(Array.isArray(res.error.data?.subscribable), "missing data.subscribable");
});

test("resources/subscribe brain://files/SOUL.md (valid but not subscribable) returns -32602", async () => {
	await init();
	const uri = "brain://files/SOUL.md";
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 201,
		method: "resources/subscribe",
		params: { uri },
	});
	assert.equal(res.error.code, -32602);
	assert.equal(res.error.message, `resource does not support subscribe: ${uri}`);
	assert.ok(Array.isArray(res.error.data?.subscribable), "missing data.subscribable");
});

test("resources/subscribe brain://brief (subscribable) returns empty result", async () => {
	await init();
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 202,
		method: "resources/subscribe",
		params: { uri: "brain://brief" },
	});
	assert.deepEqual(res.result, {});
});

// --- T6.1.3 count assertion (acceptance 6.1.4) -------------------------------

test("resources/list returns 11 entries (10 concrete URIs + 1 RFC 6570 template)", async () => {
	await init();
	const res = await serve.handleMessage({ jsonrpc: "2.0", id: 300, method: "resources/list" });
	const resources = res.result.resources;
	assert.ok(Array.isArray(resources), "resources/list did not return an array");
	assert.equal(resources.length, 11, `expected 11 entries, got ${resources.length}`);
	// Every entry has a uri + mimeType (the wire-shape contract).
	for (const r of resources) {
		assert.ok(typeof r.uri === "string" && r.uri.length > 0, `missing uri on ${JSON.stringify(r)}`);
		assert.equal(r.mimeType, "application/json", `bad mimeType on ${r.uri}`);
	}
});

// --- T6.3.3: Phase 6 prompt regression tests (6 named tests) -----------------
//
// prompts/list + prompts/get wire up to PROMPT_DESCRIPTORS in
// src/serve/registry.js (T6.0.1). The in-process handleMessage is the unit
// under test here; the spawned stdio parity test in test/serve-stdio.test.js
// is the load-bearing byte-comparison check against the real CLI (per
// MASTER-PLAN §1 decision 10: in-process tests are necessary but not
// sufficient — the wire path MUST be exercised through a real stdin/stdout
// pipe to detect serializer drift).

test("prompts/list returns 3 prompts (session-start, instructions, brief-plan)", async () => {
	const res = await serve.handleMessage({ jsonrpc: "2.0", id: 400, method: "prompts/list" });
	assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
	const { prompts } = res.result;
	assert.ok(Array.isArray(prompts), "prompts/list did not return an array");
	assert.equal(prompts.length, 3, `expected 3 prompts, got ${prompts.length}`);
	// Sorted names — the registry lists session-start, instructions, brief-plan
	// in that order, so a sort to a canonical array is the right shape check.
	const names = prompts.map((p) => p.name).sort();
	assert.deepEqual(
		names,
		["brief-plan", "instructions", "session-start"],
		`unexpected prompt names: ${JSON.stringify(names)}`,
	);
	// Every entry carries the wire-shape contract: non-empty description +
	// arguments array (can be empty for prompts without args).
	for (const p of prompts) {
		assert.equal(
			typeof p.description,
			"string",
			`${p.name} description is not a string`,
		);
		assert.ok(
			p.description.length > 0,
			`${p.name} description is empty`,
		);
		assert.ok(
			Array.isArray(p.arguments),
			`${p.name} arguments is not an array`,
		);
	}
});

test("prompts/get session-start returns a single user text message with non-empty text", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 401,
		method: "prompts/get",
		params: { name: "session-start" },
	});
	assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
	const msgs = res.result.messages;
	assert.ok(Array.isArray(msgs), "messages is not an array");
	assert.equal(msgs.length, 1, `expected 1 message, got ${msgs.length}`);
	assert.equal(msgs[0].role, "user");
	assert.equal(msgs[0].content.type, "text");
	assert.equal(
		typeof msgs[0].content.text,
		"string",
		"session-start text is not a string",
	);
	assert.ok(
		msgs[0].content.text.length > 0,
		"session-start text is empty",
	);
});

test("prompts/get instructions returns a single user text message with non-empty text", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 402,
		method: "prompts/get",
		params: { name: "instructions" },
	});
	assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
	const msgs = res.result.messages;
	assert.ok(Array.isArray(msgs), "messages is not an array");
	assert.equal(msgs.length, 1, `expected 1 message, got ${msgs.length}`);
	assert.equal(msgs[0].role, "user");
	assert.equal(msgs[0].content.type, "text");
	assert.equal(
		typeof msgs[0].content.text,
		"string",
		"instructions text is not a string",
	);
	assert.ok(
		msgs[0].content.text.length > 0,
		"instructions text is empty",
	);
});

test("prompts/get brief-plan JSON-stringifies a structured payload (with `for` arg)", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 403,
		method: "prompts/get",
		params: { name: "brief-plan", arguments: { for: "phase-6-mcp" } },
	});
	assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
	const msgs = res.result.messages;
	assert.equal(msgs.length, 1, `expected 1 message, got ${msgs.length}`);
	assert.equal(msgs[0].role, "user");
	assert.equal(msgs[0].content.type, "text");
	// brief-plan's `text` is a JSON-stringified structured payload (per
	// serve.js PRODUCERS_PROMPTS). Hosts JSON.parse it client-side.
	let parsed;
	assert.doesNotThrow(
		() => {
			parsed = JSON.parse(msgs[0].content.text);
		},
		"brief-plan text is not valid JSON",
	);
	assert.equal(
		parsed.for,
		"phase-6-mcp",
		`brief-plan payload must echo the for argument; got ${JSON.stringify(parsed.for)}`,
	);
});

test("prompts/get unknown prompt returns -32602 'unknown prompt: <name>'", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 404,
		method: "prompts/get",
		params: { name: "not-a-real-prompt" },
	});
	assert.ok(res.error, `expected error, got ${JSON.stringify(res)}`);
	assert.equal(res.error.code, -32602);
	assert.equal(res.error.message, "unknown prompt: not-a-real-prompt");
});

test("prompts/get without a name returns -32602 (params missing)", async () => {
	const res = await serve.handleMessage({
		jsonrpc: "2.0",
		id: 405,
		method: "prompts/get",
		params: {},
	});
	assert.ok(res.error, `expected error, got ${JSON.stringify(res)}`);
	assert.equal(res.error.code, -32602);
	// Message must be non-empty so a host can surface a useful diagnostic.
	// The wire code concatenates "unknown prompt: " with the missing name
	// (undefined → "undefined" via String()); either is acceptable.
	assert.equal(typeof res.error.message, "string");
	assert.ok(
		res.error.message.length > 0,
		"error message must be non-empty",
	);
});
