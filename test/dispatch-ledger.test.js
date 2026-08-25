// Unit tests for the session dispatch ledger (src/dispatch-ledger.js).
// Each test uses an isolated AGENT_CLI_HOME so no real ~/.agents is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	chmodSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	recordDispatch,
	startDispatch,
	readLedger,
	clearLedger,
	ledgerPath,
} from "../src/dispatch-ledger.js";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Point AGENT_CLI_HOME at a fresh temp dir and return it. */
function freshHome() {
	const home = mkdtempSync(path.join(tmpdir(), "agent-cli-ledger-"));
	process.env.AGENT_CLI_HOME = home;
	return home;
}

test("recordDispatch writes a parseable line to the right path under AGENT_CLI_HOME", () => {
	const home = freshHome();
	const entry = recordDispatch({
		role: "dev",
		task: "write a thing",
		model: "openai/gpt-5",
		status: "succeeded",
		note: "first pass",
	});
	assert.equal(entry.role, "dev");

	const p = ledgerPath();
	assert.ok(existsSync(p), `ledger file missing at ${p}`);
	assert.ok(
		p.startsWith(path.join(home, ".agents", ".logs")),
		`ledger path must live under the session .logs dir: ${p}`,
	);
	assert.ok(p.endsWith(".dispatch.log"), `wrong ledger suffix: ${p}`);

	const lines = readFileSync(p, "utf8")
		.split("\n")
		.filter((l) => l.trim());
	assert.equal(lines.length, 1);
	const parsed = JSON.parse(lines[0]);
	assert.equal(parsed.role, "dev");
	assert.equal(parsed.task, "write a thing");
	assert.equal(parsed.model, "openai/gpt-5");
	assert.equal(parsed.status, "succeeded");
	assert.equal(parsed.note, "first pass");
	assert.ok(UUID_RE.test(parsed.session), `session not a UUIDv4: ${parsed.session}`);
	assert.equal(typeof parsed.ts, "string");
	assert.equal(typeof parsed.ms, "number");
	assert.equal(parsed.ms, 0); // direct records carry no timing reference
});

test("startDispatch returns a finish that records with elapsed ms >= 0", () => {
	freshHome();
	const finish = startDispatch({ role: "qa", task: "run the gate", model: "zai/glm-5.2" });
	const entry = finish("succeeded", "gate green");
	assert.equal(entry.role, "qa");
	assert.equal(entry.status, "succeeded");
	assert.equal(entry.note, "gate green");
	assert.ok(
		Number.isFinite(entry.ms) && entry.ms >= 0,
		`ms should be a non-negative number, got ${entry.ms}`,
	);
	assert.ok(entry.ms < 60_000, `ms looks unexpectedly large: ${entry.ms}`);

	const { entries } = readLedger();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].task, "run the gate");
	assert.equal(entries[0].model, "zai/glm-5.2");
});

test("two records + clear + read again works (order-independent)", () => {
	freshHome();
	recordDispatch({ role: "dev", task: "first", model: "m", status: "started" });
	recordDispatch({ role: "qa", task: "second", model: "m", status: "succeeded" });
	assert.equal(readLedger().entries.length, 2);

	const cleared = clearLedger();
	assert.equal(cleared.cleared, true);
	assert.equal(readLedger().entries.length, 0);

	// Order-independence: record again after clear, then clear works again.
	recordDispatch({ role: "dev", task: "third", model: "m", status: "cancelled" });
	assert.equal(readLedger().entries.length, 1);
	assert.equal(clearLedger().cleared, true);
	assert.equal(readLedger().entries.length, 0);
});

test("recordDispatch clamps task to the 120-char schema cap", () => {
	freshHome();
	const long = "x".repeat(300);
	const entry = recordDispatch({ role: "dev", task: long, model: "m", status: "succeeded" });
	assert.equal(entry.task.length, 120);
	assert.equal(readLedger().entries[0].task.length, 120);
});

test("recordDispatch defaults empty/missing model to 'unknown'", () => {
	freshHome();
	const entry = recordDispatch({ role: "dev", task: "no model", model: "", status: "started" });
	assert.equal(entry.model, "unknown");
	const entry2 = recordDispatch({ role: "dev", task: "no model field" });
	assert.equal(entry2.model, "unknown");
});

test("recordDispatch coerces an out-of-enum status to 'failed' (closed schema)", () => {
	freshHome();
	const entry = recordDispatch({ role: "dev", task: "x", model: "m", status: "bogus" });
	assert.equal(entry.status, "failed");
});

test("best-effort: an unwritable .logs dir does not make recordDispatch throw", () => {
	const home = freshHome();
	const logs = path.join(home, ".agents", ".logs");
	mkdirSync(logs, { recursive: true });
	chmodSync(logs, 0o000);
	try {
		// Must never throw; returns a best-effort entry object even on write failure.
		const entry = recordDispatch({
			role: "dev",
			task: "unwritable",
			model: "m",
			status: "started",
		});
		assert.ok(entry && typeof entry === "object");
	} finally {
		chmodSync(logs, 0o755);
	}
});
