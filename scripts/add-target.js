#!/usr/bin/env node
// scripts/add-target.js — scaffold a new target descriptor.
//
// Usage:  node scripts/add-target.js <id> "<Display Name>" <docs-url> [global] [project] [detect]
//
// Creates src/targets/<id>.js with a placeholder descriptor, and updates
// src/targets/index.js to import + list it. Validates the id against the
// existing registry so you can't accidentally clobber a target.
//
// This is the "1 file PR to add a target" the registry refactor enables —
// you still touch two files (the new file + the index line) but the scaffold
// does the second edit for you and shows you the diff.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The repo this scaffolds into. Defaults to the checkout this script lives in,
// which is what a contributor wants. `AGENT_CLI_SCAFFOLD_ROOT` redirects it at a
// copy of the tree, which is what the TESTS want: scaffolding writes a real
// import line into src/targets/index.js, and node --test runs files in parallel
// processes, so mutating the live tree makes an unrelated worker import a
// module that does not exist yet. That race is the cause of intermittent
// "does not provide an export named 'TARGETS'" and ERR_MODULE_NOT_FOUND
// failures across the suite.
const ROOT = process.env.AGENT_CLI_SCAFFOLD_ROOT
	? resolve(process.env.AGENT_CLI_SCAFFOLD_ROOT)
	: resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS_DIR = resolve(ROOT, "src/targets");
const INDEX = resolve(TARGETS_DIR, "index.js");

const args = process.argv.slice(2);
if (args.length < 3) {
	process.stderr.write(
		[
			"Usage: node scripts/add-target.js <id> \"<Display Name>\" <docs-url> [global] [project] [detect]",
			"",
			"Example:",
			"  node scripts/add-target.js foo \"Foo Code\" https://example.com/docs .foo/FOO.md FOO.md .foo",
			"",
			"Drops src/targets/<id>.js and updates src/targets/index.js.",
		].join("\n") + "\n",
	);
	process.exit(2);
}

const [id, name, docs, global, project, detect] = args;

if (!/^[a-z][a-z0-9-]*$/.test(id)) {
	process.stderr.write(`error: id "${id}" must match /^[a-z][a-z0-9-]*$/\n`);
	process.exit(2);
}
if (!/^https?:\/\//.test(docs)) {
	process.stderr.write(`error: docs must be an http(s) URL\n`);
	process.exit(2);
}

const out = resolve(TARGETS_DIR, `${id}.js`);
if (existsSync(out)) {
	process.stderr.write(`error: ${out} already exists — refusing to clobber\n`);
	process.exit(1);
}

const targetFile = `// src/targets/${id}.js — one-file target descriptor for "${id}".
//
// ${name}: ${docs}
//
// Recipe for tweaking this descriptor: see src/targets/index.js for the
// shape documentation, and ARCHITECTURE.md for the cross-cutting invariants
// (path containment, atomic writes, etc.) every write path must honor.

// TODO: fill in the fields below. Default to project-only if you're unsure
// about global support — agent-cli refuses to write to paths it doesn't
// recognize.
export default {
	id: "${id}",
	name: ${JSON.stringify(name)},
	docs: ${JSON.stringify(docs)},
	global: ${global ? JSON.stringify(global) : "null"},
	project: ${JSON.stringify(project)},
	detect: ${detect ? JSON.stringify(detect) : "null"},
	// hooks: { event: "SessionStart", configFile: ".${id}/hooks.json" },
	// share: { agents: ".${id}/agents", skills: ".${id}/skills" },
	// note: "...",
};
`;

// Update index.js FIRST so we can refuse to double-add BEFORE creating the
// descriptor file (otherwise a failed double-add leaves a stale descriptor
// behind that pollutes the next run).
const indexSrc = readFileSync(INDEX, "utf8");
// `id` comes from argv and is interpolated into a pattern, so it is matched
// literally rather than as a regex (the `.` in `./` needs escaping too).
const importLine = `from "./${id}.js"`;
if (indexSrc.includes(importLine)) {
	process.stderr.write(
		`error: ${id} already imported in index.js — refusing to double-add\n`,
	);
	process.exit(1);
}

writeFileSync(out, targetFile);
process.stdout.write(`created ${out}\n`);
const updated = indexSrc
	.replace(
		/(import deepseek from "\.\/deepseek\.js";)/,
		`$1\nimport ${id} from "./${id}.js";`,
	)
	// Insert before the closing `];` of the TARGETS array. Strip a trailing
	// comma on the previous entry if present so we don't introduce `,,`.
	.replace(
		/,\s*(\n\];)/,
		`,\n\t${id},$1`,
	);

if (updated === indexSrc) {
	process.stderr.write(
		"error: failed to patch index.js (anchor strings not found)\n",
	);
	process.exit(1);
}
writeFileSync(INDEX, updated);
process.stdout.write(`updated ${INDEX}\n`);
process.stdout.write("\nNext steps:\n");
process.stdout.write(`  1. Open src/targets/${id}.js and fill in the TODO fields.\n`);
process.stdout.write(`  2. Run: npm run check && npm test\n`);
process.stdout.write(`  3. Update src/instructions.js to add ${id} to the elevator pitch if relevant.\n`);