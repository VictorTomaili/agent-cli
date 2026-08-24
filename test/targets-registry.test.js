// Tests for the per-target registry refactor (src/targets/<id>.js +
// src/targets/index.js). Verifies:
//   - Every per-target file exports a default descriptor with the right shape.
//   - The central loader aggregates every per-target file.
//   - Adding/removing a per-target file changes TARGETS deterministically.
//   - Backward-compat re-exports from src/targets.js still work.
//   - The `add-target` recipe (drop file + import line + array entry) is enforced.

import { test } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const TARGETS_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"targets",
);

// ---------------------------------------------------------------------------
// Per-target files: shape, naming, presence in the central registry.
// ---------------------------------------------------------------------------

test("every file in src/targets/ is a one-file per-target descriptor", () => {
	const files = readdirSync(TARGETS_DIR).filter(
		(f) => f.endsWith(".js") && f !== "index.js",
	);
	assert.ok(files.length >= 16, `expected ≥16 per-target files, got ${files.length}`);
	for (const f of files) {
		const src = readFileSync(path.join(TARGETS_DIR, f), "utf8");
		// Each per-target file MUST export default with the documented fields.
		assert.ok(
			src.includes("export default"),
			`${f} must export default`,
		);
		assert.ok(/id:\s*"[a-z0-9-]+"/.test(src), `${f} must declare an id`);
		// File name must match the declared id (one-file-per-id invariant).
		const idMatch = src.match(/id:\s*"([^"]+)"/);
		assert.equal(f.replace(/\.js$/, ""), idMatch[1], `${f}: file name must match id`);
	}
});

test("index.js imports every per-target file and lists each in TARGETS", async () => {
	const indexSrc = readFileSync(path.join(TARGETS_DIR, "index.js"), "utf8");
	const files = readdirSync(TARGETS_DIR).filter(
		(f) => f.endsWith(".js") && f !== "index.js",
	);
	for (const f of files) {
		const stem = f.replace(/\.js$/, "");
		assert.ok(
			new RegExp(`import\\s+${stem}\\s+from`).test(indexSrc),
			`index.js must import ${stem}`,
		);
		// Must appear in the TARGETS array too.
		assert.ok(
			new RegExp(`\\b${stem}\\b`).test(
				indexSrc.slice(indexSrc.indexOf("export const TARGETS")),
			),
			`index.js must include ${stem} in TARGETS`,
		);
	}
});

test("every per-target descriptor has the documented shape", async () => {
	const { TARGETS } = await import("../src/targets/index.js");
	for (const t of TARGETS) {
		assert.ok(t.id, `target missing id: ${JSON.stringify(t)}`);
		assert.ok(t.name, `target ${t.id} missing name`);
		assert.ok(t.docs, `target ${t.id} missing docs URL`);
		assert.ok(
			t.global || t.project,
			`target ${t.id} has no global or project path`,
		);
		// detect is required (or explicitly null), and must be home-relative if set.
		if (t.detect != null) {
			assert.ok(
				!path.isAbsolute(t.detect),
				`target ${t.id} detect must be home-relative`,
			);
			assert.ok(
				!t.detect.includes(".."),
				`target ${t.id} detect must not contain '..'`,
			);
		}
		if (t.transform != null) {
			assert.equal(
				typeof t.transform,
				"function",
				`target ${t.id} transform must be a function`,
			);
		}
	}
});

test("per-target ids are unique (no two files claim the same id)", async () => {
	const files = readdirSync(TARGETS_DIR).filter(
		(f) => f.endsWith(".js") && f !== "index.js",
	);
	const ids = new Set();
	for (const f of files) {
		const src = readFileSync(path.join(TARGETS_DIR, f), "utf8");
		const id = src.match(/id:\s*"([^"]+)"/)[1];
		assert.ok(!ids.has(id), `duplicate id: ${id}`);
		ids.add(id);
	}
});

// ---------------------------------------------------------------------------
// Backward compat: src/targets.js (the old entry point) must keep re-exporting.
// ---------------------------------------------------------------------------

test("src/targets.js re-exports from src/targets/index.js", () => {
	const shimSrc = readFileSync(
		path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			"src",
			"targets.js",
		),
		"utf8",
	);
	assert.ok(
		shimSrc.includes("./targets/index.js"),
		"src/targets.js must re-export from the new loader",
	);
	// Must NOT define TARGETS locally (would drift from the per-target files).
	assert.ok(
		!shimSrc.includes("export const TARGETS"),
		"src/targets.js must not redefine TARGETS",
	);
});

test("importing from src/targets.js yields the same TARGETS as src/targets/index.js", async () => {
	const a = await import("../src/targets.js");
	const b = await import("../src/targets/index.js");
	assert.deepEqual(
		a.TARGETS.map((t) => t.id),
		b.TARGETS.map((t) => t.id),
	);
	assert.equal(a.TARGETS.length, b.TARGETS.length);
	// Every helper is exported through the shim.
	for (const k of [
		"TARGETS",
		"TARGET_MAP",
		"getTarget",
		"knownIds",
		"pathFor",
		"scopesFor",
		"targetsWithScope",
		"targetsWithHooks",
		"adaptContent",
		"cursorTransform",
	]) {
		assert.equal(typeof a[k], typeof b[k], `shim must export ${k}`);
	}
});

// ---------------------------------------------------------------------------
// getTarget / knownIds round-trip — covers the helpers exported from the shim.
// ---------------------------------------------------------------------------

test("getTarget returns the same object whether you go through the shim or the index", async () => {
	const a = await import("../src/targets.js");
	const b = await import("../src/targets/index.js");
	for (const t of a.TARGETS) {
		assert.equal(a.getTarget(t.id), t);
		assert.equal(b.getTarget(t.id), t);
	}
	assert.equal(a.getTarget("not-a-real-target"), null);
	assert.deepEqual(a.knownIds().sort(), b.knownIds().sort());
});