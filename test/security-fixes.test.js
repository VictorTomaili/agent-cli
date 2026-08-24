// Security regression tests for Round 4 hardening.
//
// Covers the three defects the security review surfaced:
//   1. linkTarget with --force + native content → user prose must be
//      preserved in a .agent-cli-backup-<iso> file before the stub write.
//   2. unlinkShareDir must not recursively delete a directory that isn't
//      our symlink (the share link at dst must always be unlink()able, not
//      rm-able; if the path is a real dir, the operation must fail closed).
//   3. sharePathFor must reject share values that escape HOME through `..` or
//      absolute paths (defense against a buggy descriptor committing to
//      src/targets/<id>.js).

import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate HOME BEFORE importing agent-cli modules so nothing real is touched.
const HOME = mkdtempSync(path.join(tmpdir(), "agent-secure-"));
process.env.AGENT_CLI_HOME = HOME;
process.chdir(HOME);

// -----------------------------------------------------------------------------
// Test 1: linkTarget with --force backs up native content
// -----------------------------------------------------------------------------

const pointer = await import("../src/pointer.js");
const targets = await import("../src/targets/index.js");

test("linkTarget with force backs up native content before overwrite", async () => {
	const t = targets.getTarget("claude");
	const proj = HOME; // target HOME for global scope resolution
	// Create a native CLAUDE.md the user wrote.
	const nativePath = path.join(proj, ".claude", "CLAUDE.md");
	mkdirSync(path.dirname(nativePath), { recursive: true });
	const userProse = "# my custom Claude rules\nI am the user.\n";
	writeFileSync(nativePath, userProse);
	pointer.setExpectedCtx({
		masterAbs: path.join(HOME, ".agents", "AGENTS.md"),
		masterTilde: "~/.agents/AGENTS.md",
	});

	const r = await pointer.linkTarget(t, "global", {
		masterAbs: path.join(HOME, ".agents", "AGENTS.md"),
		masterTilde: "~/.agents/AGENTS.md",
		force: true,
	});
	assert.equal(r.linked, true);
	// After the operation, the stub is at the native path…
	const onDisk = readFileSync(nativePath, "utf8");
	assert.ok(onDisk.includes("agent-cli-pointer"));
	// …AND the user's prose is preserved at <nativePath>.agent-cli-backup-<iso>.
	const { readdirSync } = await import("node:fs");
	const dirEntries = readdirSync(path.dirname(nativePath));
	const backups = dirEntries.filter((f) => f.startsWith("CLAUDE.md.agent-cli-backup-"));
	assert.ok(backups.length >= 1, `expected ≥1 backup, got: ${dirEntries}`);
	const backupPath = path.join(path.dirname(nativePath), backups[0]);
	const recovered = readFileSync(backupPath, "utf8");
	assert.ok(
		recovered.includes(userProse),
		`backup must contain original prose: ${recovered.slice(0, 80)}`,
	);
});

test("linkTarget with force does NOT back up when content was already a stub (no false backup)", async () => {
	const t = targets.getTarget("codex");
	const proj = HOME;
	const codexPath = path.join(proj, ".codex", "AGENTS.md");
	mkdirSync(path.dirname(codexPath), { recursive: true });
	// Write an existing correct stub.
	const correct = pointer.pointerContent(t, "global", {
		masterAbs: path.join(HOME, ".agents", "AGENTS.md"),
		masterTilde: "~/.agents/AGENTS.md",
	});
	writeFileSync(codexPath, correct);
	pointer.setExpectedCtx({
		masterAbs: path.join(HOME, ".agents", "AGENTS.md"),
		masterTilde: "~/.agents/AGENTS.md",
	});
	const r = await pointer.linkTarget(t, "global", {
		masterAbs: path.join(HOME, ".agents", "AGENTS.md"),
		masterTilde: "~/.agents/AGENTS.md",
		force: true,
	});
	assert.equal(r.unchanged, true);
	assert.equal(r.backup, undefined, "no backup when content was already correct");
});

test("linkTarget blocks native content without --force (existing behavior)", async () => {
	const t = targets.getTarget("gemini");
	const geminiPath = path.join(HOME, ".gemini", "GEMINI.md");
	mkdirSync(path.dirname(geminiPath), { recursive: true });
	writeFileSync(geminiPath, "# my own gemini rules\n");
	const r = await pointer.linkTarget(t, "global", {
		masterAbs: path.join(HOME, ".agents", "AGENTS.md"),
		masterTilde: "~/.agents/AGENTS.md",
		// force omitted
	});
	assert.equal(r.blocked, "native-content");
	assert.ok(!r.backup, "no backup created when blocked");
});

// -----------------------------------------------------------------------------
// Test 2: unlinkShareDir fails closed on a non-link
// -----------------------------------------------------------------------------

const share = await import("../src/share.js");

test("unlinkShareDir refuses to remove a real directory that isn't a link", () => {
	const src = path.join(HOME, ".skill-cli", "store", "demo");
	const dst = path.join(HOME, ".claude", "skills");
	mkdirSync(src, { recursive: true });
	mkdirSync(dst, { recursive: true });
	// Put a real (non-symlink) file in dst so it's "user native content".
	writeFileSync(path.join(dst, "user-skill.md"), "# user skill\n");

	const r = share.unlinkShareDir(dst, src);
	assert.ok(
		r.skipped === "native-content" || r.skipped === "race-detected",
		`expected skipped, got ${JSON.stringify(r)}`,
	);
	assert.ok(existsSync(dst), "dst directory must remain intact");
	assert.ok(
		existsSync(path.join(dst, "user-skill.md")),
		"user content inside must NOT be deleted",
	);
});

test("unlinkShareDir successfully removes our own symlink", () => {
	const src = path.join(HOME, ".skill-cli", "store", "symtest");
	const dst = path.join(HOME, ".claude", "skills-sym");
	mkdirSync(src, { recursive: true });
	symlinkSync(src, dst, "dir");
	const r = share.unlinkShareDir(dst, src);
	assert.equal(r.unlinked, true);
	assert.ok(!existsSync(dst));
});

test("unlinkShareDir no-ops when the link does not exist", () => {
	const src = path.join(HOME, ".skill-cli", "store", "noop");
	const dst = path.join(HOME, ".claude", "skills-noop");
	const r = share.unlinkShareDir(dst, src);
	assert.equal(r.missing, true);
});

// -----------------------------------------------------------------------------
// Test 3: sharePathFor containment
// -----------------------------------------------------------------------------

test("sharePathFor rejects share values that escape HOME via `..`", () => {
	for (const bad of [
		"../etc/something",
		"../../etc",
		".agents/../../etc",
		"a/b/../../../etc",
	]) {
		const r = share.sharePathFor({ share: { agents: bad } }, "agents");
		assert.equal(r, null, `must reject ${bad}, got ${r}`);
	}
});

test("sharePathFor rejects absolute share paths", () => {
	for (const bad of ["/etc/passwd", "/tmp/foo"]) {
		const r = share.sharePathFor({ share: { agents: bad } }, "agents");
		assert.equal(r, null, `must reject ${bad}, got ${r}`);
	}
});

test("sharePathFor accepts normal home-relative share paths", () => {
	const r = share.sharePathFor({ share: { agents: ".claude/agents" } }, "agents");
	assert.ok(r);
	assert.ok(r.endsWith(path.join(".claude", "agents")));
	assert.ok(r.startsWith(HOME + path.sep) || r === HOME);
});

test("sharePathFor returns null when the target has no share for the kind", () => {
	const r = share.sharePathFor({}, "agents");
	assert.equal(r, null);
	const r2 = share.sharePathFor({ share: {} }, "agents");
	assert.equal(r2, null);
});

// -----------------------------------------------------------------------------
// Targets-registry test addition: every per-target share value must be
// home-relative. Catches a buggy descriptor committing to src/targets/<id>.js
// that slips past code review.
// -----------------------------------------------------------------------------

test("every per-target descriptor's share values are home-relative", () => {
	const { TARGETS } = targets;
	for (const t of TARGETS) {
		if (!t.share) continue;
		for (const [kind, rel] of Object.entries(t.share)) {
			if (rel == null) continue;
			assert.ok(
				!path.isAbsolute(rel),
				`${t.id}.share.${kind} = ${JSON.stringify(rel)} must not be absolute`,
			);
			assert.ok(
				!rel.split(/[\\/]/).includes(".."),
				`${t.id}.share.${kind} = ${JSON.stringify(rel)} must not contain ".."`,
			);
		}
	}
});

// Clean up the temp home after all tests.
test.after(() => {
	try {
		rmSync(HOME, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});