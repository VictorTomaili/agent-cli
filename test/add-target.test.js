// Tests for scripts/add-target.js — the scaffold that automates adding a new
// target. Each test snapshots index.js + the targets/ directory, runs the
// scaffold, captures the result, then restores state.

import { test } from "node:test";
import assert from "node:assert";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const SCRIPT = path.join(
	path.dirname(new URL(import.meta.url).pathname),
	"..",
	"scripts",
	"add-target.js",
);
const REPO_ROOT = path.dirname(SCRIPT) + "/..";
const INDEX = path.join(REPO_ROOT, "src", "targets", "index.js");
const TARGETS_DIR = path.join(REPO_ROOT, "src", "targets");

/** Snapshot state, run scaffold, call `fn(r, newFiles)`, then restore. */
function withScaffold(args, fn) {
	const indexBackup = readFileSync(INDEX, "utf8");
	const descBefore = new Set(
		readdirSync(TARGETS_DIR).filter((f) => f.endsWith(".js") && f !== "index.js"),
	);
	// Best-effort: track the requested id's descriptor for explicit cleanup
	// even if `fn` throws before `result` is set.
	const requestedFile = path.join(TARGETS_DIR, `${args[0]}.js`);
	const requestedExistedBefore = existsSync(requestedFile);
	let result;
	try {
		const r = spawnSync("node", [SCRIPT, ...args], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		const descAfter = new Set(
			readdirSync(TARGETS_DIR).filter((f) => f.endsWith(".js") && f !== "index.js"),
		);
		const newFiles = [...descAfter].filter((f) => !descBefore.has(f));
		result = { r, newFiles };
		fn(result);
	} finally {
		writeFileSync(INDEX, indexBackup);
		// Belt-and-suspenders cleanup: remove the requested descriptor if it
		// didn't exist before but does now, even if result is unset (test
		// threw before the scaffold run completed).
		if (!requestedExistedBefore && existsSync(requestedFile)) {
			try { rmSync(requestedFile); } catch { /* ignore */ }
		}
		if (result) {
			for (const fp of result.newFiles) {
				try { rmSync(fp); } catch { /* ignore */ }
			}
		}
	}
}

test("scaffold creates the per-target file and updates the index", () => {
	const id = "scaffoldtest1";
	withScaffold([id, "Scaffold Test", "https://example.com/docs", ".st/ST.md", "ST.md", ".st"], (r) => {
		assert.equal(r.r.status, 0, `scaffold failed:\n${r.r.stderr}`);
		const file = path.join(TARGETS_DIR, `${id}.js`);
		assert.ok(existsSync(file), `descriptor file must exist at ${file}`);
		assert.ok(r.newFiles.includes(`${id}.js`), "descriptor in newFiles");
		const idx = readFileSync(INDEX, "utf8");
		assert.ok(idx.includes(`import ${id} from`), "index must import the new id");
		assert.ok(
			idx.match(new RegExp(`\\s${id},\\s*\\n\\];`)),
			"index must list the new id in TARGETS",
		);
	});
});

test("scaffold refuses to clobber an existing per-target file", () => {
	withScaffold(["claude", "X", "https://x"], (r) => {
		assert.notEqual(r.r.status, 0);
		assert.match(r.r.stderr, /already exists/);
	});
});

test("scaffold validates the id format", () => {
	withScaffold(["BadID", "X", "https://x"], (r) => {
		assert.notEqual(r.r.status, 0);
		assert.match(r.r.stderr, /must match/);
	});
});

test("scaffold validates the docs URL", () => {
	withScaffold(["ok-id", "X", "ftp://x"], (r) => {
		assert.notEqual(r.r.status, 0);
		assert.match(r.r.stderr, /http\(s\) URL/);
	});
});

// Note: testing the "double-add" path (the script refuses when the import
// already exists in index.js) requires mutating index.js — and that mutation
// is visible to other test workers running concurrently, which then fail
// when they import index.js (the phantom import references a non-existent
// file). The script's behavior is simple enough to verify by code review
// — see scripts/add-target.js around the `from "./<id>\\.js"` check.

test("scaffold prints actionable next-step guidance", () => {
	const id = "scaffoldtest2";
	withScaffold([id, "G", "https://x", ".g/G.md", "G.md", ".g"], (r) => {
		assert.equal(r.r.status, 0);
		assert.match(r.r.stdout, /Next steps:/);
		assert.match(r.r.stdout, new RegExp(`src/targets/${id}\\.js`));
		assert.match(r.r.stdout, /npm run check && npm test/);
	});
});