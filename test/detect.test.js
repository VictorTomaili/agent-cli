import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "agent-detect-"));
process.env.AGENT_CLI_HOME = TMP;

const detect = await import("../src/detect.js");
const { TARGETS, pathFor } = await import("../src/targets.js");

test("detectInstalled is empty when no markers are present", async () => {
	assert.deepEqual(await detect.detectInstalled(), []);
});

test("detectInstalled returns ids whose home marker exists", async () => {
	const t = TARGETS.find((x) => x.detect && x.global);
	assert.ok(t, "need a target with detect+global");
	mkdirSync(path.join(TMP, t.detect), { recursive: true });
	const installed = await detect.detectInstalled();
	assert.ok(installed.includes(t.id));
});

test("detectForScope only returns installed targets that support the scope", async () => {
	const list = await detect.detectForScope("global");
	assert.ok(Array.isArray(list));
	assert.ok(list.every((t) => pathFor(t, "global")));
});
