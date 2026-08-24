// Enforces the layering documented in ARCHITECTURE.md:
//   - src/cli.js       is the entry point: it alone may import every command module.
//   - src/commands/**  may import from src/*.js (lib) and node builtins/deps.
//   - src/*.js (lib)   must never import from src/commands/**, except cli.js itself.
//   - src/api/index.js is a read-only SDK over lib; src/serve.js (the MCP bridge) is
//                       the one lib file allowed to consume it.
//   - src/skills/**    is self-contained: no imports reaching outside src/skills/**.
//                       Two sanctioned bridges reach IN: src/skill.js (the command
//                       adapter) and src/blocks.js (injects the skill-cli managed
//                       block into the master). Nothing else may import src/skills/**.
// A violation here is an architecture regression, not a style nit — it re-tangles
// layers the HIGH-3 cli.js extraction (see .spec/PROJECT-ANALYSIS.md) deliberately split apart.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) out.push(...walk(full));
		else if (entry.endsWith(".js")) out.push(full);
	}
	return out;
}

// Matches both `import ... from "spec"` and `await import("spec")`.
const IMPORT_SPEC = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;

function importsIn(file) {
	const content = readFileSync(file, "utf8");
	return Array.from(content.matchAll(IMPORT_SPEC), (m) => m[1]);
}

/** Resolve a relative import spec against its file's dir into a repo-relative POSIX path. */
function resolveSpec(fromFile, spec) {
	if (!spec.startsWith(".")) return null; // bare specifier (node builtin or npm dep)
	const abs = path.resolve(path.dirname(fromFile), spec);
	return path.relative(SRC, abs).split(path.sep).join("/");
}

const allFiles = walk(SRC);
const commandFiles = allFiles.filter((f) =>
	path.relative(SRC, f).split(path.sep).join("/").startsWith("commands/"),
);
const skillsFiles = allFiles.filter((f) =>
	path.relative(SRC, f).split(path.sep).join("/").startsWith("skills/"),
);
const ENTRY_POINT = "cli.js";
const SKILLS_BRIDGES = new Set(["skill.js", "blocks.js"]);
const API_CONSUMERS = new Set(["serve.js"]);

const libFiles = allFiles.filter(
	(f) =>
		!commandFiles.includes(f) &&
		!skillsFiles.includes(f) &&
		!f.endsWith(`${path.sep}api${path.sep}index.js`) &&
		path.relative(SRC, f) !== ENTRY_POINT,
);

test("only cli.js (the entry point) imports from src/commands/**", () => {
	const offenders = [];
	for (const file of libFiles) {
		for (const spec of importsIn(file)) {
			const resolved = resolveSpec(file, spec);
			if (resolved && resolved.startsWith("commands/")) {
				offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
			}
		}
	}
	assert.deepEqual(offenders, [], "lib -> commands imports found (breaks layering)");
});

test("only src/serve.js imports src/api/** (lib generally must not)", () => {
	const offenders = [];
	for (const file of libFiles) {
		const rel = path.relative(SRC, file).split(path.sep).join("/");
		if (API_CONSUMERS.has(rel)) continue;
		for (const spec of importsIn(file)) {
			const resolved = resolveSpec(file, spec);
			if (resolved && resolved.startsWith("api/")) {
				offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
			}
		}
	}
	assert.deepEqual(offenders, [], "api is a consumer of lib, not the reverse (serve.js is the sanctioned exception)");
});

test("only src/skill.js and src/blocks.js import from src/skills/**", () => {
	const offenders = [];
	for (const file of [...libFiles, ...commandFiles]) {
		const rel = path.relative(SRC, file).split(path.sep).join("/");
		if (SKILLS_BRIDGES.has(rel)) continue;
		for (const spec of importsIn(file)) {
			const resolved = resolveSpec(file, spec);
			if (resolved && resolved.startsWith("skills/")) {
				offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
			}
		}
	}
	assert.deepEqual(offenders, [], "only skill.js/blocks.js may reach into src/skills/** (self-contained subsystem)");
});

test("src/skills/** never imports outside src/skills/**", () => {
	const offenders = [];
	for (const file of skillsFiles) {
		for (const spec of importsIn(file)) {
			const resolved = resolveSpec(file, spec);
			if (resolved && !resolved.startsWith("skills/")) {
				offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
			}
		}
	}
	assert.deepEqual(offenders, [], "src/skills/** must stay self-contained (no reach into the rest of src/)");
});

test("sanity: the walk actually found the expected file groups", () => {
	assert.ok(libFiles.length > 20, "expected the lib layer to have >20 files");
	assert.ok(commandFiles.length > 10, "expected src/commands/** to have >10 files");
	assert.ok(skillsFiles.length > 10, "expected src/skills/** to have >10 files");
});

// --- T6.0.3: src/serve/registry.js purity guard --------------------------------
// MUTATION-CHECK INVARIANT (qa-agent role card): deleting src/serve/registry.js
// MUST surface a clear failure here, never a silent pass. Both guards below
// assert.fail on missing-file so the guard fires whether the file vanishes or
// drifts out of spec. Per meeting D5: this asserts an EMPTY import set, not a
// forbidden-list — a future `import { X } from "./util.js"` would not match a
// forbidden-list but still breaks the contract, so we test the contract.
const REGISTRY_FILE = path.join(SRC, "serve", "registry.js");

test("T6.0.3 src/serve/registry.js has zero imports", () => {
	if (!existsSync(REGISTRY_FILE)) {
		assert.fail("src/serve/registry.js is missing — T6.0.1 not yet landed");
	}
	const imports = importsIn(REGISTRY_FILE);
	assert.deepEqual(
		imports,
		[],
		`registry.js must have zero imports (found: ${JSON.stringify(imports)})`,
	);
});

test("T6.0.3 src/serve/registry.js does not import from src/commands/** or src/skills/**", () => {
	if (!existsSync(REGISTRY_FILE)) {
		assert.fail("src/serve/registry.js is missing — T6.0.1 not yet landed");
	}
	const offenders = [];
	for (const spec of importsIn(REGISTRY_FILE)) {
		const resolved = resolveSpec(REGISTRY_FILE, spec);
		if (!resolved) continue; // bare specifier (node builtin or npm dep) — not a layering concern
		if (resolved.startsWith("commands/") || resolved.startsWith("skills/")) {
			offenders.push(`${spec} -> ${resolved}`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		"registry.js must not import from src/commands/** or src/skills/**",
	);
});
