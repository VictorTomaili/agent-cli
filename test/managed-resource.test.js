// Tests for src/managed-resource.js — the shared state-machine core for
// pointer stubs, share links, and hook entries.
//
// These tests cover the pure decision logic (classify / planLink / planUnlink)
// and the backup-path helper. The consumer call sites (share.js, pointer.js,
// hooks.js) get their own integration tests.

import { test } from "node:test";
import assert from "node:assert";
import {
	STATES,
	classify,
	planLink,
	planUnlink,
	backupPath,
	linkResult,
	unlinkResult,
	NativeContentReason,
} from "../src/managed-resource.js";

// ---------------------------------------------------------------------------
// STATES — frozen enum, exactly the four documented values.
// ---------------------------------------------------------------------------

test("STATES is frozen and contains exactly the documented names", () => {
	assert.equal(typeof STATES, "object");
	assert.equal(Object.isFrozen(STATES), true);
	assert.deepEqual(
		Object.values(STATES).sort(),
		["missing", "native", "ours", "stale"],
	);
});

// ---------------------------------------------------------------------------
// classify — given state predicates, returns the canonical state name.
// ---------------------------------------------------------------------------

const alwaysOurs = () => true;
const neverOurs = () => false;
const staleIf = (marker) => (content) => content.endsWith(marker);

test("classify returns 'missing' when content is null", () => {
	const r = classify({ path: "/x", content: null, isOurs: alwaysOurs });
	assert.equal(r.state, STATES.MISSING);
	assert.equal(r.path, "/x");
	assert.equal(r.content, null);
});

test("classify returns 'native' when isSymlink is true", () => {
	// A symlink is always native — user-owned, even if its target is our source.
	const r = classify({
		path: "/x",
		content: "anything",
		isSymlink: true,
		isOurs: alwaysOurs,
	});
	assert.equal(r.state, STATES.NATIVE);
	assert.equal(r.isSymlink, true);
});

test("classify returns 'native' when isOurs(content) is false", () => {
	const r = classify({
		path: "/x",
		content: "user-written stuff",
		isSymlink: false,
		isOurs: neverOurs,
	});
	assert.equal(r.state, STATES.NATIVE);
});

test("classify returns 'ours' when isOurs is true and no staleness", () => {
	const r = classify({
		path: "/x",
		content: "agent-cli wrote this",
		isOurs: alwaysOurs,
	});
	assert.equal(r.state, STATES.OURS);
});

test("classify returns 'stale' when isOurs + isStale both true", () => {
	const r = classify({
		path: "/x",
		content: "agent-cli wrote this [old-format]",
		isOurs: alwaysOurs,
		isStale: staleIf("[old-format]"),
	});
	assert.equal(r.state, STATES.STALE);
});

test("classify returns 'ours' when isOurs true but not stale", () => {
	const r = classify({
		path: "/x",
		content: "agent-cli wrote this",
		isOurs: alwaysOurs,
		isStale: staleIf("[new-format]"),
	});
	assert.equal(r.state, STATES.OURS);
});

// ---------------------------------------------------------------------------
// planLink — state machine for the `link()` operation.
// ---------------------------------------------------------------------------

test("planLink: missing → write (always)", () => {
	assert.equal(planLink(STATES.MISSING, false), "write");
	assert.equal(planLink(STATES.MISSING, true), "write");
});

test("planLink: ours → noop (idempotent)", () => {
	assert.equal(planLink(STATES.OURS, false), "noop");
	assert.equal(planLink(STATES.OURS, true), "noop");
});

test("planLink: stale → write (force=true doesn't change anything for stale)", () => {
	assert.equal(planLink(STATES.STALE, false), "write");
	assert.equal(planLink(STATES.STALE, true), "write");
});

test("planLink: native + !force → block", () => {
	assert.equal(planLink(STATES.NATIVE, false), "block");
});

test("planLink: native + force → write (caller must back up first)", () => {
	assert.equal(planLink(STATES.NATIVE, true), "write");
});

test("planLink: unknown state → block (defensive default)", () => {
	assert.equal(planLink("???", true), "block");
	assert.equal(planLink("???", false), "block");
});

// ---------------------------------------------------------------------------
// planUnlink — never force-deletes native content. This is the cardinal
// invariant; lock it down.
// ---------------------------------------------------------------------------

test("planUnlink: missing → noop", () => {
	assert.equal(planUnlink(STATES.MISSING), "noop");
});

test("planUnlink: ours → remove", () => {
	assert.equal(planUnlink(STATES.OURS), "remove");
});

test("planUnlink: stale → remove (still ours, just drifted)", () => {
	assert.equal(planUnlink(STATES.STALE), "remove");
});

test("planUnlink: native → block (NEVER force-deletes user content)", () => {
	assert.equal(planUnlink(STATES.NATIVE), "block");
});

test("planUnlink: unknown state → block (defensive default)", () => {
	assert.equal(planUnlink("???"), "block");
});

// ---------------------------------------------------------------------------
// backupPath — ISO-derived, cross-platform safe (no `:` or `.`).
// ---------------------------------------------------------------------------

test("backupPath strips `:` and `.` from the timestamp", () => {
	const fixed = new Date("2026-08-24T12:34:56.789Z");
	const p = backupPath("/dst", fixed);
	assert.ok(p.startsWith("/dst.agent-cli-backup-"));
	assert.ok(!p.includes(":"), `no colons: ${p}`);
	assert.ok(!/\.\d{3}Z$/.test(p), `no trailing millis: ${p}`);
	// The timestamp must be the same string for the same input.
	assert.equal(p, backupPath("/dst", fixed));
});

test("backupPath defaults to now()", () => {
	const p1 = backupPath("/dst");
	const p2 = backupPath("/dst", new Date(Date.now() + 50));
	assert.notEqual(p1, p2);
});

// ---------------------------------------------------------------------------
// linkResult / unlinkResult — shape consistency.
// ---------------------------------------------------------------------------

test("linkResult writes the canonical shape per plan action", () => {
	assert.deepEqual(linkResult({ path: "/x", action: "write" }), {
		path: "/x",
		linked: true,
	});
	assert.deepEqual(
		linkResult({ path: "/x", action: "write", force: true, backup: "/x.bak" }),
		{ path: "/x", linked: true, backup: "/x.bak" },
	);
	assert.deepEqual(linkResult({ path: "/x", action: "noop" }), {
		path: "/x",
		linked: true,
		unchanged: true,
	});
	assert.deepEqual(
		linkResult({ path: "/x", action: "block", hint: "merge-or-force" }),
		{
			path: "/x",
			blocked: NativeContentReason,
			hint: "merge-or-force",
		},
	);
});

test("unlinkResult writes the canonical shape per plan action", () => {
	assert.deepEqual(unlinkResult({ path: "/x", action: "noop" }), {
		path: "/x",
		missing: true,
	});
	assert.deepEqual(unlinkResult({ path: "/x", action: "remove" }), {
		path: "/x",
		unlinked: true,
	});
	assert.deepEqual(unlinkResult({ path: "/x", action: "block" }), {
		path: "/x",
		skipped: NativeContentReason,
	});
});

// ---------------------------------------------------------------------------
// State-machine contract: the full round-trip from classify → planLink → planUnlink.
// ---------------------------------------------------------------------------

test("classify → planLink → planUnlink round-trip on a pointer stub", () => {
	// Simulate: agent-cli writes a pointer stub; later classify() says ours.
	// Then user asks to unlink: planUnlink says remove. No surprises.
	const r = classify({
		path: "/x",
		content: "<!-- agent-cli-pointer -->\n...",
		isOurs: () => true,
	});
	assert.equal(r.state, STATES.OURS);
	assert.equal(planLink(r.state, false), "noop");
	assert.equal(planUnlink(r.state), "remove");
});

test("classify → planLink → planUnlink round-trip on user native content", () => {
	// User wrote their own CLAUDE.md; agent-cli refuses to clobber or delete.
	const r = classify({
		path: "/x",
		content: "# my own notes",
		isOurs: () => false,
	});
	assert.equal(r.state, STATES.NATIVE);
	assert.equal(planLink(r.state, false), "block");
	assert.equal(planUnlink(r.state), "block");
	// Force permits link to back-up-and-rewrite, but unlink still refuses.
	assert.equal(planLink(r.state, true), "write");
	assert.equal(planUnlink(r.state), "block");
});