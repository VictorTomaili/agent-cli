import { test } from "node:test";
import assert from "node:assert";
import {
	mkdtempSync,
	existsSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-cfg-"));
process.env.AGENT_CLI_HOME = TMP;

const config = await import("../src/config.js");

test("default config has the expected shape", () => {
	const c = config.defaultConfig();
	assert.equal(c.version, 2);
	assert.deepEqual(c.global, []);
	assert.equal(c.project, null);
	assert.equal(c.skillManaged, true);
});

test("enable/disable global is idempotent", () => {
	const c = config.defaultConfig();
	config.enableGlobal(c, "codex");
	config.enableGlobal(c, "codex");
	config.enableGlobal(c, "pi");
	assert.deepEqual(c.global, ["codex", "pi"]);
	config.disableGlobal(c, "codex");
	assert.deepEqual(c.global, ["pi"]);
});

test("project=null means all project targets enabled", () => {
	const c = config.defaultConfig();
	assert.equal(config.isProjectEnabled(c, "cursor"), true);
});

test("project array restricts", () => {
	const c = config.defaultConfig();
	c.project = ["claude"];
	assert.equal(config.isProjectEnabled(c, "claude"), true);
	assert.equal(config.isProjectEnabled(c, "cursor"), false);
});

test("default config includes seedVersion and updateCheck", () => {
	const c = config.defaultConfig();
	assert.equal(c.seedVersion, null);
	assert.equal(c.updateCheck, null);
});

test("loadConfig returns defaults when the file is missing", async () => {
	const c = await config.loadConfig();
	assert.equal(c.version, config.CONFIG_VERSION);
	assert.equal(c.skillManaged, true);
});

test("loadConfig marks corrupt JSON and saveConfig refuses to replace it", async () => {
	mkdirSync(path.join(TMP, ".agents"), { recursive: true });
	const fp = path.join(TMP, ".agents", "config.json");
	writeFileSync(fp, "{ broken json");
	const c = await config.loadConfig();
	assert.equal(c.version, config.CONFIG_VERSION);
	assert.deepEqual(c.global, []);
	assert.equal(config.isConfigCorrupt(c), true);
	await assert.rejects(
		() => config.saveConfig(c),
		/config\.json is corrupt; repair or remove it/,
	);
	assert.equal(readFileSync(fp, "utf8"), "{ broken json");
});

test("loadConfig merges defaults over a partial parsed config", async () => {
	writeFileSync(
		path.join(TMP, ".agents", "config.json"),
		JSON.stringify({ global: ["claude"] }),
	);
	const c = await config.loadConfig();
	assert.deepEqual(c.global, ["claude"]); // parsed value kept
	assert.equal(c.skillManaged, true); // default filled in
	assert.equal(c.version, config.CONFIG_VERSION);
});

test("saveConfig ensures dir, stamps version+updatedAt, and roundtrips", async () => {
	const c = config.defaultConfig();
	c.global = ["codex"];
	await config.saveConfig(c);
	const fp = path.join(TMP, ".agents", "config.json");
	assert.ok(existsSync(fp));
	const loaded = await config.loadConfig(); // safe read+parse
	assert.deepEqual(loaded.global, ["codex"]);
	assert.ok(loaded.updatedAt);
	assert.equal(loaded.version, config.CONFIG_VERSION);
});

test("enableProject/disableProject mutate the project array idempotently", () => {
	const c = config.defaultConfig();
	config.enableProject(c, "cursor");
	config.enableProject(c, "cursor");
	assert.deepEqual(c.project, ["cursor"]);
	config.disableProject(c, "cursor");
	assert.deepEqual(c.project, []);
});

test("disableProject on null project materializes the list then removes", () => {
	const c = config.defaultConfig();
	assert.equal(c.project, null);
	config.disableProject(c, "claude");
	assert.ok(Array.isArray(c.project));
	assert.ok(!c.project.includes("claude"));
});

test("effectiveProjectIds: null → all project-capable targets; array → as-is", () => {
	const all = config.effectiveProjectIds(config.defaultConfig());
	assert.ok(all.length >= 1);
	const c = config.defaultConfig();
	c.project = ["claude", "codex"];
	assert.deepEqual(config.effectiveProjectIds(c), ["claude", "codex"]);
});
