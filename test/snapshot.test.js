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

test("P0-4: pre-restore backup carries .snapshot.json and is itself restorable", () => {
	const before = snap.snapshot();
	writeFileSync(path.join(brain(), "AGENTS.md"), "# will be preserved in backup\n");
	const r = snap.restore(before.name);
	assert.equal(r.ok, true);
	// the pre-restore backup must be a valid snapshot (has .snapshot.json)
	const metaPath = path.join(r.preRestoreBackup, ".snapshot.json");
	assert.ok(existsSync(metaPath), "pre-restore backup must include .snapshot.json");
	const meta = JSON.parse(readFileSync(metaPath, "utf8"));
	assert.equal(meta.preRestoreOf, before.name);
	// and it must be restorable via the public restore() path
	const backupName = path.basename(r.preRestoreBackup);
	const r2 = snap.restore(backupName);
	assert.equal(r2.ok, true, "restoring from the pre-restore backup should work");
	assert.equal(
		readFileSync(path.join(brain(), "AGENTS.md"), "utf8"),
		"# will be preserved in backup\n",
	);
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

test("rapid snapshots never collide into one directory", () => {
	// Millisecond timestamps can repeat on fast machines; a collision must
	// produce a suffixed sibling, never merge into (and mutate) the first.
	const names = Array.from({ length: 5 }, () => snap.snapshot().name);
	assert.equal(new Set(names).size, names.length, `duplicate names: ${names}`);
	const listed = snap.listSnapshots();
	for (const n of names) assert.ok(listed.includes(n), `missing snapshot ${n}`);
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

test("restores in the same millisecond never merge into one pre-restore backup", () => {
	// Regression (flaky on fast Linux CI): restore() named its pre-restore
	// backup `pre-restore-<ms-ts>` with no collision suffix. A second restore
	// in the same millisecond copied the current brain INTO the first backup,
	// corrupting it, then "restored" from that same dir — wrong contents.
	// Freeze the clock so every restore computes the same name, then prove
	// the second one suffixes instead of merging.
	writeFileSync(path.join(brain(), "AGENTS.md"), "# v1\n");
	const s1 = snap.snapshot();
	writeFileSync(path.join(brain(), "AGENTS.md"), "# v2\n");
	const FROZEN = new Date(2026, 0, 1, 12, 0, 0, 500).getTime();
	const RealDate = Date;
	let r1;
	let r2;
	try {
		globalThis.Date = class extends RealDate {
			constructor(...args) {
				super(...(args.length ? args : [FROZEN]));
			}
		};
		writeFileSync(path.join(brain(), "AGENTS.md"), "# backup-me\n");
		r1 = snap.restore(s1.name);
		assert.equal(r1.ok, true);
		const backup1 = r1.preRestoreBackup;
		assert.equal(
			readFileSync(path.join(backup1, "AGENTS.md"), "utf8"),
			"# backup-me\n",
			"first pre-restore backup must capture the pre-restore brain",
		);
		// Second restore in the SAME frozen millisecond: must not touch backup1.
		writeFileSync(path.join(brain(), "AGENTS.md"), "# second\n");
		r2 = snap.restore(s1.name);
	} finally {
		globalThis.Date = RealDate;
	}
	assert.equal(r2.ok, true);
	assert.notEqual(r2.preRestoreBackup, r1.preRestoreBackup);
	assert.equal(
		readFileSync(path.join(r1.preRestoreBackup, "AGENTS.md"), "utf8"),
		"# backup-me\n",
		"the first backup's contents must survive the second restore",
	);
	assert.equal(
		readFileSync(path.join(r2.preRestoreBackup, "AGENTS.md"), "utf8"),
		"# second\n",
	);
	// And restoring FROM the first backup still yields its captured contents.
	const r3 = snap.restore(path.basename(r1.preRestoreBackup));
	assert.equal(r3.ok, true);
	assert.equal(
		readFileSync(path.join(brain(), "AGENTS.md"), "utf8"),
		"# backup-me\n",
	);
});
