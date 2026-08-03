import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

// Isolate HOME + cwd BEFORE importing agent-cli modules so nothing real is touched.
const TMP = mkdtempSync(path.join(tmpdir(), "agent-ptr-"));
process.env.AGENT_CLI_HOME = TMP;
process.chdir(TMP);

const pointer = await import("../src/pointer.js");
const targets = await import("../src/targets.js");
const MASTER_ABS = path.join(TMP, ".agents", "AGENTS.md");
pointer.setExpectedCtx({
	masterAbs: MASTER_ABS,
	masterTilde: "~/.agents/AGENTS.md",
});

test("pointerContent includes the mark and master path", () => {
	const claude = targets.getTarget("claude");
	const c = pointer.pointerContent(claude, "global", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	assert.ok(c.includes(pointer.POINTER_MARK));
	assert.ok(c.includes(MASTER_ABS));
});

test("linkTarget writes a pointer, then is idempotent", async () => {
	const codex = targets.getTarget("codex");
	const r1 = await pointer.linkTarget(codex, "global", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	assert.equal(r1.linked, true);
	const r2 = await pointer.linkTarget(codex, "global", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	assert.equal(r2.unchanged, true);
});

test("linkTarget blocks on native content unless forced", async () => {
	const claude = targets.getTarget("claude");
	const p = pointer.targetPath(claude, "global");
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, "# real native content\n");

	const blocked = await pointer.linkTarget(claude, "global", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	assert.equal(blocked.blocked, "native-content");

	const forced = await pointer.linkTarget(claude, "global", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
		force: true,
	});
	assert.equal(forced.linked, true);
});

test("classify distinguishes missing / pointer / native", async () => {
	const qwen = targets.getTarget("qwen");
	const missing = await pointer.classify(qwen, "global");
	assert.equal(missing.state, "missing");

	await pointer.linkTarget(qwen, "global", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	const pointed = await pointer.classify(qwen, "global");
	assert.equal(pointed.state, "pointer");
});

test("unlinkTarget refuses to delete native content", async () => {
	const gemini = targets.getTarget("gemini");
	const p = pointer.targetPath(gemini, "global");
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, "# native\n");
	const r = await pointer.unlinkTarget(gemini, "global");
	assert.equal(r.skipped, "native-content");
});

test("targetPath/linkTarget/classify handle an unsupported scope (null path)", async () => {
	const cursor = targets.getTarget("cursor"); // global: null
	assert.equal(pointer.targetPath(cursor, "global"), null);
	const r = await pointer.linkTarget(cursor, "global", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	assert.equal(r.skipped, "unsupported");
	const cls = await pointer.classify(cursor, "global");
	assert.equal(cls.state, "unsupported");
});

test("unlinkTarget reports missing when the stub file is absent", async () => {
	const cline = targets.getTarget("cline");
	const r = await pointer.unlinkTarget(cline, "global");
	assert.equal(r.missing, true);
});

test("unlinkTarget removes an actual pointer stub", async () => {
	const qwen = targets.getTarget("qwen");
	await pointer.linkTarget(qwen, "global", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	const r = await pointer.unlinkTarget(qwen, "global");
	assert.equal(r.unlinked, true);
});
