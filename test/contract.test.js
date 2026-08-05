// Unit tests for the JSON envelope contract (src/envelope.js).
// Behavioral exit-code tests live in test/cli.test.js (Phase 0 section).
import { test } from "node:test";
import assert from "node:assert";
import {
	API_VERSION,
	EXIT,
	envelope,
	stripAnsi,
	stripAnsiDeep,
	serializeEnvelope,
} from "../src/envelope.js";

test("envelope() builds the versioned shape", () => {
	const env = envelope({ command: "status", data: { ok: true } });
	assert.deepEqual(env, {
		ok: true,
		command: "status",
		apiVersion: API_VERSION,
		data: { ok: true },
	});
});

test("envelope() with an error flips ok and carries the message at top level", () => {
	const env = envelope({ command: "x", data: { id: 1 }, error: "boom" });
	assert.equal(env.ok, false);
	assert.equal(env.error, "boom");
	assert.deepEqual(env.data, { id: 1 });
});

test("envelope() defaults ok:true and empty data", () => {
	const env = envelope({ command: "y" });
	assert.equal(env.ok, true);
	assert.deepEqual(env.data, {});
});

test("EXIT codes match the documented contract", () => {
	assert.deepEqual(EXIT, { OK: 0, ERROR: 1, WORK: 2, PARTIAL: 3 });
});

test("stripAnsi removes SGR escape sequences", () => {
	const s = "\u001b[36mcyan\u001b[39m plain \u001b[1mbold\u001b[22m";
	assert.equal(stripAnsi(s), "cyan plain bold");
	assert.equal(stripAnsi("no escapes"), "no escapes");
	assert.equal(stripAnsi(null), "");
});

test("stripAnsiDeep recurses through arrays and objects", () => {
	const input = {
		a: "\u001b[1mhi\u001b[22m",
		list: ["\u001b[31mred\u001b[39m", 3, { b: "\u001b[90mdim\u001b[39m" }],
		n: null,
	};
	const out = stripAnsiDeep(input);
	assert.equal(out.a, "hi");
	assert.equal(out.list[0], "red");
	assert.equal(out.list[2].b, "dim");
	assert.equal(out.n, null);
});

test("serializeEnvelope emits plain (ANSI-free) JSON", () => {
	const out = serializeEnvelope(
		envelope({ command: "t", data: { msg: "\u001b[36mhi\u001b[39m" } }),
	);
	assert.ok(!out.includes("\u001b"));
	const parsed = JSON.parse(out);
	assert.equal(parsed.data.msg, "hi");
});

test("serializeEnvelope compact mode is single-line", () => {
	const out = serializeEnvelope(envelope({ command: "t" }), { compact: true });
	assert.ok(!out.includes("\n"));
});
