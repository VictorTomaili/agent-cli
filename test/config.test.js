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

// ---------------------------------------------------------------------------
// Finding 6 — nested schema validation at the load boundary.
// Wrong shapes are classified as corrupt and refuse to be replaced.
// ---------------------------------------------------------------------------
const AGENTS = path.join(TMP, ".agents");
const configFile = () => path.join(AGENTS, "config.json");
const writeCfg = (obj) =>
	writeFileSync(configFile(), JSON.stringify(obj));
const expectCorruptAndPreserved = async (obj) => {
	const raw = JSON.stringify(obj);
	writeFileSync(configFile(), raw);
	const c = await config.loadConfig();
	assert.equal(config.isConfigCorrupt(c), true);
	await assert.rejects(() => config.saveConfig(c), /config\.json is corrupt/);
	assert.equal(readFileSync(configFile(), "utf8"), raw); // original bytes intact
};

test("schema-invalid global (non-array) is corrupt and preserved", async () => {
	await expectCorruptAndPreserved({ global: "claude" });
});

test("schema-invalid global (array with non-string) is corrupt", async () => {
	await expectCorruptAndPreserved({ global: ["claude", 42] });
});

test("schema-invalid project (object) is corrupt", async () => {
	await expectCorruptAndPreserved({ project: { id: "claude" } });
});

test("schema-invalid project (string) is corrupt", async () => {
	await expectCorruptAndPreserved({ project: "claude" });
});

test("schema-invalid seedFiles (string) is corrupt", async () => {
	await expectCorruptAndPreserved({ seedFiles: "IDENTITY.md" });
});

test("schema-invalid models (non-object) is corrupt", async () => {
	await expectCorruptAndPreserved({ models: "nope" });
});

test("schema-invalid models.aliases (array values) is corrupt", async () => {
	await expectCorruptAndPreserved({
		models: { aliases: { fast: ["a", "b"] } },
	});
});

test("schema-invalid models.aliases (non-object) is corrupt", async () => {
	await expectCorruptAndPreserved({ models: { aliases: ["a"] } });
});

test("schema-invalid projectTargets (array value) is corrupt", async () => {
	await expectCorruptAndPreserved({
		projectTargets: { "/proj/a": ["claude", 7] },
	});
});

test("valid nested shapes still load and round-trip", async () => {
	const obj = {
		global: ["claude"],
		project: null,
		seedFiles: ["IDENTITY.md"],
		models: { aliases: { fast: { model: "openai/gpt" } } },
		projectTargets: { "/proj/a": null, "/proj/b": ["cursor"] },
	};
	await writeCfg(obj);
	const c = await config.loadConfig();
	assert.equal(config.isConfigCorrupt(c), false);
	assert.deepEqual(c.global, ["claude"]);
	assert.deepEqual(c.models.aliases.fast, { model: "openai/gpt" });
	assert.equal(c.projectTargets["/proj/a"], null);
	assert.deepEqual(c.projectTargets["/proj/b"], ["cursor"]);
});

// ---------------------------------------------------------------------------
// Finding 9 — per-project-root state (projectTargets).
// ---------------------------------------------------------------------------
test("default projectTargets is empty; missing root means all targets", () => {
	const c = config.defaultConfig();
	assert.deepEqual(c.projectTargets, {});
	assert.equal(config.isProjectEnabled(c, "claude", "/proj/a"), true);
	assert.deepEqual(
		config.effectiveProjectIds(c, "/proj/a"),
		config.effectiveProjectIds(c, "/proj/b"),
	);
});

test("enableProjectTarget on null state stays null (all), never one-item allowlist", () => {
	const c = config.defaultConfig();
	config.enableProjectTarget(c, "/proj/a", "cursor");
	assert.equal(c.projectTargets["/proj/a"], null); // still "all", not ["cursor"]
	const all = config.effectiveProjectIds(c, "/proj/a");
	assert.ok(all.length > 1);
	assert.ok(all.includes("claude")); // other project targets unaffected
	assert.equal(c.projectTargets["/proj/b"], undefined); // project b untouched
});

test("disableProjectTarget materializes per-root allowlist; other roots unaffected", () => {
	const c = config.defaultConfig();
	config.disableProjectTarget(c, "/proj/a", "claude");
	const a = config.effectiveProjectIds(c, "/proj/a");
	assert.ok(Array.isArray(a));
	assert.ok(!a.includes("claude"));
	assert.ok(a.includes("cursor"));
	const b = config.effectiveProjectIds(c, "/proj/b"); // legacy null => all
	assert.ok(b.includes("claude"));
});

test("enableProjectTarget re-adds to a per-root allowlist", () => {
	const c = config.defaultConfig();
	config.disableProjectTarget(c, "/proj/a", "claude");
	config.enableProjectTarget(c, "/proj/a", "claude");
	assert.ok(config.effectiveProjectIds(c, "/proj/a").includes("claude"));
});

test("isProjectEnabled honors per-root allowlist", () => {
	const c = config.defaultConfig();
	config.disableProjectTarget(c, "/proj/a", "claude");
	assert.equal(config.isProjectEnabled(c, "claude", "/proj/a"), false);
	assert.equal(config.isProjectEnabled(c, "claude", "/proj/b"), true);
});

test("per-root entries override the legacy project fallback", () => {
	const c = config.defaultConfig();
	c.project = ["claude"]; // legacy fallback
	config.enableProjectTarget(c, "/proj/a", "cursor");
	const a = config.effectiveProjectIds(c, "/proj/a");
	assert.ok(a.includes("cursor"));
	assert.ok(a.includes("claude")); // legacy still applies where not overridden
	const b = config.effectiveProjectIds(c, "/proj/b");
	assert.deepEqual(b, ["claude"]); // untouched root keeps legacy only
});

test("P0-3: concurrent atomic enables all succeed with no lost update", async () => {
	// Clear the config file so the base is empty.
	writeFileSync(path.join(TMP, ".agents", "config.json"), "{\"version\":2,\"global\":[]}\n");
	const ids = ["claude", "codex", "pi", "gemini", "qwen", "cline"];
	// Fire the atomic wrappers concurrently (each runs lock + read-merge-write).
	await Promise.all(ids.map((id) => Promise.resolve().then(() => config.atomicEnableGlobal(id))));
	const final = config.loadConfigSync();
	const got = [...final.global].sort();
	assert.deepEqual(got, [...ids].sort(), "every concurrent enable must be persisted");
});
