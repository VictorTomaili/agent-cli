import fs from "node:fs";
import path from "node:path";
import c from "picocolors";
import { sanitizeSkillName } from "../lib/store.js";

// Spec-conformant scaffold (agentskills.io): ONLY the six spec frontmatter
// fields. agent-cli extensions live under metadata (the spec's extension
// escape hatch) so the scaffolded skill passes `skills-ref validate` as-is.
const TEMPLATE = (name, description) => `---
name: ${name}
description: ${description || "A description of what this skill does and when to use it."}
license: MIT
metadata:
  agent-cli.version: "1.0.0"
---

# ${name}

Write the instructions here. Keep them concrete and task-focused: what the agent
should do, when to use this skill, and any rules or steps it must follow.
Keep SKILL.md under 500 lines — agents load it fully on activation; move
detail into reference files instead.

## When to use

- ...

## How to use

1. ...

## Extensions

agent-cli activation keywords (optional) — the spec-conformant location is
under metadata in the frontmatter:

    metadata:
      agent-cli.triggers: research, deep-work

## Optional bundled directories (loaded on demand by the agent)

- references/ — deep documentation (REFERENCE.md, domain notes)
- scripts/ — executable helpers (self-contained; document dependencies)
- assets/ — templates, images, lookup data
`;

const TOOL_TEMPLATE = (name) => `// Optional executable tool for this skill.
// Runs via: skill run ${name} [args...]   (or  skill test ${name})
// Exports a single async run(argv) -> { ok, output } function.
export async function run(argv = []) {
  return { ok: true, output: '${name} tool executed with args: ' + argv.join(' ') }
}
`;

// `skill create <name> [-d <dir>]` — scaffold a new skill directory with a
// SKILL.md (and an optional SKILL.tool.js). Creates in the current directory
// (or -d/--dir), NOT in the store, so the author can iterate + `skill install .`
// when ready. Refuses to overwrite an existing SKILL.md.
export function cmdCreate(args) {
  const raw = args.find((a) => !a.startsWith("-"));
  if (!raw) {
    console.error(
      c.red('Usage: skill create <name> [-d <dir>] [--tool] [--desc "…"]'),
    );
    console.error(
      c.gray(
        "  Scaffolds a new skill (SKILL.md + optional SKILL.tool.js) in ./<name> (or -d).",
      ),
    );
    process.exit(1);
  }
  const name = sanitizeSkillName(raw);
  if (!name) {
    console.error(c.red("Invalid skill name: " + raw));
    console.error(
      c.gray(
        '  Use letters/digits/._- only (starting alnum). No path separators or "..".',
      ),
    );
    process.exit(1);
  }
  // Agent Skills spec names: lowercase alnum + hyphens, no leading/trailing or
  // consecutive hyphen, <=64 — the scaffold mints conformant skills only.
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) ||
    name.includes("--") ||
    name.length > 64
  ) {
    console.error(c.red("Invalid skill name: " + raw));
    console.error(
      c.gray(
        "  The Agent Skills spec requires lowercase letters, digits, and single hyphens (max 64), e.g. pdf-processing.",
      ),
    );
    console.error(
      c.gray(
        "  Existing non-conformant skills still load; only new scaffolds must be conformant.",
      ),
    );
    process.exit(1);
  }
  const dirIdx = args.indexOf("-d");
  const dirFlag =
    dirIdx >= 0
      ? args[dirIdx + 1]
      : args.find((_a, i) => args[i - 1] === "--dir");
  const outDir = path.resolve(dirFlag || ".");
  const hasTool = args.includes("--tool");
  const descArg = args.find((_a, i) => args[i - 1] === "--desc");

  const skillPath = path.join(outDir, name);
  const mdPath = path.join(skillPath, "SKILL.md");
  // CodeQL js/file-system-race: existsSync + writeFileSync is a TOCTOU race.
  // Use `flag: "wx"` so the open is exclusive; on EEXIST the write fails
  // atomically with a clear message.
  fs.mkdirSync(skillPath, { recursive: true });
  try {
    fs.writeFileSync(mdPath, TEMPLATE(name, descArg), { flag: "wx" });
  } catch (err) {
    if (err?.code === "EEXIST") {
      console.error(c.red("Already exists: " + mdPath));
      process.exit(1);
    }
    throw err;
  }
  if (hasTool) {
    try {
      fs.writeFileSync(
        path.join(skillPath, "SKILL.tool.js"),
        TOOL_TEMPLATE(name),
        { flag: "wx" },
      );
    } catch (err) {
      if (err?.code === "EEXIST") {
        console.error(
          c.red("Already exists: " + path.join(skillPath, "SKILL.tool.js")),
        );
        process.exit(1);
      }
      throw err;
    }
  }
  fs.mkdirSync(path.join(skillPath, "tests"), { recursive: true });
  console.log(
    c.green("✓") +
      " created skill: " +
      c.bold(name) +
      " at " +
      c.cyan(skillPath),
  );
  console.log(
    c.gray("  Files: ") +
      (hasTool ? "SKILL.md, SKILL.tool.js, tests/" : "SKILL.md, tests/"),
  );
  console.log(
    c.gray("  Edit SKILL.md, then: ") +
      c.cyan("skill validate " + name) +
      c.gray(" → ") +
      c.cyan("skill install " + skillPath),
  );
}
