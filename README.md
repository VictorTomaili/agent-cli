# agent-cli

[![npm version](https://img.shields.io/npm/v/@victortomaili/agent-cli.svg)](https://www.npmjs.com/package/@victortomaili/agent-cli)

> Manage `AGENTS.md` and sync it across all your AI coding agents — Claude Code, Codex, Gemini,
> Cursor, Windsurf, Cline, Copilot, DeepSeek Harness, and more. One canonical source in
> `~/.agents/`, mirrored everywhere.

## The idea

Every AI coding tool wants its own instructions file, in its own location, with its own
filename — `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`,
`~/.dsh/AGENTS.md`, `.cursor/rules/agent-cli.mdc`, and so on. Keeping those in sync by hand
drifts fast.

`agent` keeps exactly **one** file you actually edit — the **master** (`~/AGENTS.md` for your
global instructions, or `<project>/.agents/AGENTS.md` for a project) — and writes small
**pointer stub** files into every enabled tool's native config location. Each stub just tells
that tool where the real master file lives, so you never edit the same content twice.

It also bundles a broader toolkit for that master file: identity/soul/user profiles, model
alias resolution, lessons learned, delegation handoffs, brain snapshots, and an integrated
skill manager (`agent-cli skill ...`). Run `agent-cli --help` for the full command surface.

## Install

```bash
npm install -g @victortomaili/agent-cli
```

Requires Node.js >= 22 (ESM). This installs the global `agent-cli` command.

### Update

```bash
npm update -g @victortomaili/agent-cli
# or, to force the latest published version:
npm install -g @victortomaili/agent-cli@latest
```

`agent-cli doctor` (and the session-start brief) already tell you when a newer version is on
npm, so you don't need to check by hand. Every invocation of any `agent-cli` command also surfaces
a one-line update notice on stderr (or as a top-level `updateNotice` field in `--json` envelopes)
when installed < latest, so AI agents driving the CLI can react automatically. That's a
**different** update from `agent-cli update` / `agent-cli upgrade`: those apply
*shipped-default content* changes (seed files, managed instruction blocks) to your existing
`~/.agents/` brain, independent of the package version. Typical flow after a release: bump the
npm package (above), then run `agent-cli upgrade` to pull in any new default content it shipped
with.

If a release ships new structured tags for `IDENTITY.md` / `SOUL.md` / `USER.md` (so the CLI can
detect gaps precisely instead of guessing from prose length), your existing brain files are on
the older schema. The `memory upgrade` command tree walks an LLM agent through the migration,
one file at a time:

```bash
agent-cli memory upgrade status          # what schema are you on; what's pending
agent-cli memory upgrade plan --json     # read the plan + the instructionsForAgent walkthrough
agent-cli memory upgrade prepare <id>    # back up the target file, print the migration spec
                                        # (the LLM does identity/soul/user set per the spec)
agent-cli memory upgrade apply <id>      # mark the migration applied (bumps .schema-version)
```

The plan output includes a plain-English `instructionsForAgent` walkthrough the LLM can paste
into its system prompt. Files are backed up to `~/.agents/.upgrade-backups/<ts>-<id>/` before
each migration so the user can roll back at any point. Opt out of the npm-update notice with
`--no-update-check` or `AGENT_CLI_NO_UPDATE_CHECK=1`.

### From source (contributing)

```bash
git clone https://github.com/VictorTomaili/agent-cli.git
cd agent-cli
npm install
npm link
```

`npm link` creates a global `agent-cli` command backed by this checkout's `src/cli.js`, so local
edits take effect immediately without republishing.

## Quick start

```bash
agent-cli init              # bootstrap ~/AGENTS.md, detect + link installed tools, install SessionStart hooks
agent-cli status             # master state + per-target pointer health
agent-cli validate            # 100ms integrity check (config, targets, brain files) — CI/cron primitive
agent-cli doctor             # full diagnostic (config, pointers, skill-cli, staged updates, npm freshness)
agent-cli edit                # open the master file in $EDITOR
```

`agent-cli init` is idempotent — re-running it repairs anything missing without touching your
edited content. It's also the one command that turns a bare npm install into a working setup:
it seeds the master, writes pointer stubs for every detected tool, deploys the home pointer at
`~/AGENTS.md`, installs SessionStart brief hooks, and sets up the bundled skill manager.

## Core concepts

- **Master** — the one file you write: `~/AGENTS.md` (global) or `.agents/AGENTS.md`
  (project-scoped, inside a repo).
- **Pointer stub** — a small generated file `agent-cli link` writes at a tool's native config path
  (e.g. `~/.claude/CLAUDE.md`). Contains machine-readable metadata plus a human-readable note
  redirecting the agent to read the master file. Safe to regenerate any time; only files
  `agent` itself created are ever touched.
- **Force-rewriting native content backs up first** — `agent-cli link --target <id> --force` on a
  target that already has user-written content copies the existing file to
  `<path>.agent-cli-backup-<iso>` before replacing it. The backup path is surfaced in the
  `--json` envelope's `backup` field so the LLM (and the user) can see exactly where the
  prose went.
- **Target** — an AI coding tool `agent` knows how to point at. `agent-cli targets` lists all known
  targets (id, native config paths, install/enabled state); `agent-cli target enable <id>
  [--global|--project]` turns one on.

## Key commands

| Area | Commands |
|---|---|
| Pointer sync | `link`, `unlink`, `status`, `target enable\|disable`, `where`, `pull` |
| Master content | `edit`, `identity`, `soul`, `user`, `env`, `models`, `archetype` |
| Sub-agent personas | `agents` (list/show/new/edit/roster/delegate), `template install` |
| Lessons & memory | `lessons`, `consolidate`, `memory`, `search` |
| Brain upgrades | `memory upgrade status\|plan\|prepare\|apply` (LLM-driven schema migrations) |
| Brain snapshots | `snapshot`, `restore`, `backups`, `sync` (git-backed) |
| Session lifecycle | `session`, `day-start`, `session-start`, `brief`, `brief-hooks` |
| Shipped-default updates | `update list\|stage\|diff\|apply\|clear`, `upgrade` (add `--overwrite` to take the shipped version of a file you changed — backed up first) |
| dev-team instrumentation | `ledger start\|record\|end\|show\|clear`, `ledger --handoff <taskId>`, `team eval run\|report`, `retro record\|count\|mark` |
| Skills | `skill setup\|refresh\|status\|list\|install\|enable\|disable` |
| Diagnostics | `doctor`, `validate`, `config`, `stats`, `whoami`, `files`, `manifest`, `schema` |
| Automation | `hooks install` (git hooks), `automation add\|list\|run`, `watch`, `serve` (MCP over stdio) |
| Self-documenting | `instructions` (alias `guide`, `for-llm`) — canonical static Markdown guide for AI agents |
| LLM session prompt | `prompt [--for <task>]` — dynamic, state-aware system-prompt recommendation (recommended for session startup) |

Run `agent-cli help <command>` for details on any of these, or `agent-cli --json manifest` for
the full machine-readable command/exit-code contract (plain `manifest` with no `--json` prints
nothing — it's a JSON-only command).

## For LLM agents driving the CLI

There are two complementary commands — one static, one dynamic:

- **`agent-cli prompt [--for "<task>"]`** — the dynamic system-prompt recommendation. Inspects
  your installed tools, brain state, and pending actions, then emits a tailored Markdown block
  (~2 KB) ready for a system-prompt slot. **Run this once per session** and paste it into the
  agent's system prompt. The LLM is then fully oriented — it knows which tools are linked,
  which brain fields are missing, what actions are pending, and which commands to reach for.
- **`agent-cli instructions` (aliases: `guide`, `for-llm`)** — the static long-form reference.
  Same content for every run; useful when an agent needs to re-read the full contract mid-session
  (output contract, common workflows, hard rules, quick-reference table).

After session start, the per-turn loop is `agent-cli --json brief --plan` for the ordered action
list with safe-to-automate flags, and `agent-cli --json brief` for the canonical state snapshot.

For the formal machine-readable contract — JSON envelope shape, exit codes, idempotency
guarantees, error taxonomy, atomic-write + lock semantics — see **[docs/contract.md](docs/contract.md)**.
Treat that document as the spec; the README, `instructions`, `prompt`, and every `--help` text
all defer to it.

The CLI also **suggests the closest match** when you mistype a command — e.g.
`agent-cli statuz` prints `Unknown command: statuz — Did you mean: \`agent-cli status\`,
\`agent-cli stats\`?` so an LLM (or a user) can self-correct without re-reading `--help`.

## MCP (Model Context Protocol)

`agent-cli serve` starts the MCP server over stdio and can be attached to any
MCP host — Claude Desktop, VS Code, Cursor, or any other. It speaks JSON-RPC
2.0, newline-delimited, with no run-time dependencies.

Host config syntax varies, but the per-server shape is the same: a `command`
plus `args`. The canonical example (Claude Desktop's
`claude_desktop_config.json`, or the VS Code `vscode-mcp` server entry) is:

```json
{
  "mcpServers": {
    "agent-cli": {
      "command": "agent-cli",
      "args": ["serve"]
    }
  }
}
```

The VS Code `vscode-mcp` style uses the same `command`/`args` shape under a
`servers` key in `.vscode/mcp.json`; check your host's docs for the exact key.

The server is read-only by default: 6 read tools (`brief`, `doctor`, `search`,
`snapshot`, `status`, `spect_status`), plus resources (`brain://*` — brain
files, skills, targets, lessons, current session) and prompts
(`prompt://session-start`, `prompt://instructions`, `prompt://brief-plan`).
The 10 write tools are **capability-gated** rather than version-gated: a host
sees them only after opting in during `initialize` with
`capabilities.experimental.agentCli.writeTools: true` (the exact boolean —
truthy strings fail closed). A host that does not opt in never sees a write
tool in `tools/list` and gets `write_capability_required` if it calls one.

See **[docs/contract.md](docs/contract.md)** for the full MCP surface — the
`initialize` capabilities, the 11 resource URIs + payload contract, the
subscription delivery contract, and the tool list.

## Project-driven documentation

- The spec-driven workflow (`agent-cli spect ...`) has its own guide at
  [`.spec/README.md`](.spec/README.md).
- The bundled **dev-team** skill turns the main agent of any agentic CLI host into the
  **orchestrator-agent** of a virtual software company: 14 on-demand role personas across
  Product & Design (`product-manager`, `product-owner`, `business-analyst`, `ux-ui-designer`),
  Engineering & Architecture (`software-architect`, `tech-lead`, `frontend-dev`, `backend-dev`,
  `fullstack-dev`, `ai-ml-engineer`), Operations & Quality (`qa-engineer`, `devops-engineer`),
  and Management (`project-manager`, `scrum-master`) — plus the fixed `orchestrator-agent`.
  The protocol is host-agnostic and agentic: backlog item → every relevant role writes its own
  perspective (round 1) → perspectives are shared across a second turn (round 2) → the
  orchestrator synthesizes a master plan → decomposes it into a dependency-aware task DAG
  (blocking/parallel, per-task tool + model/thinking config) → dispatches and validates
  execution → delivers and supports the product. Role personas live in
  [`seed/agents/`](seed/agents/) (each passes `agent-cli agents validate`); the protocol lives
  in [`seed/skills/dev-team/`](seed/skills/dev-team/) (`SKILL.md`/`ROLES.md`/`WORKFLOW.md`);
  both deploy into `~/.agents/` on `agent-cli init`.

## Adding a new AI coding tool

The target registry lives as one file per tool under
[`src/targets/`](src/targets/) — `ls src/targets/` is the canonical list of supported tools.
To add a new one:

```bash
node scripts/add-target.js <id> "<Display Name>" <docs-url> [global] [project] [detect]
```

That scaffolds `src/targets/<id>.js` (with the documented fields and a TODO comment),
updates `src/targets/index.js` to import + list it, and prints the next steps. Run
`npm run check && npm test` and open a PR. Two-file PR (the new file + the index line), with
the scaffold doing the index edit so the order stays correct and there are no merge conflicts
on `index.js`. `src/targets.js` remains a thin re-export shim for backward compatibility —
existing imports keep working.

## Development

```bash
npm test      # node --test test/*.test.js
npm run check # syntax-check every src/*.js file
```
