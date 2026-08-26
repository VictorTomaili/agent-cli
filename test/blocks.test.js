import { test } from "node:test";
import assert from "node:assert";
import {
	ensureBlocks,
	injectAgentCliBlock,
	injectCommunicationBlock,
	hasAgentCliBlock,
	hasCommunicationBlock,
	BEGIN_AGENT_CLI,
	END_AGENT_CLI,
	BEGIN_COMMUNICATION,
	END_COMMUNICATION,
	AGENT_CLI_BLOCK,
} from "../src/blocks.js";

test("ensureBlocks injects agent-cli, communication and skill-cli blocks", () => {
	const out = ensureBlocks("# hello\n");
	assert.ok(out.includes(BEGIN_AGENT_CLI));
	assert.ok(out.includes(END_AGENT_CLI));
	assert.ok(out.includes(BEGIN_COMMUNICATION));
	assert.ok(out.includes(END_COMMUNICATION));
	assert.ok(out.includes("<!-- BEGIN skill-cli -->"));
	assert.ok(out.includes("<!-- END skill-cli -->"));
	assert.ok(hasAgentCliBlock(out));
	assert.ok(hasCommunicationBlock(out));
});

test("ensureBlocks orders the blocks agent-cli → communication → skill-cli", () => {
	const out = ensureBlocks("# hello\n");
	const iAgent = out.indexOf(BEGIN_AGENT_CLI);
	const iComm = out.indexOf(BEGIN_COMMUNICATION);
	const iSkill = out.indexOf("<!-- BEGIN skill-cli -->");
	assert.ok(
		iAgent >= 0 && iComm > iAgent,
		"communication block must follow agent-cli",
	);
	assert.ok(iSkill > iComm, "skill-cli block must follow communication");
	// The communication block must sit DIRECTLY after the agent-cli block.
	assert.equal(
		out.slice(out.indexOf(END_AGENT_CLI), iComm),
		`${END_AGENT_CLI}\n\n`,
	);
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

test("ensureBlocks handles null/empty content (still injects all blocks)", () => {
	const out = ensureBlocks(null);
	assert.ok(hasAgentCliBlock(out));
	assert.ok(hasCommunicationBlock(out));
	assert.ok(out.includes("<!-- BEGIN skill-cli -->"));
});

test("agent-cli block teaches install/update via @victortomaili/agent-cli", () => {
	assert.ok(AGENT_CLI_BLOCK.includes("## Install & update"));
	assert.ok(AGENT_CLI_BLOCK.includes("`npm i -g @victortomaili/agent-cli`"));
	assert.ok(AGENT_CLI_BLOCK.includes("update check"));
	assert.ok(AGENT_CLI_BLOCK.includes("Never reimplement its functions by hand"));
});

test("agent-cli block teaches the agent-cli run sub-agent dispatch", () => {
	assert.ok(AGENT_CLI_BLOCK.includes("## Sub-agent dispatch (agent-cli run)"));
	assert.ok(AGENT_CLI_BLOCK.includes('`agent-cli run "<task>"`'));
	assert.ok(AGENT_CLI_BLOCK.includes("--tool <pi|codex>"));
	assert.ok(AGENT_CLI_BLOCK.includes("--read-only"));
	assert.ok(AGENT_CLI_BLOCK.includes("--timeout <seconds>"));
	// Genericized deliberately: the contract forbids naming a concrete provider
	// or model anywhere in AGENTS.md, so the example is a placeholder shape.
	assert.ok(AGENT_CLI_BLOCK.includes("agent-cli configure run <tool> --provider <provider>"));
	assert.ok(AGENT_CLI_BLOCK.includes("tool:provider/model[:thinking]"));
	assert.ok(AGENT_CLI_BLOCK.includes("never silently"));
});

test("communication block carries the contract verbatim", () => {
	const out = ensureBlocks("# hi\n");
	const block = out.slice(
		out.indexOf(BEGIN_COMMUNICATION),
		out.indexOf(END_COMMUNICATION) + END_COMMUNICATION.length,
	);
	assert.ok(block.includes("## Communication Contract"));
	assert.ok(
		block.includes(
			"Concise by default. Lead with the result. No preamble, no narration of what you",
		),
	);
	// The exceptions carve-out must survive any future trimming of the contract:
	// truncating an error or a destructive-action preview is the one way
	// "be concise" turns into a safety problem.
	assert.ok(block.includes("error messages and stack traces"));
	assert.ok(
		block.includes(
			"the exact effect of a destructive or irreversible action awaiting confirmation",
		),
	);
	assert.ok(block.includes("## Style"));
	assert.ok(block.includes("## Reference codes"));
	assert.ok(block.includes("## Boundaries"));
	assert.ok(block.includes("## Aliases"));
	assert.ok(block.includes("## Example"));
	// Self-attribution ban. Worded to survive a harness that issues its own
	// trailer rule imperatively rather than as a default — an earlier version
	// said only "never add a co-author", which a model reads as beaten by a
	// direct system-prompt instruction, and which also blocked a legitimate
	// human co-author the user asked for.
	assert.ok(block.includes("Never attribute a commit to yourself."));
	assert.ok(
		block.includes("as a default, a convention, or a direct\n  instruction"),
		"the ban must bind regardless of how the harness phrases its own rule",
	);
	assert.ok(
		block.includes("human co-author the user\n  names in this session"),
		"a human co-author the user names must stay permitted",
	);
});

test("injectCommunicationBlock replaces a stale region in place", () => {
	const stale =
		"# hi\n\n<!-- BEGIN agent-cli -->OLD<!-- END agent-cli -->\n\n<!-- BEGIN communication -->STALE<!-- END communication -->\n\ntail";
	const out = injectCommunicationBlock(stale);
	assert.ok(!out.includes("STALE"));
	assert.ok(out.includes("## Communication Contract"));
	assert.ok(out.endsWith("tail"), "trailing user content must survive");
});

test("injectCommunicationBlock inserts directly after an existing agent-cli block", () => {
	const withAgentOnly =
		"# hi\n\n<!-- BEGIN agent-cli -->OLD<!-- END agent-cli -->\n\nuser note";
	const out = injectCommunicationBlock(withAgentOnly);
	assert.ok(
		out.includes(`${END_AGENT_CLI}\n\n${BEGIN_COMMUNICATION}`),
		"communication block must be inserted right after the agent-cli block",
	);
	assert.ok(out.includes("user note"));
});

test("ensureBlocks adds the communication block to a master that has agent-cli but lacks it", () => {
	const existing =
		"# master\n\n<!-- BEGIN agent-cli -->x<!-- END agent-cli -->\n\n<!-- BEGIN skill-cli -->y<!-- END skill-cli -->\n\n## My notes\n";
	const out = ensureBlocks(existing);
	assert.ok(hasCommunicationBlock(out));
	assert.ok(
		out.indexOf(BEGIN_COMMUNICATION) > out.indexOf(END_AGENT_CLI) &&
			out.indexOf(BEGIN_COMMUNICATION) < out.indexOf("<!-- BEGIN skill-cli -->"),
		"communication must land between agent-cli and skill-cli",
	);
	assert.ok(out.includes("## My notes"), "unmanaged content lost");
	// idempotent
	assert.equal(ensureBlocks(out), out);
});

test("hasCommunicationBlock is false on plain/null/empty content", () => {
	assert.equal(hasCommunicationBlock("# nothing"), false);
	assert.equal(hasCommunicationBlock(null), false);
	assert.equal(hasCommunicationBlock(""), false);
});
