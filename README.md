# agent-cli

[![npm version](https://img.shields.io/npm/v/@victortomaili/agent-cli.svg)](https://www.npmjs.com/package/@victortomaili/agent-cli)

> Manage `AGENTS.md` and sync it across all your AI coding agents — Claude Code, Codex, Gemini,
> Cursor, Windsurf, Cline, Copilot, and more. One canonical source in `~/.agents/`, mirrored
> everywhere.

## The idea

Every AI coding tool wants its own instructions file, in its own location, with its own
filename — `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`,
`.cursor/rules/agent-cli.mdc`, and so on. Keeping those in sync by hand drifts fast.

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
npm, so you don't need to check by hand. That's a **different** update from `agent-cli update` /
`agent-cli upgrade`: those apply *shipped-default content* changes (seed files, managed
instruction blocks) to your existing `~/.agents/` brain, independent of the package version.
Typical flow after a release: bump the npm package (above), then run `agent-cli upgrade` to
pull in any new default content it shipped with.

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
| Brain snapshots | `snapshot`, `restore`, `backups`, `sync` (git-backed) |
| Session lifecycle | `session`, `day-start`, `session-start`, `brief`, `brief-hooks` |
| Shipped-default updates | `update list\|stage\|diff\|apply\|clear`, `upgrade` |
| Skills | `skill setup\|refresh\|status\|list\|install\|enable\|disable` |
| Diagnostics | `doctor`, `config`, `stats`, `whoami`, `files`, `manifest`, `schema` |
| Automation | `hooks install` (git hooks), `automation add\|list\|run`, `watch`, `serve` (MCP over stdio) |

Run `agent-cli help <command>` for details on any of these, or `agent-cli --json manifest` for
the full machine-readable command/exit-code contract (plain `manifest` with no `--json` prints
nothing — it's a JSON-only command).

## Project-driven documentation

- The spec-driven workflow (`agent-cli spect ...`) has its own guide at
  [`.spect/README.md`](.spect/README.md).
- The bundled sub-agent personas — the **dev-team** roster (`orchestrator-agent`,
  `cto-agent`, `dev-agent` ×3 slots, `devops-agent`, `qa-agent`, `security-agent`) — live in
  [`seed/agents/`](seed/agents/) and are documented inline in each file's frontmatter. The
  skill that turns them into a working delegation flow lives in
  [`seed/skills/dev-team/`](seed/skills/dev-team/) (`SKILL.md`/`ROLES.md`/`WORKFLOW.md`);
  both deploy into `~/.agents/` on `agent-cli init`.

## Development

```bash
npm test      # node --test test/*.test.js
npm run check # syntax-check every src/*.js file
```
