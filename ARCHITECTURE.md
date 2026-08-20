# Architecture

This document maps how `agent-cli` (`@victortomaili/agent-cli`) is put together: the layers, the
data it owns on disk, and the conventions every new command should follow. Written to be
read by an agent or a human in one pass.

See [ROADMAP.md](ROADMAP.md) for where this is headed; this file describes what exists now.

## Mental model

Two things live at the system level, outside any single project or coding tool:

1. **The master** — `~/AGENTS.md` — the one file a user edits. Global scope. A project can
   have its own master at `<project>/.agents/AGENTS.md`.
2. **The brain** — `~/.agents/` — everything else: config, identity/soul/user profile,
   lessons, model aliases, sub-agent personas, snapshots, secrets, the skill store.

Every coding tool (Claude Code, Codex, Gemini, Cursor, …) gets a **pointer stub** written
into its own native config location, redirecting it to read the master. Edit once, every
tool sees it. `agent` is the CLI that generates the master, writes/repairs the stubs, and
manages everything under `~/.agents/`.

## Layers

```text
src/cli.js                    entry point: Commander setup, JSON envelope/emit,
                               error handling, registers every command module
      │
      ├── src/commands/*.js   one file per command group — thin: parse options,
      │                       call into lib functions, format output (human or --json)
      │
      ├── src/*.js            lib layer — the actual logic, no Commander/process.exit
      │                       (config.js, store.js, pointer.js, models.js, …)
      │
      ├── src/api/index.js    read-only programmatic SDK over the lib layer —
      │                       used by serve.js (MCP), tests, and any future embedder
      │
      └── src/skills/         self-contained skill-cli, bundled and integrated via
                               src/skill.js as a thin adapter; has its own
                               commands/ + lib/ + cli.js mirroring the same shape
```

**Rule:** `src/cli.js` is the only file that imports every command module. `src/commands/*.js`
may import from `src/*.js` (lib); lib modules must not import from `src/commands/*`.
`src/api/index.js` is a read-only SDK over lib; `src/serve.js` (the MCP bridge) is the one
lib file allowed to consume it. `src/skills/**` is self-contained — nothing in it imports
outside its own tree — and exactly two files bridge into it: `src/skill.js` (the command
adapter: `ensureSkillStore`/`isSkillAvailable`/`runSkill`) and `src/blocks.js` (injects the
skill-cli managed block into the master). Nothing else may import `src/skills/**`.
(Enforced by `test/import-boundaries.test.js`.)

### The dependency-injection pattern

Every command module exports one `registerXCommands(program, deps)` function.
`src/cli.js` imports it, builds the `deps` object (loggers, lib functions, constants) once,
and calls it. This keeps command modules testable without spinning up the real CLI, and
keeps `cli.js` itself small (721 lines — it used to be 4,796 before the split documented in
`PROJECT-ANALYSIS.md` HIGH-3).

```js
// src/commands/link.js
export function registerLinkCommands(program, { emit, fail, log, loadConfig, linkTarget, ... }) {
  program.command("link").action(async (opts) => { /* thin: call linkTarget(), emit() */ });
}

// src/cli.js
import { registerLinkCommands } from "./commands/link.js";
registerLinkCommands(program, { emit, fail, log, loadConfig, linkTarget, ... });
```

Each command file's header comment lists its exact injected-deps contract — read that
first when touching one.

## Command groups → files

| Group | File | Registers |
| --- | --- | --- |
| target/status/link | `commands/target.js`, `commands/link.js` | target enable/disable, link, unlink, status |
| info/inspect/protocol | `commands/info.js`, `commands/inspect.js`, `commands/protocol.js`, `commands/where.js` | config, version, targets, whoami, files, manifest, schema, where |
| edit/pull/onboard | `commands/edit.js` | edit, pull, onboard |
| identity/soul/user | `commands/identity-cmds.js` | identity, soul, user |
| archetype/template | `commands/archetype.js` | archetype, template |
| delegation | `commands/delegation.js` | handoff, agents |
| knowledge | `commands/knowledge.js`, `commands/models.js` | lessons, consolidate; models (split in 2026-08 — the models command moved to its own module to keep both under the ~500-line rule) |
| memory | `commands/memory-ops.js`, `commands/memory-stack.js` | snapshot, restore, backups, memory, session, secret, env |
| tooling | `commands/tooling.js` | spect, search, sync |
| session lifecycle | `commands/session-cmds.js`, `commands/session-core.js`, `commands/bootstrap.js` | run, action, setup, day-start, session-start, doctor, brief, init, brief-hooks |
| reactive | `commands/reactive.js` | serve (MCP), watch, hooks, automation |
| updates | `commands/update-cmds.js` | update, upgrade |
| skills | `commands/skill-cmds.js` | skill (delegates into `src/skills/`) |

## Lib layer (`src/*.js`)

| File | Owns |
| --- | --- |
| `util.js` | path helpers, picocolors logger, atomic fs primitives (`writeFile`/`writeFileSync`: exclusive-create → fsync → rename), path containment (`resolveContained`) |
| `envelope.js` | the one JSON envelope shape (`apiVersion`, `ok`, `command`, `data`) + exit codes |
| `config.js` | `~/.agents/config.json` — locked read-merge-write (cross-process CAS), corruption detection, closed key-set validation |
| `store.js` | the master file itself: seed, read, write, managed-block refresh |
| `blocks.js` | the managed instruction block markers inside the master |
| `pointer.js` | generate/write/classify pointer stubs (`pointer` / `native` / `missing` / `stale`) |
| `targets.js` | registry of the 16 known coding tools: paths, detection markers, hook config, content transforms |
| `detect.js` | best-effort "is this tool installed" check |
| `seed.js` | shipped default content (`seed/`) + staged-update stage/diff/apply/clear |
| `agents-lib.js` | sub-agent personas + the unified identity/memory file inventory (SOUL/IDENTITY/USER/LESSONS/ENVIRONMENTS/MODELS) |
| `identity.js` | apply identity/soul archetypes, set sections, onboarding suggestions |
| `archetypes.js` | the archetype catalogs identity.js applies |
| `fields.js` | XML-tag field schema/parsers for the identity `.md` files |
| `env-capture.js` | autodetect machine environment → fill `ENVIRONMENTS.md` |
| `models.js` | model alias resolution (category → alias → concrete model + thinking level) |
| `lessons-lib.js` | agent-driven lesson primitives — no heuristics, the agent decides what's a lesson |
| `consolidate.js` | occurrence-based lesson consolidation (promote recurring → core, prune singles) |
| `memory.js` | the memory loop: `consolidate.prompt` dispatch, backups |
| `session.js` | session lifecycle state |
| `snapshot.js` | snapshot/restore the whole brain (recursive copy) |
| `handoff.js` | delegation artifacts between sub-agents |
| `search.js` | local retrieval over lessons + master + SPECT docs |
| `spect.js` | project-local spec-driven-dev workflow (`.spect/`) |
| `sync.js` | git-backed brain sync |
| `secrets.js` | AES-256-GCM machine-local secrets, never synced |
| `automation.js` | scheduled/reactive jobs + git hooks |
| `hooks.js` | render/install/status for native SessionStart hooks per target |
| `skill.js` | thin adapter into the bundled `src/skills/` subsystem |
| `skills-gate.js` | core-level structured skill gate (project `skill.config`) |
| `npm-check.js` | cached "is a newer version published" check, with timeout |

## `~/.agents/` on disk

```text
~/.agents/
├── AGENTS.md            self-pointer stub (points back to ~/AGENTS.md, the real master)
├── SOUL.md               \
├── IDENTITY.md            | agent-writable brain files — filled via onboarding,
├── USER.md                | edited by agents during sessions as directed by
├── LESSONS.md             | the mandatory instructions in the master
├── ENVIRONMENTS.md        |
├── MODELS.md             / model alias catalog
├── config.json           enabled targets, model aliases, seedVersion — CLI-owned, locked writes
├── .session.json         current session lifecycle state
├── .consolidate-state.json  lesson consolidation bookkeeping
├── agents/                sub-agent persona files (planner.md, reviewer.md, scout.md, worker.md, …)
├── lessons/                per-topic lesson files (inbox + core)
└── backups/                consolidation backup history
```

`.agents/` under a project root mirrors the global-scope subset for project-scoped state
(project master, project SPECT docs, project skill.config).

## Skills subsystem (`src/skills/`)

A self-contained skill manager (~2,600 lines) with its own `cli.js`, `commands/*.js`, and
`lib/*.js`, bundled into `agent` and reachable via `agent-cli skill ...`. Backed by a global
store at `~/.skill-cli/store`. Integrated through the single adapter `src/skill.js`
(`ensureSkillStore`, `isSkillAvailable`, `runSkill`) — nothing outside `src/skills/` reaches
into its internals directly, and nothing inside it reaches back into the rest of `src/`.
Security-hardened per `PROJECT-ANALYSIS.md` (frontmatter-name traversal, symlink/junction
guards on install and read, bounded reads, pinned npx fetch).

## MCP server (`src/serve.js`)

Zero-dependency JSON-RPC 2.0 stdio server (`agent-cli serve`). Wraps the read-only
`src/api/index.js` SDK as MCP tools (`brief`, `doctor`, `search`, `snapshot`, `status`,
`spect_status`) for any MCP host (Claude Desktop, Cursor, VS Code, …) to call directly
instead of shelling out. See ROADMAP Phase 6 for planned expansion (write-capable tools,
resources, evaluate/delegate).

## Programmatic API (`src/api/index.js`)

The same read-only core the CLI exposes, callable in-process — no `process.exit`, no
network calls. Every function returns the same `data` shape the CLI's `--json` mode emits.
Used by `serve.js`, tests, and anything embedding `agent` as a library rather than shelling
out to it.

## Cross-cutting invariants (do not weaken these)

- **Atomic writes everywhere**: `util.js`'s `writeFile`/`writeFileSync` — exclusive-create,
  fsync before rename, rename-over-existing (works on POSIX and Windows).
- **Config writes are locked**: cross-process file lock + read-merge-write CAS in
  `config.js`, so concurrent `agent` invocations don't clobber each other.
- **Path containment**: any write/delete driven by untrusted input (skill names, staged
  update paths, archetype imports) goes through `resolveContained` and symlink/junction
  checks before touching disk.
- **Pointer-only deletion**: `unlink` only ever deletes files that are verified pointer
  stubs — never arbitrary native content.
- **Secrets never sync**: `secrets.js` output is excluded from snapshots, `sync`, `search`,
  and `brief`.

These invariants came out of the audit in `PROJECT-ANALYSIS.md`; any new write path needs
the same guarantees before it ships (see ROADMAP Phase 5).
