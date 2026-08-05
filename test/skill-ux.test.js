import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolated skill store. MUST be set before importing any module so
// src/skills/lib/paths.js resolves HOME (and every derived path) to the temp dir.
const TMP = mkdtempSync(path.join(tmpdir(), "agent-skill-ux-"));
process.env.AGENT_CLI_HOME = TMP;
process.env.SKILL_CLI_HOME = TMP; // paths.js prefers SKILL_CLI_HOME — isolate from any ambient value

const { AGENTS_BLOCK, injectBlock } = await import(
  "../src/skills/lib/agents-md.js"
);
const { cmdDisable } = await import("../src/skills/commands/disable.js");
const {
  readGlobalConfig,
  writeGlobalConfig,
  readProjectConfig,
  computeEffective,
} = await import("../src/skills/lib/config.js");
const { PROJECT_CONFIG } = await import("../src/skills/lib/paths.js");

// Run cmdDisable defensively: any accidental process.exit() (e.g. missing name)
// throws instead of killing the test runner.
function runDisable(args) {
  const origExit = process.exit;
  process.exit = (code) => {
    throw new Error("cmdDisable called process.exit(" + code + ")");
  };
  try {
    cmdDisable(args);
  } finally {
    process.exit = origExit;
  }
}

test("AGENTS_BLOCK references the packaged `agent skill` command, never a bare `skill`", () => {
  for (const needle of [
    "`agent skill list`",
    "`agent skill show <name>`",
    "`agent skill cat <name>`",
    "`agent skill default <name>`",
    "`agent skill active`",
    "`agent skill trigger <keyword>`",
    "`agent skill trigger X`",
  ]) {
    assert.ok(
      AGENTS_BLOCK.includes(needle),
      "expected " + needle + " in AGENTS_BLOCK"
    );
  }
  // The packaged binary is `agent`; no standalone `skill ...` invocation may
  // survive in the injected instructions.
  assert.doesNotMatch(
    AGENTS_BLOCK,
    /`skill (list|show|cat|default|active|trigger)/
  );
});

test("injectBlock injects the block and is idempotent (empty, native, and re-injected content)", () => {
  // Empty content: block only.
  const once = injectBlock("");
  assert.ok(once.startsWith("<!-- BEGIN skill-cli -->"));
  assert.ok(once.includes("agent skill active"));
  assert.equal(injectBlock(once), once);

  // Native content is preserved and the block appended; re-inject is a no-op.
  const native = "# Notes\n\nsome body\n";
  const withBlock = injectBlock(native);
  assert.ok(withBlock.startsWith("# Notes\n\nsome body"));
  assert.ok(withBlock.includes("<!-- BEGIN skill-cli -->"));
  assert.equal(injectBlock(withBlock), withBlock);

  // A stale/mutated block region is replaced, not duplicated.
  const stale = once.replace("agent skill active", "skill active");
  const fixed = injectBlock(stale);
  assert.ok(fixed.includes("agent skill active"));
  assert.equal(
    (fixed.match(/<!-- BEGIN skill-cli -->/g) || []).length,
    1
  );
});

test("cmdDisable project path adds a global default to project deny so inheritance is overridden", () => {
  const prevCwd = process.cwd();
  const projDir = mkdtempSync(path.join(TMP, "proj-"));
  try {
    process.chdir(projDir);

    // X is a global default → active in this project via inheritance.
    writeGlobalConfig({ defaults: ["X"] });
    assert.ok((readGlobalConfig().defaults || []).some((d) => d.toLowerCase() === "x"));

    runDisable(["X"]);

    const cfg = readProjectConfig(projDir);
    assert.ok(cfg, "project config should have been written");
    assert.ok(
      cfg.deny.some((d) => d.toLowerCase() === "x"),
      "X should be added to project deny"
    );
    assert.ok(
      !(cfg.allow || []).some((a) => a.toLowerCase() === "x"),
      "X should be removed from project allow"
    );

    // The written file itself carries the deny entry.
    const raw = readFileSync(path.join(projDir, PROJECT_CONFIG), "utf8");
    assert.match(raw, /deny:/);

    // The global default is untouched…
    assert.ok((readGlobalConfig().defaults || []).some((d) => d.toLowerCase() === "x"));
    // …but the project no longer inherits it as active.
    const effective = computeEffective([{ name: "X" }], readGlobalConfig(), cfg);
    assert.ok(!effective.includes("X"), "X should no longer be effective in the project");
  } finally {
    process.chdir(prevCwd);
  }
});

test("cmdDisable project path is idempotent (deny not duplicated on re-run)", () => {
  const prevCwd = process.cwd();
  const projDir = mkdtempSync(path.join(TMP, "proj-"));
  try {
    process.chdir(projDir);
    writeGlobalConfig({ defaults: ["X"] });

    runDisable(["X"]);
    runDisable(["X"]);

    const cfg = readProjectConfig(projDir);
    assert.equal(cfg.deny.length, 1, "deny should contain exactly one entry");
    assert.ok(cfg.deny.some((d) => d.toLowerCase() === "x"));
  } finally {
    process.chdir(prevCwd);
  }
});

test("cmdDisable -g still removes a skill from global defaults", () => {
  writeGlobalConfig({ defaults: ["X", "Y"] });

  runDisable(["X", "-g"]);

  const g = readGlobalConfig();
  assert.ok(!(g.defaults || []).some((d) => d.toLowerCase() === "x"), "X removed from global defaults");
  assert.ok((g.defaults || []).some((d) => d.toLowerCase() === "y"), "Y remains a global default");
});
