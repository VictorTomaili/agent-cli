#!/usr/bin/env node
// Derives the GitHub check-run names that .github/workflows actually produces,
// and reconciles them against .github/required-status-checks.json — the
// manifest recording which of those names main's branch protection requires.
//
// Why this exists. main's required status contexts are a hand-typed
// transcription of ci.yml's `os` x `node` matrix expansion. Nothing connected
// the two, and they have already come apart once: a phantom `CI` context sat in
// branch protection matching no job that any workflow produces. A required
// context that never reports is never satisfied, so main became unmergeable by
// everyone until an admin edited the setting by hand. The drift is silent in
// both directions:
//
//   phantom      a required context matching no real job  -> main is bricked
//   silent gap   a real job nothing requires              -> it can fail and
//                                                            the PR still merges
//
// Branch protection lives in GitHub, not in the repo, and a PR check running
// with `contents: read` cannot read it. So reconciliation is split in two:
//
//   in-repo   the derived names must exactly equal the manifest's classified
//             set — enforced on every PR by test/workflow-supply-chain.test.js.
//             Requiring every derived name to be classified as required or
//             explicitly-not-required-with-a-reason is what catches a new
//             matrix leg; requiring every classified name to be accounted for
//             is what catches a phantom.
//
//             "Accounted for" is not the same as "derived". Not every real
//             check run comes from a job in this repository — GitHub's
//             code-scanning gate surfaces as a check run called "CodeQL", and
//             Apps and external CI post their own. Those are declared in the
//             manifest's `external` map, with a reason, and are exempt from
//             the derived-subset test. Without that, requiring any of them
//             would trip the phantom check, and this guard would cause the
//             outage it exists to prevent.
//
//   remote    `node scripts/workflow-checks.js --remote` PRINTS the gh
//             commands to inspect and to apply the manifest. It deliberately
//             does not run them. Branch protection is the one setting where a
//             wrong automated write locks every contributor out at once,
//             including whoever ran the tool, so a human reads the command
//             before it executes.
//
// Usage:
//   node scripts/workflow-checks.js            list derived names + status
//   node scripts/workflow-checks.js --verify   exit 1 if derived != manifest
//   node scripts/workflow-checks.js --remote   print the gh inspect/apply cmds

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
export const MANIFEST_PATH = path.join(
	ROOT,
	".github",
	"required-status-checks.json",
);

// `${{ matrix.foo }}` is the only expression this deriver understands. Any
// other expression in a place that feeds a check name is a shape it cannot
// model, and it throws rather than guessing — a wrong derivation would be
// written into the manifest and from there into branch protection, which is
// the exact outage this file exists to prevent.
const MATRIX_EXPR = /\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;
const ANY_EXPR = /\$\{\{[^}]*\}\}/;

function renderName(template, combination, where) {
	const rendered = String(template).replace(MATRIX_EXPR, (_, key) => {
		if (!(key in combination)) {
			throw new Error(
				`${where}: job name references matrix.${key}, which the matrix does not define`,
			);
		}
		return String(combination[key]);
	});
	if (ANY_EXPR.test(rendered)) {
		throw new Error(
			`${where}: job name uses an expression this deriver does not model: ${template}`,
		);
	}
	return rendered;
}

/** Cross product of [key, values] pairs, preserving matrix declaration order. */
function crossProduct(entries) {
	let combos = [{}];
	for (const [key, values] of entries) {
		const next = [];
		for (const combo of combos) {
			for (const value of values) next.push({ ...combo, [key]: value });
		}
		combos = next;
	}
	return combos;
}

/**
 * Expand a `strategy.matrix` into its combinations, following GitHub's
 * documented include/exclude semantics: an include entry is merged into every
 * combination it does not contradict, and becomes a new combination if it
 * contradicts all of them (which is also what happens when the matrix declares
 * no list keys at all, as codeql.yml's include-only matrix does).
 */
function expandMatrix(matrix, where) {
	if (ANY_EXPR.test(JSON.stringify(matrix))) {
		throw new Error(
			`${where}: matrix contains an expression (e.g. fromJSON); this deriver only models literal values`,
		);
	}

	const listKeys = [];
	let include = [];
	let exclude = [];
	for (const [key, value] of Object.entries(matrix)) {
		if (key === "include") {
			include = value ?? [];
			continue;
		}
		if (key === "exclude") {
			exclude = value ?? [];
			continue;
		}
		if (!Array.isArray(value)) {
			throw new Error(
				`${where}: matrix key "${key}" is not a list; this deriver only models list values`,
			);
		}
		listKeys.push([key, value]);
	}

	const originalKeys = new Set(listKeys.map(([key]) => key));
	let combos = listKeys.length ? crossProduct(listKeys) : [];

	if (exclude.length) {
		combos = combos.filter(
			(combo) =>
				!exclude.some((ex) =>
					Object.entries(ex).every(([key, value]) => combo[key] === value),
				),
		);
	}

	// Include entries are applied to the CROSS-PRODUCT combinations only. A
	// combination that an include created is not itself a merge target for a
	// later include — otherwise an include-only matrix (codeql.yml's, which
	// declares no list keys at all) collapses: with no original keys nothing
	// can contradict, so the second entry would overwrite the first instead of
	// standing beside it, and the job would derive one name instead of two.
	const base = combos;
	const standalone = [];
	for (const entry of include) {
		let merged = false;
		for (const combo of base) {
			const contradicts = Object.entries(entry).some(
				([key, value]) => originalKeys.has(key) && combo[key] !== value,
			);
			if (contradicts) continue;
			Object.assign(combo, entry);
			merged = true;
		}
		if (!merged) standalone.push({ ...entry });
	}

	return [...base, ...standalone];
}

/**
 * Every check-run name the workflows produce, as
 * `{ name, workflow, job }`. A job with a matrix contributes one name per
 * combination; a job with an explicit `name:` uses that template.
 */
export function deriveCheckNames() {
	const files = fs
		.readdirSync(WORKFLOW_DIR)
		.filter((f) => /\.ya?ml$/.test(f))
		.sort();

	const derived = [];
	for (const file of files) {
		const doc = yaml.parse(
			fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8"),
		);
		for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
			const where = `${file} job "${jobId}"`;
			const matrix = job?.strategy?.matrix;

			if (!matrix) {
				const name = job?.name ?? jobId;
				if (ANY_EXPR.test(String(name))) {
					throw new Error(
						`${where}: job name uses an expression but the job has no matrix: ${name}`,
					);
				}
				derived.push({ name: String(name), workflow: file, job: jobId });
				continue;
			}

			for (const combo of expandMatrix(matrix, where)) {
				// Without an explicit `name:`, GitHub labels a matrix job
				// `<job-id> (<value>, <value>)` with the values in matrix
				// declaration order — which is the insertion order of `combo`.
				const name = job?.name
					? renderName(job.name, combo, where)
					: `${jobId} (${Object.values(combo).join(", ")})`;
				derived.push({ name, workflow: file, job: jobId });
			}
		}
	}
	return derived;
}

export function readManifest() {
	return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

/**
 * Compare derived names against the manifest. Returns
 * `{ unclassified, phantom, required, staleExternal }` — `unclassified` is a
 * real job the manifest does not mention (silent gap), `phantom` is a manifest
 * entry nothing produces (the outage).
 *
 * `manifest.external` names check runs that are real but come from somewhere
 * other than a job in .github/workflows — GitHub's code-scanning gate surfaces
 * as a check run called "CodeQL", and Apps and external CI can post their own.
 * Without that escape hatch this function reports any such context as a
 * phantom, so a legitimate configuration would fail the very guard written to
 * keep main mergeable. It stays narrow on purpose: an entry needs a written
 * reason, so a typo is still a phantom rather than something that can be waved
 * through by adding it here.
 *
 * `staleExternal` is the opposite mistake — a name declared external that a
 * workflow job now does produce, which means the declaration is describing
 * something that is no longer true.
 */
export function reconcile(derived = deriveCheckNames(), manifest = readManifest()) {
	const derivedNames = new Set(derived.map((d) => d.name));
	const external = Object.keys(manifest.external ?? {});
	const required = manifest.required ?? [];
	const notRequired = Object.keys(manifest.not_required ?? {});
	const classified = new Set([...required, ...notRequired, ...external]);
	const accountedFor = new Set([...derivedNames, ...external]);

	return {
		required,
		unclassified: [...derivedNames].filter((n) => !classified.has(n)).sort(),
		phantom: [...classified].filter((n) => !accountedFor.has(n)).sort(),
		staleExternal: external.filter((n) => derivedNames.has(n)).sort(),
	};
}

function repoSlug() {
	const url = JSON.parse(
		fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
	)?.repository?.url;
	const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(String(url));
	if (!match) throw new Error(`cannot derive owner/repo from repository.url: ${url}`);
	return match[1];
}

function main(argv) {
	const manifest = readManifest();
	const derived = deriveCheckNames();
	const { unclassified, phantom, staleExternal } = reconcile(derived, manifest);

	if (argv.includes("--remote")) {
		const slug = repoSlug();
		const body = JSON.stringify(
			{
				strict: manifest.strict ?? true,
				checks: (manifest.required ?? []).map((context) => ({ context })),
			},
			null,
			2,
		);
		process.stdout.write(
			[
				"# Inspect what branch protection requires today:",
				`gh api repos/${slug}/branches/${manifest.branch ?? "main"}/protection/required_status_checks --jq '.contexts[]'`,
				"",
				"# Apply this manifest. READ IT FIRST — a wrong write here locks every",
				"# contributor out of the branch, including you.",
				`gh api -X PATCH repos/${slug}/branches/${manifest.branch ?? "main"}/protection/required_status_checks --input - <<'JSON'`,
				body,
				"JSON",
				"",
			].join("\n"),
		);
		return 0;
	}

	const requiredSet = new Set(manifest.required ?? []);
	process.stdout.write("Derived check names:\n");
	for (const { name, workflow } of derived) {
		const mark = requiredSet.has(name)
			? "required"
			: name in (manifest.not_required ?? {})
				? "not required"
				: "UNCLASSIFIED";
		process.stdout.write(`  [${mark}] ${name}  (${workflow})\n`);
	}

	const externalNames = Object.keys(manifest.external ?? {});
	if (externalNames.length) {
		process.stdout.write(`\nDeclared external (not produced by a workflow job):\n`);
		for (const name of externalNames) {
			const mark = requiredSet.has(name) ? "required" : "not required";
			process.stdout.write(`  [${mark}] ${name}\n`);
		}
	}

	for (const name of phantom) {
		process.stdout.write(
			`\nPHANTOM: manifest lists "${name}" but nothing produces it - no workflow job, and it is not declared in 'external'.\n`,
		);
	}
	for (const name of unclassified) {
		process.stdout.write(
			`\nUNCLASSIFIED: "${name}" is a real check the manifest does not mention.\n`,
		);
	}

	for (const name of staleExternal) {
		process.stdout.write(
			`\nSTALE EXTERNAL: "${name}" is declared external but a workflow job now produces it.\n`,
		);
	}

	const clean =
		!phantom.length && !unclassified.length && !staleExternal.length;
	if (argv.includes("--verify")) {
		process.stdout.write(
			clean ? "\nmanifest matches the workflows\n" : "\nmanifest is out of sync\n",
		);
		return clean ? 0 : 1;
	}
	return 0;
}

// Run main() only when invoked directly, never when imported by the test.
// realpathSync resolves the symlink a global install can put in argv[1]; it
// throws if argv[1] is not a real path, and an exception here would take the
// importing test file down with it, so failure means "not the entry point".
function isEntryPoint() {
	try {
		return (
			!!process.argv[1] &&
			fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
		);
	} catch {
		return false;
	}
}

if (isEntryPoint()) {
	process.exitCode = main(process.argv.slice(2));
}
