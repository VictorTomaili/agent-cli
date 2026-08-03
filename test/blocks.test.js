import { test } from "node:test";
import assert from "node:assert";
import {
	ensureBlocks,
	injectAgentCliBlock,
	hasAgentCliBlock,
	BEGIN_AGENT_CLI,
	END_AGENT_CLI,
} from "../src/blocks.js";

test("ensureBlocks injects both agent-cli and skill-cli blocks", () => {
	const out = ensureBlocks("# hello\n");
	assert.ok(out.includes(BEGIN_AGENT_CLI));
	assert.ok(out.includes(END_AGENT_CLI));
	assert.ok(out.includes("<!-- BEGIN skill-cli -->"));
	assert.ok(out.includes("<!-- END skill-cli -->"));
	assert.ok(hasAgentCliBlock(out));
});

test("ensureBlocks is idempotent", () => {
	const a = ensureBlocks("# hi\n");
	const b = ensureBlocks(a);
	assert.equal(a, b);
});

test("ensureBlocks refreshes a stale agent-cli block in place", () => {
	const stale =
		"# hi\n\n<!-- BEGIN agent-cli -->OLD CONTENT<!-- END agent-cli -->\n";
	const out = ensureBlocks(stale);
	assert.ok(!out.includes("OLD CONTENT"));
	assert.ok(hasAgentCliBlock(out));
});

test("hasAgentCliBlock is false on plain content", () => {
	assert.equal(hasAgentCliBlock("# nothing here"), false);
});

test("hasAgentCliBlock is false on null/empty/undefined", () => {
	assert.equal(hasAgentCliBlock(null), false);
	assert.equal(hasAgentCliBlock(""), false);
	assert.equal(hasAgentCliBlock(undefined), false);
});

test("injectAgentCliBlock appends when absent and replaces a stale region", () => {
	const appended = injectAgentCliBlock("# hi\n");
	assert.ok(appended.includes(BEGIN_AGENT_CLI));
	const replaced = injectAgentCliBlock(
		"# hi\n\n<!-- BEGIN agent-cli -->OLD<!-- END agent-cli -->\n",
	);
	assert.ok(!replaced.includes("OLD"));
	assert.ok(replaced.includes(BEGIN_AGENT_CLI));
});

test("ensureBlocks handles null/empty content (still injects both blocks)", () => {
	const out = ensureBlocks(null);
	assert.ok(hasAgentCliBlock(out));
	assert.ok(out.includes("<!-- BEGIN skill-cli -->"));
});
