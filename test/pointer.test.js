import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

async function exists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

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
	assert.ok(c.includes("<!-- target: claude -->"));
	assert.ok(c.includes("<!-- scope: global -->"));
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

test("linkTarget treats an empty file as existing native content", async () => {
	const claude = targets.getTarget("claude");
	const p = pointer.targetPath(claude, "global");
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, "");

	const blocked = await pointer.linkTarget(claude, "global", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	assert.equal(blocked.blocked, "native-content");
	assert.equal(await fs.readFile(p, "utf8"), "");
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

test("malformed marker files are treated as native content", async () => {
	const qwen = targets.getTarget("qwen");
	const p = pointer.targetPath(qwen, "global");
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, `${pointer.POINTER_MARK}\n# fake pointer\n`);
	try {
		const cls = await pointer.classify(qwen, "global");
		assert.equal(cls.state, "native");

		const blocked = await pointer.linkTarget(qwen, "global", {
			masterAbs: MASTER_ABS,
			masterTilde: "~/.agents/AGENTS.md",
		});
		assert.equal(blocked.blocked, "native-content");

		const skipped = await pointer.unlinkTarget(qwen, "global");
		assert.equal(skipped.skipped, "native-content");
	} finally {
		await fs.rm(p, { force: true });
	}
});

test("symlinked target paths are treated as native content", async function () {
	const claude = targets.getTarget("claude");
	const p = pointer.targetPath(claude, "global");
	const outside = path.join(TMP, "outside.md");
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.rm(p, { force: true });
	await fs.writeFile(
		outside,
		pointer.pointerContent(claude, "global", {
			masterAbs: MASTER_ABS,
			masterTilde: "~/.agents/AGENTS.md",
		}),
	);
	try {
		await fs.symlink(outside, p);
	} catch (error) {
		if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) {
			this.skip();
		}
		throw error;
	}
	try {
		const cls = await pointer.classify(claude, "global");
		assert.equal(cls.state, "native");

		const blocked = await pointer.linkTarget(claude, "global", {
			masterAbs: MASTER_ABS,
			masterTilde: "~/.agents/AGENTS.md",
		});
		assert.equal(blocked.blocked, "native-content");

		const skipped = await pointer.unlinkTarget(claude, "global");
		assert.equal(skipped.skipped, "native-content");
		assert.equal((await fs.readFile(outside, "utf8")).includes(pointer.POINTER_MARK), true);
	} finally {
		await fs.rm(p, { force: true });
		await fs.rm(outside, { force: true });
	}
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

test("unlinkTarget can preserve a shared pointer path", async () => {
	const codex = targets.getTarget("codex");
	await pointer.linkTarget(codex, "project", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	const p = pointer.targetPath(codex, "project");
	const r = await pointer.unlinkTarget(codex, "project", { preserve: true });
	assert.equal(r.preserved, "shared-target-path");
	assert.equal(
		(await fs.readFile(p, "utf8")).includes(pointer.POINTER_MARK),
		true,
	);
});

test("classify reports pointer-stale when the expected master path changed", async () => {
	const qwen = targets.getTarget("qwen");
	await pointer.linkTarget(qwen, "global", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	pointer.setExpectedCtx({
		masterAbs: path.join(TMP, "DIFFERENT", "AGENTS.md"),
		masterTilde: "~/DIFFERENT/AGENTS.md",
	});
	const cls = await pointer.classify(qwen, "global");
	assert.equal(cls.state, "pointer-stale");
	// restore ctx for any downstream tests
	pointer.setExpectedCtx({
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
});

// ---------------------------------------------------------------------------
// Finding 10 — target-specific rendering
// ---------------------------------------------------------------------------

test("cursor pointerContent wraps the stub in alwaysApply frontmatter", () => {
	const cursor = targets.getTarget("cursor");
	const c = pointer.pointerContent(cursor, "project", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	assert.match(c, /^---\n/);
	assert.match(c, /alwaysApply: true/);
	assert.ok(c.includes(pointer.POINTER_MARK));
	// frontmatter must come first, marker after it
	assert.ok(c.indexOf("---") < c.indexOf(pointer.POINTER_MARK));
	// the pointer body identity lines survive inside the transformed form
	assert.ok(c.includes("<!-- target: cursor -->"));
	assert.ok(c.includes("<!-- scope: project -->"));
});

test("classify reports pointer for a linked transformed (cursor) target", async () => {
	const cursor = targets.getTarget("cursor");
	const p = pointer.targetPath(cursor, "project");
	const r = await pointer.linkTarget(cursor, "project", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	assert.equal(r.linked, true);
	try {
		const cls = await pointer.classify(cursor, "project");
		assert.equal(cls.state, "pointer");
		// the on-disk file really carries the frontmatter
		const disk = await fs.readFile(p, "utf8");
		assert.match(disk, /^---\n/);
		assert.match(disk, /alwaysApply: true/);
	} finally {
		await fs.rm(p, { force: true });
	}
});

test("stale detection still works for a transformed (cursor) target", async () => {
	const cursor = targets.getTarget("cursor");
	const p = pointer.targetPath(cursor, "project");
	await pointer.linkTarget(cursor, "project", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	try {
		pointer.setExpectedCtx({
			masterAbs: path.join(TMP, "OTHER", "AGENTS.md"),
			masterTilde: "~/OTHER/AGENTS.md",
		});
		const cls = await pointer.classify(cursor, "project");
		assert.equal(cls.state, "pointer-stale");
	} finally {
		pointer.setExpectedCtx({
			masterAbs: MASTER_ABS,
			masterTilde: "~/.agents/AGENTS.md",
		});
		await fs.rm(p, { force: true });
	}
});

test("a cursor file with frontmatter but a malformed body is native", async () => {
	const cursor = targets.getTarget("cursor");
	const p = pointer.targetPath(cursor, "project");
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(
		p,
		"---\ndescription: x\nalwaysApply: true\n---\n\n" +
			pointer.POINTER_MARK +
			"\n# fake body\n",
	);
	try {
		const cls = await pointer.classify(cursor, "project");
		assert.equal(cls.state, "native");
		const blocked = await pointer.linkTarget(cursor, "project", {
			masterAbs: MASTER_ABS,
			masterTilde: "~/.agents/AGENTS.md",
		});
		assert.equal(blocked.blocked, "native-content");
	} finally {
		await fs.rm(p, { force: true });
	}
});

test("windsurf project links/unlinks the legacy .windsurfrules alias", async () => {
	const windsurf = targets.getTarget("windsurf");
	const main = pointer.targetPath(windsurf, "project");
	const legacy = path.join(TMP, ".windsurfrules");
	const r = await pointer.linkTarget(windsurf, "project", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	assert.equal(r.linked, true);
	assert.equal(r.legacy.linked, true);
	assert.ok((await fs.readFile(legacy, "utf8")).includes(pointer.POINTER_MARK));
	try {
		const cls = await pointer.classify(windsurf, "project");
		assert.equal(cls.state, "pointer");
		assert.equal(cls.legacy.state, "pointer");

		const u = await pointer.unlinkTarget(windsurf, "project");
		assert.equal(u.unlinked, true);
		assert.equal(u.legacy.unlinked, true);
		assert.equal(await exists(main), false);
		assert.equal(await exists(legacy), false);
	} finally {
		await fs.rm(main, { force: true });
		await fs.rm(legacy, { force: true });
	}
});

test("windsurf legacy alias with native content is blocked (or forced) on link", async () => {
	const windsurf = targets.getTarget("windsurf");
	const main = pointer.targetPath(windsurf, "project");
	const legacy = path.join(TMP, ".windsurfrules");
	await fs.mkdir(path.dirname(main), { recursive: true });
	await fs.writeFile(legacy, "# legacy native rules\n");
	try {
		const r = await pointer.linkTarget(windsurf, "project", {
			masterAbs: MASTER_ABS,
			masterTilde: "~/.agents/AGENTS.md",
		});
		assert.equal(r.linked, true);
		assert.equal(r.legacy.blocked, "native-content");
		assert.equal(await fs.readFile(legacy, "utf8"), "# legacy native rules\n");

		// force overwrites the legacy native content
		const forced = await pointer.linkTarget(windsurf, "project", {
			masterAbs: MASTER_ABS,
			masterTilde: "~/.agents/AGENTS.md",
			force: true,
		});
		assert.equal(forced.legacy.linked, true);
	} finally {
		await fs.rm(main, { force: true });
		await fs.rm(legacy, { force: true });
	}
});

test("unlinkTarget preserves the windsurf legacy alias when requested", async () => {
	const windsurf = targets.getTarget("windsurf");
	const main = pointer.targetPath(windsurf, "project");
	const legacy = path.join(TMP, ".windsurfrules");
	await pointer.linkTarget(windsurf, "project", {
		masterAbs: MASTER_ABS,
		masterTilde: "~/.agents/AGENTS.md",
	});
	const u = await pointer.unlinkTarget(windsurf, "project", { preserve: true });
	assert.equal(u.preserved, "shared-target-path");
	assert.equal(u.legacy.preserved, "shared-target-path");
	assert.equal(await exists(main), true);
	assert.equal(await exists(legacy), true);
	await fs.rm(main, { force: true });
	await fs.rm(legacy, { force: true });
});
