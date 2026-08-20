// SDK tests: src/api/index.js returns the same payload shapes as the CLI,
// in-process, without process.exit or network access.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set AGENT_CLI_HOME BEFORE loading the api module (HOME is captured at import).
process.env.AGENT_CLI_HOME = mkdtempSync(path.join(tmpdir(), "agent-api-"));
const api = await import("../src/api/index.js");

const CLI = path.resolve("src/cli.js");
const HOME = process.env.AGENT_CLI_HOME;

/** Run the CLI against the shared home and parse its --json data payload.
 *  Some commands (doctor, brief --check) emit JSON and exit 2 — that's fine. */
function cliData(args) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		env: { ...process.env },
		cwd: HOME,
	});
	assert.ok(
		r.status === 0 || r.status === 2,
		`CLI ${args.join(" ")} exited ${r.status}: ${r.stderr}`,
	);
	return JSON.parse(r.stdout).data;
}

function initHome() {
	const r = spawnSync(process.execPath, [CLI, "init"], {
		encoding: "utf8",
		env: { ...process.env },
		cwd: HOME,
	});
	assert.equal(r.status, 0, `init failed: ${r.stderr}`);
}

test("api.status matches the CLI status data", async () => {
	initHome();
	const apiOut = await api.status({ cwd: HOME });
	const cliOut = cliData(["status", "--json"]);
	assert.deepEqual(apiOut.targetsSummary, cliOut.targetsSummary);
	assert.deepEqual(apiOut.master, cliOut.master);
	assert.equal(apiOut.targetCount, cliOut.targetCount);
	assert.equal(apiOut.all, cliOut.all);
});

test("api.brief matches the CLI brief data", async () => {
	initHome();
	const apiOut = await api.brief({ cwd: HOME });
	const cliOut = cliData(["brief", "--json"]);
	assert.equal(apiOut.schemaVersion, cliOut.schemaVersion);
	assert.equal(apiOut.health, cliOut.health);
	assert.deepEqual(apiOut.master, cliOut.master);
	assert.deepEqual(apiOut.modelAliases, cliOut.modelAliases);
	assert.deepEqual(apiOut.consolidation, cliOut.consolidation);
	assert.deepEqual(apiOut.project, cliOut.project);
});

test("api.doctor reports the same issues and checks as the CLI", async () => {
	initHome();
	const apiOut = await api.doctor({ cwd: HOME });
	const cliOut = cliData(["doctor", "--json"]);
	assert.deepEqual(apiOut.issues, cliOut.issues);
	assert.equal(apiOut.checks.length, cliOut.checks.length);
});

test("thin wrappers return CLI-shaped payloads", async () => {
	initHome();
	const fl = await api.files("global", HOME);
	assert.ok(Array.isArray(fl.files));
	assert.ok(fl.files.some((f) => f.kind === "identity"));
	const lessons = await api.lessonsList({ includeProject: true, cwd: HOME });
	assert.ok(Array.isArray(lessons));
	const spect = await api.spectStatus(HOME);
	assert.equal(spect.initialized, false);
	assert.ok(Array.isArray(api.snapshotsList()));
	assert.ok(Object.keys(api.modelsList()).length >= 0);
	assert.equal(api.modelsResolve("definitely-missing"), null);
	const sk = api.skillStatus();
	assert.equal(sk.backend, "integrated");
	assert.equal(sk.available, true);
	assert.equal(sk.version, undefined, "no skills version is reported");
});

test("api masterPaths resolves project vs global masters", () => {
	const project = path.join(tmpdir(), "api-proj");
	const g = api.masterPaths("global");
	assert.equal(g.masterAbs, path.join(HOME, ".agents", "AGENTS.md"));
	const p = api.masterPaths("project", project);
	assert.equal(p.masterAbs, path.join(project, ".agents", "AGENTS.md"));
});

test("api never touches the network or mutates config", async () => {
	initHome();
	const cfgPath = path.join(HOME, ".agents", "config.json");
	const before = readFileSync(cfgPath, "utf8");
	const b = await api.brief({ cwd: HOME });
	assert.equal(b.update.refreshed, undefined); // no refresh performed
	assert.equal(readFileSync(cfgPath, "utf8"), before); // config unchanged
});
