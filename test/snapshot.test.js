import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	existsSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-snap-"));
process.env.AGENT_CLI_HOME = TMP;

const snap = await import("../src/snapshot.js");
const brain = () => path.join(TMP, ".agents");

test("listSnapshots is [] when no snapshots exist", () => {
	assert.deepEqual(snap.listSnapshots(), []);
});

test("snapshot copies the brain and reports a file count", () => {
	mkdirSync(path.join(brain(), "agents"), { recursive: true });
	writeFileSync(path.join(brain(), "AGENTS.md"), "# master\n");
	writeFileSync(path.join(brain(), "agents", "scout.md"), "x");
	const r = snap.snapshot();
	assert.equal(r.ok, true);
	assert.ok(r.files >= 2, "should count at least the 2 seeded files");
	assert.ok(existsSync(r.path));
	assert.ok(existsSync(path.join(r.path, ".snapshot.json")));
});

test("restore a nonexistent snapshot fails cleanly", () => {
	const r = snap.restore("does-not-exist");
	assert.equal(r.ok, false);
	assert.equal(r.reason, "no such snapshot");
});

test("restore replaces brain contents and makes a pre-restore backup", () => {
	const before = snap.snapshot();
	writeFileSync(path.join(brain(), "AGENTS.md"), "# changed after snapshot\n");
	const r = snap.restore(before.name);
	assert.equal(r.ok, true);
	assert.equal(
		readFileSync(path.join(brain(), "AGENTS.md"), "utf8"),
		"# master\n",
	);
	assert.ok(existsSync(r.preRestoreBackup));
});

test("multiple snapshots are listed newest-first", () => {
	const list = snap.listSnapshots();
	assert.ok(list.length >= 2);
});

test("restore rejects traversal and malformed snapshot names before mutation", () => {
	const before = readFileSync(path.join(brain(), "AGENTS.md"), "utf8");
	const traversal = snap.restore("../../outside");
	assert.equal(traversal.ok, false);
	assert.equal(traversal.reason, "invalid snapshot name");

	mkdirSync(path.join(snap.SNAP_DIR, "malformed"), { recursive: true });
	const malformed = snap.restore("malformed");
	assert.equal(malformed.ok, false);
	assert.equal(malformed.reason, "invalid snapshot contents");
	assert.equal(readFileSync(path.join(brain(), "AGENTS.md"), "utf8"), before);
});

test("snapshotDiff lists added/changed/removed against the current brain", () => {
	const r1 = snap.snapshot();
	writeFileSync(path.join(brain(), "NEW.md"), "new\n");
	writeFileSync(path.join(brain(), "AGENTS.md"), "# master v2\n");
	const d = snap.snapshotDiff(r1.name);
	assert.equal(d.ok, true);
	assert.ok(d.added.includes("NEW.md"));
	assert.ok(d.changed.includes("AGENTS.md"));
});

test("diffSnapshots compares two snapshots at the file level", () => {
	const a = snap.snapshot();
	writeFileSync(path.join(brain(), "AGENTS.md"), "# master v3\n");
	const b = snap.snapshot();
	const d = snap.diffSnapshots(a.name, b.name);
	assert.equal(d.ok, true);
	assert.ok(d.changed.includes("AGENTS.md"));
});

test("pruneSnapshots keeps at most n and removes the oldest", () => {
	snap.snapshot();
	snap.snapshot();
	const before = snap.listSnapshots().length;
	const { pruned } = snap.pruneSnapshots(1);
	assert.ok(pruned.length >= before - 1);
	assert.ok(snap.listSnapshots().length <= 1);
});
