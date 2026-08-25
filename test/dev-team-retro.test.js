// Tests for the dev-team retro persistence surface (src/dev-team-retro.js, P8).
// Uses an isolated AGENT_CLI_HOME so no real ~/.agents is touched (HOME is captured
// at import time, so the env var is set before the module below is imported).
import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HOME_TMP = mkdtempSync(path.join(tmpdir(), "agent-retro-home-"));
process.env.AGENT_CLI_HOME = HOME_TMP;

const { recordRetro, countRetros } = await import("../src/dev-team-retro.js");
const { parseFM } = await import("../src/lessons-lib.js");

const INBOX = path.join(HOME_TMP, ".agents", "lessons", ".inbox");

test("recordRetro writes a parseable dev-team retro to the lessons-store inbox", () => {
	const file = recordRetro({
		sessionSummary: {
			sessionId: "sess-1",
			runs: 5,
			successRate: 0.8,
			rolesActivated: ["dev", "qa"],
		},
		lesson: "# Gate before merge.\nBecause the gate catches flaky.",
		lane: "full",
		rounds: 3,
		escalations: 1,
		source: "test-run",
	});

	assert.ok(file, "expected a written path");
	assert.ok(
		file.startsWith(INBOX),
		`expected path under the lessons inbox, got ${file}`,
	);
	assert.match(path.basename(file), /^dev-team-.*\.md$/);

	const content = readFileSync(file, "utf8");
	const { fm, body } = parseFM(content);
	assert.equal(fm.theme, "dev-team");
	assert.equal(fm.kind, "retro");
	assert.equal(fm.session, "sess-1");
	assert.equal(fm.lane, "full");
	assert.equal(fm.rounds, "3");
	assert.equal(fm.escalations, "1");
	assert.equal(fm.runs, "5");
	assert.equal(fm.successRate, "0.8");
	assert.equal(fm.outcome, "PASS-WITH-NOTES"); // derived from successRate 0.8
	assert.match(body, /# Gate before merge\./);
	assert.match(body, /Because the gate catches flaky\./);
	assert.match(body, /## Source\ntest-run/);
});

test("recordRetro clamps a >300-word body and appends the truncation marker", () => {
	const longLesson = Array.from({ length: 320 }, (_, i) => `word${i}`).join(" ");
	const file = recordRetro({
		sessionSummary: { sessionId: "sess-2", runs: 1, successRate: 1, rolesActivated: ["dev"] },
		lesson: longLesson,
	});
	assert.ok(file);
	const content = readFileSync(file, "utf8");
	// The marker appears exactly once.
	assert.equal((content.match(/\[truncated, original 320 words\]/g) || []).length, 1);
	// The body keeps the first words intact (after the derived title line).
	const { body } = parseFM(content);
	assert.ok(body.includes("word0 word1 word2 word3"), "first words must be preserved");
	assert.ok(body.includes("[truncated, original 320 words]"));
});

test("countRetros counts only theme:dev-team entries (other themes ignored)", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-retro-count-"));
	const inbox = path.join(home, ".agents", "lessons", ".inbox");
	mkdirSync(inbox, { recursive: true });
	writeFileSync(path.join(inbox, "a.md"), "---\ntheme: dev-team\nkind: retro\n---\na");
	writeFileSync(path.join(inbox, "b.md"), "---\ntheme: dev-team\nkind: retro\n---\nb");
	writeFileSync(path.join(inbox, "c.md"), "---\ntheme: other\nkind: retro\n---\nc");
	// theme wins over kind — d is dev-team even though it is not a `retro`.
	writeFileSync(path.join(inbox, "d.md"), "---\ntheme: dev-team\nkind: note\n---\nd");

	assert.equal(countRetros({ home }), 3);
	// A different theme yields zero.
	assert.equal(countRetros({ home, theme: "nope" }), 0);
});

test("countRetros honors a `since` timestamp", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-retro-since-"));
	const inbox = path.join(home, ".agents", "lessons", ".inbox");
	mkdirSync(inbox, { recursive: true });
	writeFileSync(path.join(inbox, "recent.md"), "---\ntheme: dev-team\n---\ny");

	assert.equal(countRetros({ home, since: new Date(0).toISOString() }), 1);
	// A `since` in the future excludes the just-written entry (its mtime is now).
	assert.equal(countRetros({ home, since: new Date(Date.now() + 60_000).toISOString() }), 0);
});

test("countRetros includeCore also counts filed dev-team lessons", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-retro-core-"));
	const root = path.join(home, ".agents", "lessons");
	mkdirSync(path.join(root, ".inbox"), { recursive: true });
	mkdirSync(path.join(root, "dev-team"), { recursive: true });
	writeFileSync(path.join(root, ".inbox", "inbox.md"), "---\ntheme: dev-team\n---\nx");
	writeFileSync(path.join(root, "dev-team", "filed.md"), "---\ntheme: dev-team\n---\ny");

	assert.equal(countRetros({ home }), 1);
	assert.equal(countRetros({ home, includeCore: true }), 2);
});

test("best-effort: an unwritable inbox does not throw and returns a falsy path", () => {
	const file = recordRetro({
		sessionSummary: { sessionId: "sess-x", runs: 1, successRate: 1, rolesActivated: ["dev"] },
		lesson: "lesson body",
	});
	assert.ok(file, "sanity: a normal write succeeds first");

	const inboxIsDir = existsSync(INBOX) && statSync(INBOX).isDirectory();
	if (inboxIsDir) rmSync(INBOX, { recursive: true, force: true });
	// Make `.inbox` a regular FILE so mkdir (via util.writeFileSync) must fail — this
	// works even when running as root (a directory cannot be created over an existing file).
	writeFileSync(INBOX, "not a directory");
	try {
		const result = recordRetro({
			sessionSummary: { sessionId: "sess-u", runs: 1, successRate: 1, rolesActivated: ["dev"] },
			lesson: "should fail to write",
		});
		assert.equal(result, null, "unwritable inbox must yield a falsy path, not throw");
	} finally {
		rmSync(INBOX, { force: true });
		if (inboxIsDir) mkdirSync(INBOX, { recursive: true });
	}
});
