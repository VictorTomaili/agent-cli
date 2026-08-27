// Project scope trusts the CHECKOUT to say where its brain lives. A checkout can
// commit `.agents` as a symlink (mode 120000), and on Windows a junction needs no
// privilege at all — so without a guard, a hostile repo redirects every
// project-scope write onto the global brain. That matters more than an ordinary
// path escape: SOUL.md and LESSONS.md are loaded into every session on the
// machine, so repo-scoped text would become standing machine-wide instructions.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	symlinkSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-projscope-"));
process.env.AGENT_CLI_HOME = TMP;

const util = await import("../src/util.js");
const agentsLib = await import("../src/agents-lib.js");
const lessonsLib = await import("../src/lessons-lib.js");

const GLOBAL_BRAIN = path.join(TMP, ".agents");
mkdirSync(GLOBAL_BRAIN, { recursive: true });
writeFileSync(path.join(GLOBAL_BRAIN, "SOUL.md"), "GLOBAL SOUL\n");

/** A checkout whose .agents is a junction/symlink pointing at the global brain. */
function hostileCheckout(name) {
	const repo = path.join(TMP, name);
	mkdirSync(repo, { recursive: true });
	symlinkSync(GLOBAL_BRAIN, path.join(repo, ".agents"), "junction");
	return repo;
}

/** A checkout with an ordinary, real .agents directory. */
function honestCheckout(name) {
	const repo = path.join(TMP, name);
	mkdirSync(path.join(repo, ".agents"), { recursive: true });
	return repo;
}

test("projectBrainDir returns the path when .agents does not exist yet", () => {
	const repo = path.join(TMP, "fresh");
	mkdirSync(repo, { recursive: true });
	assert.equal(util.projectBrainDir(repo), path.join(repo, ".agents"));
});

test("projectBrainDir accepts an ordinary .agents directory", () => {
	const repo = honestCheckout("honest");
	assert.equal(util.projectBrainDir(repo), path.join(repo, ".agents"));
});

test("projectBrainDir refuses a .agents that is a link to the global brain", () => {
	const repo = hostileCheckout("hostile");
	assert.throws(
		() => util.projectBrainDir(repo),
		(e) => e.code === "EPROJECTBASEREDIRECTED" && /refusing to use project scope/.test(e.message),
	);
});

test("identityBase refuses project scope through a redirected .agents", () => {
	const repo = hostileCheckout("hostile-identity");
	assert.throws(
		() => agentsLib.identityBase("project", repo),
		(e) => e.code === "EPROJECTBASEREDIRECTED",
	);
	// Global scope is never checkout-controlled, so it must keep working.
	assert.equal(agentsLib.identityBase("global", repo), GLOBAL_BRAIN);
});

test("projectAgentsDir refuses a redirected .agents", () => {
	const repo = hostileCheckout("hostile-agents");
	assert.throws(
		() => agentsLib.projectAgentsDir(repo),
		(e) => e.code === "EPROJECTBASEREDIRECTED",
	);
});

test("lessonsRoot and coreFile refuse a redirected .agents", () => {
	const repo = hostileCheckout("hostile-lessons");
	assert.throws(
		() => lessonsLib.lessonsRoot("project", repo),
		(e) => e.code === "EPROJECTBASEREDIRECTED",
	);
	assert.throws(
		() => lessonsLib.coreFile("project", repo),
		(e) => e.code === "EPROJECTBASEREDIRECTED",
	);
});

// The point of all of the above: the global brain must be unchanged afterwards.
test("the global brain was never written through any redirected project scope", () => {
	assert.equal(readFileSync(path.join(GLOBAL_BRAIN, "SOUL.md"), "utf8"), "GLOBAL SOUL\n");
});
