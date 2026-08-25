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
	mkdtempSync,
	cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath (not new URL(...).pathname) — the latter keeps a leading
// slash on Windows (/D:/...) which path.join turns into D:\D:\... doubling
// the drive. fileURLToPath decodes the URL into a proper platform path.
const SCRIPT = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"scripts",
	"add-target.js",
);
const REAL_ROOT = path.resolve(path.dirname(SCRIPT), "..");

// Scaffold into a COPY of the tree, never the live one.
//
// The scaffold writes a real `import x from "./x.js"` line into
// src/targets/index.js. `node --test` runs test files in parallel processes, so
// while that line exists any other worker importing the registry resolves an
// import whose file may not be written yet — surfacing as an intermittent
// ERR_MODULE_NOT_FOUND, or as "does not provide an export named 'TARGETS'" when
// index.js is read mid-write. Those failures land in unrelated files
// (api.test.js, cli.test.js, detect.test.js), which is what made them look like
// infrastructure flake rather than one test mutating shared state.
//
// AGENT_CLI_SCAFFOLD_ROOT points the script at this copy instead.
const REPO_ROOT = mkdtempSync(path.join(tmpdir(), "agent-scaffold-"));
cpSync(path.join(REAL_ROOT, "src", "targets"), path.join(REPO_ROOT, "src", "targets"), {
	recursive: true,
});
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
			env: { ...process.env, AGENT_CLI_SCAFFOLD_ROOT: REPO_ROOT },
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

// The double-add path used to be untestable: it needs index.js to already carry
// the import, and mutating the live index.js broke concurrent workers. Now that
// the scaffold runs against a temp copy (AGENT_CLI_SCAFFOLD_ROOT), it is just a
// test.
test("scaffold refuses to double-add an id already imported in index.js", () => {
	const id = "scaffoldtwice";
	const argv = [id, "T", "https://x", ".t/T.md", "T.md", ".t"];
	withScaffold(argv, (first) => {
		assert.equal(first.r.status, 0, `first add should succeed: ${first.r.stderr}`);
		assert.ok(readFileSync(INDEX, "utf8").includes(`from "./${id}.js"`));

		// The descriptor-exists check fires before the double-add guard, so the
		// guard is only reachable in the state it actually exists for: a
		// half-applied add, where index.js carries the import but the descriptor
		// file is gone.
		rmSync(path.join(TARGETS_DIR, `${id}.js`));

		// Second add, with the import line still present, must refuse.
		const second = spawnSync("node", [SCRIPT, ...argv], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: { ...process.env, AGENT_CLI_SCAFFOLD_ROOT: REPO_ROOT },
		});
		assert.notEqual(second.status, 0, "double-add must exit non-zero");
		assert.match(second.stderr, /refusing to double-add/);
	});
});

test("scaffold's double-add guard treats the id literally, not as a regex", () => {
	// The guard interpolates the id into a match. It must not be possible for a
	// metacharacter to make an unrelated id look already-present.
	const r = spawnSync("node", [SCRIPT, ".*", "T", "https://x"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		env: { ...process.env, AGENT_CLI_SCAFFOLD_ROOT: REPO_ROOT },
	});
	// It is rejected by the id-format rule, and crucially NOT by a wildcard
	// match against every existing import.
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /must match/);
	assert.doesNotMatch(r.stderr, /refusing to double-add/);
});

test("scaffold prints actionable next-step guidance", () => {
	const id = "scaffoldtest2";
	withScaffold([id, "G", "https://x", ".g/G.md", "G.md", ".g"], (r) => {
		assert.equal(r.r.status, 0);
		assert.match(r.r.stdout, /Next steps:/);
		assert.match(r.r.stdout, new RegExp(`src/targets/${id}\\.js`));
		assert.match(r.r.stdout, /npm run check && npm test/);
	});
});