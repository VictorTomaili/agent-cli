// test/operation-lock.test.js — coverage for src/operation-lock.js (T6.0.2).
//
// Per-file convention (matches test/util.test.js + test/config.test.js):
// set AGENT_CLI_HOME to a mkdtempSync dir BEFORE importing the module,
// because the module reads HOME at load time via util.js's HOME export.
//
// Same-process note: withOperationLock does not specially handle same-process
// re-entry — two calls in series run cleanly (the first releases before the
// second acquires); two truly nested calls from the same process would
// deadlock. We exercise the serial case below.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-oplock-"));
process.env.AGENT_CLI_HOME = TMP;
const LOCKS_DIR = path.join(TMP, ".agents", ".locks");

const { withOperationLock } = await import("../src/operation-lock.js");

function freshLocksDir() {
	rmSync(LOCKS_DIR, { recursive: true, force: true });
	mkdirSync(LOCKS_DIR, { recursive: true });
}

beforeEach(freshLocksDir);
afterEach(() => {
	// Paranoid: even if a test crashed mid-acquire, ensure no locks leak
	// between tests so the suite is deterministic.
	try {
		rmSync(LOCKS_DIR, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

// --- happy path ------------------------------------------------------------

test("acquire when no lock exists — fn runs and returns its value", async () => {
	const r = await withOperationLock("snapshot", async () => 42);
	assert.equal(r, 42);
});

test("lock file lives at ~/.agents/.locks/<name>.lock under AGENT_CLI_HOME", async () => {
	await withOperationLock("snapshot", async () => {
		assert.ok(existsSync(path.join(LOCKS_DIR, "snapshot.lock")));
	});
	await withOperationLock("consolidate", async () => {
		assert.ok(existsSync(path.join(LOCKS_DIR, "consolidate.lock")));
	});
});

test("lock file content matches the documented metadata shape", async () => {
	const lockFile = path.join(LOCKS_DIR, "snapshot.lock");
	await withOperationLock("snapshot", async () => {
		const raw = readFileSync(lockFile, "utf8");
		const meta = JSON.parse(raw);
		assert.equal(typeof meta, "object");
		assert.equal(meta.pid, process.pid);
		assert.equal(meta.hostname, hostname());
		assert.equal(meta.operation, "snapshot");
		assert.equal(typeof meta.startedAt, "number");
		assert.equal(typeof meta.timeoutMs, "number");
	});
});

// --- release discipline ----------------------------------------------------

test("release on success: lock file gone after fn() returns", async () => {
	const lockFile = path.join(LOCKS_DIR, "snapshot.lock");
	await withOperationLock("snapshot", async () => {
		assert.ok(existsSync(lockFile), "lock should exist during critical section");
	});
	assert.equal(existsSync(lockFile), false, "lock should be released after success");
});

test("release on fn() throw: lock file gone, error propagates with original identity", async () => {
	const lockFile = path.join(LOCKS_DIR, "snapshot.lock");
	const boom = new Error("boom-from-fn");
	await assert.rejects(
		() => withOperationLock("snapshot", async () => {
			throw boom;
		}),
		(err) => err === boom,
	);
	assert.equal(existsSync(lockFile), false, "lock should be released after throw");
});

// --- same-process serialization --------------------------------------------

test("two serial acquisitions from the same process both run", async () => {
	const order = [];
	await withOperationLock("snapshot", async () => {
		order.push("first");
	});
	await withOperationLock("snapshot", async () => {
		order.push("second");
	});
	assert.deepEqual(order, ["first", "second"]);
});

test("two parallel acquisitions from the same process serialize", async () => {
	const order = [];
	const p1 = withOperationLock("snapshot", async () => {
		order.push("first-start");
		await new Promise((r) => setTimeout(r, 50));
		order.push("first-end");
	});
	const p2 = withOperationLock("snapshot", async () => {
		order.push("second-start");
	});
	await Promise.all([p1, p2]);
	assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

// --- structured refusal (timeout) -----------------------------------------

test("custom timeoutMs is honoured (expect refusal within ~150ms with a fake holder)", async () => {
	// Pre-write snapshot.lock with an alive-but-not-releasing holder (our own
	// pid, fresh lock — not stale by any rule, so we wait until timeoutMs).
	const lockFile = path.join(LOCKS_DIR, "snapshot.lock");
	writeFileSync(
		lockFile,
		JSON.stringify({
			pid: process.pid,
			hostname: hostname(),
			operation: "snapshot",
			startedAt: Date.now(),
			timeoutMs: 60000, // long → won't trigger the timeout*2 stale path
		}),
	);

	const start = Date.now();
	let caught;
	await assert.rejects(
		() => withOperationLock("brain_write", () => "should-not-run", { timeoutMs: 100 }),
		(err) => {
			caught = err;
			return err.code === "OPERATION_BUSY";
		},
	);
	const elapsed = Date.now() - start;

	assert.ok(caught, "rejection must produce an error");
	assert.equal(caught.code, "OPERATION_BUSY");
	assert.equal(caught.lock, "brain_write", "err.lock must be the OPERATION NAME");
	assert.equal(typeof caught.waitedMs, "number");
	assert.ok(caught.waitedMs >= 90, `err.waitedMs should be near 100, got ${caught.waitedMs}`);
	assert.ok(
		elapsed >= 90 && elapsed <= 400,
		`elapsed should be ~100-200ms, got ${elapsed}ms`,
	);
	// err.lockFiles is informational — verify it's the resolved conflict set
	// for brain_write (non-LESSONS → just snapshot.lock), with full paths
	// under ~/.agents/.locks/.
	assert.deepEqual(caught.lockFiles, [path.join(LOCKS_DIR, "snapshot.lock")]);
});

test("default timeoutMs is 5000 (recorded in lock metadata)", async () => {
	const lockFile = path.join(LOCKS_DIR, "snapshot.lock");
	await withOperationLock("snapshot", async () => {
		const meta = JSON.parse(readFileSync(lockFile, "utf8"));
		assert.equal(meta.timeoutMs, 5000);
	});
});

test("custom timeoutMs is recorded in lock metadata", async () => {
	let meta;
	await withOperationLock(
		"snapshot",
		async () => {
			meta = JSON.parse(readFileSync(path.join(LOCKS_DIR, "snapshot.lock"), "utf8"));
		},
		{ timeoutMs: 250 },
	);
	assert.equal(meta.timeoutMs, 250);
});

// --- stale-lock recovery ---------------------------------------------------

test("stale lock (dead pid) — next acquire recovers automatically", async () => {
	// Spawn a short-lived child to guarantee a pid that's dead afterwards.
	// spawnSync blocks until exit, so by the time we read .pid, the pid is gone.
	const { spawnSync } = await import("node:child_process");
	const r = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	const deadPid = r.pid;
	assert.ok(deadPid > 0, "spawned child must report a positive pid");

	const lockFile = path.join(LOCKS_DIR, "snapshot.lock");
	writeFileSync(
		lockFile,
		JSON.stringify({
			pid: deadPid,
			hostname: hostname(),
			operation: "snapshot",
			startedAt: Date.now() - 60_000, // 1 minute ago
			timeoutMs: 5000,
		}),
	);

	let cur;
	await withOperationLock("snapshot", async () => {
		// Recovery succeeded — read the now-fresh metadata while we still
		// hold the lock (it will be unlinked on release).
		cur = JSON.parse(readFileSync(lockFile, "utf8"));
	});
	assert.equal(cur.pid, process.pid);
	assert.equal(cur.operation, "snapshot");
});

// --- conflict matrix -------------------------------------------------------

test("conflict matrix: holding snapshot.lock blocks brain_write acquisition", async () => {
	// Pre-write snapshot.lock with metadata pointing at an alive process on
	// this host, with a fresh startedAt so the timeout*2 stale guard does NOT
	// fire. brain_write's first conflict is snapshot.lock → it must wait, then
	// time out and refuse with OPERATION_BUSY.
	const lockFile = path.join(LOCKS_DIR, "snapshot.lock");
	writeFileSync(
		lockFile,
		JSON.stringify({
			pid: process.pid,
			hostname: hostname(),
			operation: "snapshot",
			startedAt: Date.now(),
			timeoutMs: 60000,
		}),
	);

	await assert.rejects(
		() => withOperationLock("brain_write", () => "should-not-run", { timeoutMs: 100 }),
		(err) => err.code === "OPERATION_BUSY" && err.lock === "brain_write",
	);
});

test("conflict matrix: lesson_capture acquires BOTH consolidate.lock AND snapshot.lock", async () => {
	// lesson_capture's conflict set includes both consolidate AND snapshot, so
	// it must take both lock files. We can prove this by checking both files
	// exist during the critical section.
	await withOperationLock("lesson_capture", async () => {
		assert.ok(existsSync(path.join(LOCKS_DIR, "snapshot.lock")));
		assert.ok(existsSync(path.join(LOCKS_DIR, "consolidate.lock")));
	});
});

test("conflict matrix: brain_write (kind=LESSONS) acquires BOTH lock files", async () => {
	await withOperationLock(
		"brain_write",
		async () => {
			assert.ok(existsSync(path.join(LOCKS_DIR, "snapshot.lock")));
			assert.ok(existsSync(path.join(LOCKS_DIR, "consolidate.lock")));
		},
		{ kind: "LESSONS" },
	);
});

test("conflict matrix: brain_write (non-LESSONS) acquires ONLY snapshot.lock", async () => {
	await withOperationLock("brain_write", async () => {
		assert.ok(existsSync(path.join(LOCKS_DIR, "snapshot.lock")));
		assert.equal(existsSync(path.join(LOCKS_DIR, "consolidate.lock")), false);
	});
});

// --- unknown operation -----------------------------------------------------

test("unknown operation name throws", async () => {
	await assert.rejects(
		() => withOperationLock("not_a_real_op", () => "x"),
		/withOperationLock: unknown operation/,
	);
});