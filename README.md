<div align="center">

# agent-cli

**One `AGENTS.md`. Every AI coding tool. Always in sync.**

[![npm version](https://img.shields.io/npm/v/@victortomaili/agent-cli.svg)](https://www.npmjs.com/package/@victortomaili/agent-cli)
[![CI](https://github.com/VictorTomaili/agent-cli/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/VictorTomaili/agent-cli/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@victortomaili/agent-cli)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@victortomaili/agent-cli)](LICENSE)

[Quick start](#quick-start) · [Let your agent install it](#let-your-agent-install-it) · [Supported tools](#supported-tools) · [MCP server](#mcp-model-context-protocol) · [dev-team](#the-dev-team-skill) · [Contributing](CONTRIBUTING.md)

</div>

---

## The problem

Every AI coding tool wants its own instructions file, in its own place, under its own name:

```
~/.claude/CLAUDE.md          ~/.codex/AGENTS.md         ~/.gemini/GEMINI.md
~/.dsh/AGENTS.md             ~/.qwen/QWEN.md            ~/.pi/agent/AGENTS.md
.cursor/rules/*.mdc          .windsurf/rules/*.md       .clinerules/*.md
.github/copilot-instructions.md          .junie/guidelines.md         …
```

Keep them in sync by hand and they drift within a week. Change your review standards
in one, forget the other six, and your agents quietly disagree with each other.

## The idea

Write **one** master file. `agent-cli` writes a small **pointer stub** into every tool's
native config location, telling that tool where the real file lives.

```
                    ~/AGENTS.md   ← the one file you edit
                         │
        ┌────────────┬───┴───┬────────────┬─────────────┐
        ▼            ▼       ▼            ▼             ▼
  ~/.claude/    ~/.codex/  ~/.gemini/  .cursor/     …17 tools
   CLAUDE.md    AGENTS.md  GEMINI.md   rules/*.mdc
   └──────────── pointer stubs, regenerated any time ────────────┘
```

You never edit the same prose twice. Stubs are safe to regenerate — `agent-cli` only ever
touches files it created itself, and backs up native content before overwriting it.

Around that master file it also manages a **brain**: identity and user profile, model
aliases, lessons learned, sub-agent personas, delegation handoffs, snapshots, an MCP
server, and a bundled skill manager.

## Install

```bash
npm install -g @victortomaili/agent-cli
```

Node.js **≥ 22** (ESM). Installs the global `agent-cli` command.

## Quick start

```bash
agent-cli init      # bootstrap the master, detect + link installed tools, install hooks
agent-cli status    # master state + per-target pointer health
agent-cli doctor    # full diagnostic (config, pointers, staged updates, npm freshness)
agent-cli edit      # open the master in $EDITOR
```

`init` is **idempotent and never prompts** — re-running repairs anything missing without
touching content you have edited. It is the one command that turns a bare install into a
working setup: it seeds the master, writes pointer stubs for every detected tool, deploys
the home pointer at `~/AGENTS.md`, installs SessionStart brief hooks, and sets up the
bundled skill manager.

## Let your agent install it

`agent-cli` is built to be driven by an AI agent, so you can hand the whole setup to one.
**Copy the prompt below into Claude Code, Codex, Cursor, Gemini CLI, or any agent with
shell access** — it installs, configures, verifies, and reports back without you touching
anything.

````markdown
Install and configure `agent-cli` on this machine for me, end to end. It manages a single
canonical AGENTS.md and mirrors it into every AI coding tool I have installed.

Do this:

1. Check prerequisites: `node --version` must be >= 22. If it is older, stop and tell me.
2. Install: `npm install -g @victortomaili/agent-cli`
3. Bootstrap: `agent-cli init`
   It is idempotent and never prompts, so it is safe to run even if something already exists.
4. Read the built-in guide so you know how to drive it: `agent-cli instructions`
5. Verify: `agent-cli doctor --json`
   Exit code 2 means findings, not failure — read the JSON and fix what it reports.
   Re-run `agent-cli init` to repair anything missing.
6. Show me `agent-cli status` and tell me, in plain language:
   - which of my AI coding tools were detected and linked,
   - where my master file now lives,
   - anything doctor flagged that needs my decision.

Rules:
- Never pass `--force` — it overwrites my existing content.
- Never edit the pointer stubs by hand; they are generated.
- If a step fails, show me the actual error instead of working around it.

Then run `agent-cli prompt` and add its output to your own system prompt, so you stay
oriented about my setup for the rest of this session.
````

> **Tip:** after setup, `agent-cli prompt` emits a ~2 KB state-aware block for any agent's
> system prompt, and `agent-cli instructions` is the full static reference. Both are written
> for machine consumption.

## Supported tools

17 targets, one file each under [`src/targets/`](src/targets/). `agent-cli targets` lists
them live with install and enabled state.

| Tool | Global | Project |
| --- | --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` | `CLAUDE.md` |
| OpenAI Codex | `~/.codex/AGENTS.md` | `AGENTS.md` |
| DeepSeek Harness | `~/.dsh/AGENTS.md` | `AGENTS.md` |
| Gemini CLI / Code Assist / Antigravity | `~/.gemini/GEMINI.md` | `GEMINI.md` |
| Qwen Code | `~/.qwen/QWEN.md` | `QWEN.md` |
| pi coding agent | `~/.pi/agent/AGENTS.md` | `AGENTS.md` |
| Cline / Roo Code | `~/.cline/rules/agent-cli.md` | `.clinerules/agent-cli.md` |
| Cursor | — | `.cursor/rules/agent-cli.mdc` |
| Windsurf | — | `.windsurf/rules/agent-cli.md` |
| GitHub Copilot | — | `.github/copilot-instructions.md` |
| JetBrains Junie | — | `.junie/guidelines.md` |
| Trae | — | `.trae/rules/agent-cli.md` |
| Aider | — | `CONVENTIONS.md` |
| Zed AI | — | `AGENTS.md` |
| Warp | — | `AGENTS.md` |
| OpenCode | — | `AGENTS.md` |
| Goose (Block) | — | `.goose/hints` |

Missing yours? [Adding one](#adding-a-new-ai-coding-tool) is a two-file pull request.

## Core concepts

- **Master** — the one file you write: `~/AGENTS.md` (global) or `.agents/AGENTS.md`
  (project-scoped, inside a repo).
- **Pointer stub** — a small generated file `agent-cli link` writes at a tool's native
  config path. Machine-readable metadata plus a human-readable note redirecting the agent
  to the master. Safe to regenerate; only files `agent-cli` created are ever touched.
- **Target** — an AI coding tool `agent-cli` knows how to point at. `agent-cli targets`
  lists them; `agent-cli target enable <id> [--global|--project]` turns one on.
- **Backups before destruction** — `agent-cli link --target <id> --force` on a target that
  already holds your own content copies it to `<path>.agent-cli-backup-<iso>` first, and
  surfaces that path in the `--json` envelope's `backup` field.

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
| Shipped-default updates | `update list\|stage\|diff\|apply\|clear`, `upgrade` (`--overwrite` takes the shipped version of a file you changed — backed up first) |
| dev-team instrumentation | `ledger start\|record\|end\|show\|clear`, `ledger --handoff <taskId>`, `team eval run\|report`, `retro record\|count\|mark` |
| Skills | `skill setup\|refresh\|status\|list\|install\|enable\|disable` |
| Diagnostics | `doctor`, `validate`, `config`, `stats`, `whoami`, `files`, `manifest`, `schema` |
| Automation | `hooks install` (git hooks), `automation add\|list\|run`, `watch`, `serve` (MCP over stdio) |
| External MCP tools | `mcp servers\|enable\|disable\|tools\|call`, `mcp <tool> --arg k=v` |
| For LLM agents | `instructions` (static guide), `prompt [--for <task>]` (dynamic, state-aware) |

`agent-cli help <command>` for any of these; `agent-cli --json manifest` for the full
machine-readable command and exit-code contract.

Mistype something and it suggests the closest match — `agent-cli statuz` replies
`Did you mean: agent-cli status, agent-cli stats?`, so an agent can self-correct without
re-reading `--help`.

## For LLM agents driving the CLI

Two complementary commands — one dynamic, one static:

- **`agent-cli prompt [--for "<task>"]`** — inspects installed tools, brain state, and
  pending actions, then emits a tailored ~2 KB Markdown block for a system-prompt slot.
  **Run once per session.** The agent then knows which tools are linked, which brain
  fields are missing, what is pending, and which commands to reach for.
- **`agent-cli instructions`** (aliases `guide`, `for-llm`) — the static long-form
  reference, identical every run. For re-reading the full contract mid-session.

Per-turn loop: `agent-cli --json brief --plan` for the ordered action list with
safe-to-automate flags, and `agent-cli --json brief` for the state snapshot.

The formal contract — JSON envelope shape, exit codes, idempotency guarantees, error
taxonomy, atomic-write and lock semantics — is **[docs/contract.md](docs/contract.md)**.
That document is the spec; the README, `instructions`, `prompt`, and every `--help` defer
to it.

## MCP (Model Context Protocol)

`agent-cli serve` starts an MCP server over stdio for any MCP host — Claude Desktop,
VS Code, Cursor, and others. JSON-RPC 2.0, newline-delimited, no runtime dependencies.

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

VS Code's `vscode-mcp` uses the same `command`/`args` shape under a `servers` key in
`.vscode/mcp.json`; check your host's docs for the exact key.

**Read-only by default.** 6 read tools (`brief`, `doctor`, `search`, `snapshot`, `status`,
`spect_status`), 11 resources (`brain://*` — brain files, skills, targets, lessons, current
session), and 3 prompts (`prompt://session-start`, `prompt://instructions`,
`prompt://brief-plan`).

**Writes are capability-gated, not version-gated.** The 10 write tools appear only after a
host opts in during `initialize` with
`capabilities.experimental.agentCli.writeTools: true` — the exact boolean; truthy strings
fail closed. A host that does not opt in never sees a write tool in `tools/list`, and gets
`write_capability_required` if it calls one. A host-supplied `cwd` never redirects where a
write lands.

Full surface — `initialize` capabilities, the 11 resource URIs and payload contract, the
subscription delivery contract, the tool list — in [docs/contract.md](docs/contract.md).

### Calling other people's MCP servers

`agent-cli mcp` is the other direction: the servers you already wired into Claude Code and
pi, callable from the shell.

```bash
agent-cli mcp servers                          # everything configured, and its trust state
agent-cli mcp enable pi:web-search-prime       # approve one, once
agent-cli mcp tools pi:web-search-prime        # what it exposes
agent-cli mcp web_search --arg query="mcp spec"
```

Definitions are read from `~/.claude.json`, `~/.pi/agent/mcp.json`, and a project's
`.mcp.json` — declared once, where their owner already declared them. agent-cli stores a
reference and a fingerprint, never a copy, and least of all a credential.

**Nothing runs until you enable it.** These commands are meant to be run *by* agents,
non-interactively, so appearing in a config file must not be enough to make a server
executable — otherwise anything that can write `~/.claude.json` gets code run by the next
agent that calls a tool. `enable` is the approval step a non-interactive CLI cannot prompt
for, and it pins the definition: change the command, args, url, env or headers afterwards
and the server is refused until a human re-approves it.

**Arguments go through `--arg`, never as bare words.** `mcp call search --query hi` cannot
work — the CLI parser takes `--query` as its own option and the tool would receive nothing.
Use `--arg k=v` (repeatable), or `--args-json` / `--args-file` / `--args-stdin` for
anything nested.

Spawned servers get an allowlisted environment rather than your whole session, HTTPS is
required and redirects refused, link-local and metadata addresses are rejected, and every
string a server sends back is credential-redacted and control-stripped before it reaches
your terminal. The trust model is specified in [docs/contract.md](docs/contract.md).

## The dev-team skill

The bundled **dev-team** skill turns the main agent of any agentic CLI host into the
**orchestrator-agent** of a virtual software company: 14 on-demand role personas plus the
fixed orchestrator.

| Group | Roles |
| --- | --- |
| Product & Design | `product-manager`, `product-owner`, `business-analyst`, `ux-ui-designer` |
| Engineering & Architecture | `software-architect`, `tech-lead`, `frontend-dev`, `backend-dev`, `fullstack-dev`, `ai-ml-engineer` |
| Operations & Quality | `qa-engineer`, `devops-engineer` |
| Management | `project-manager`, `scrum-master` |

The protocol is host-agnostic:

```
backlog item → every relevant role writes its own perspective (round 1)
             → perspectives shared for a second turn (round 2)
             → orchestrator synthesizes a master plan
             → decomposed into a dependency-aware task DAG
               (blocking/parallel, per-task tool + model/thinking config)
             → dispatch, validate, deliver, support
```

On hosts with `agent-cli` installed the protocol is **instrumented**: one ledger line per
finished dispatch, a persisted retro per delivery, and a real number behind the
Self-Improvement Loop's threshold (`agent-cli team eval report`). Every instrumentation
step is host-optional — the protocol runs unchanged where `agent-cli` is absent.

Role personas live in [`seed/agents/`](seed/agents/) (each passes `agent-cli agents
validate`); the protocol lives in [`seed/skills/dev-team/`](seed/skills/dev-team/)
(`SKILL.md` / `ROLES.md` / `WORKFLOW.md`). Both deploy into `~/.agents/` on
`agent-cli init`.

## Keeping up to date

Two independent things update:

**The npm package** —

```bash
npm install -g @victortomaili/agent-cli@latest
```

`agent-cli doctor` and the session-start brief tell you when a newer version exists. Every
command also emits a one-line notice on stderr (or an `updateNotice` field in `--json`) so
an agent can react automatically. Opt out with `--no-update-check` or
`AGENT_CLI_NO_UPDATE_CHECK=1`.

**Shipped default content** — seed files and managed instruction blocks in your existing
brain, independent of the package version:

```bash
agent-cli update list          # what is staged
agent-cli update diff <ver>    # review before applying
agent-cli upgrade              # apply everything staged
agent-cli upgrade --overwrite  # also replace files you changed (backed up first)
```

Typical flow after a release: update the npm package, then `agent-cli upgrade`.

**Brain schema migrations** — when a release ships new structured tags for
`IDENTITY.md` / `SOUL.md` / `USER.md`, the `memory upgrade` tree walks an LLM agent
through it one file at a time:

```bash
agent-cli memory upgrade status       # what schema you are on, what is pending
agent-cli memory upgrade plan --json  # the plan + an instructionsForAgent walkthrough
agent-cli memory upgrade prepare <id> # back up the file, print the migration spec
agent-cli memory upgrade apply <id>   # mark applied (bumps .schema-version)
```

Files are backed up to `~/.agents/.upgrade-backups/<ts>-<id>/` first, so you can roll back.

## Adding a new AI coding tool

```bash
node scripts/add-target.js <id> "<Display Name>" <docs-url> [global] [project] [detect]
```

That scaffolds `src/targets/<id>.js` with the documented fields, updates
`src/targets/index.js` to import and list it, and prints the next steps. Run
`npm run check && npm test` and open a PR — a two-file change, with the scaffold doing the
index edit so ordering stays correct and `index.js` does not become a merge-conflict
magnet. (`src/targets.js` is a thin re-export shim kept for backward compatibility.)

## Development

```bash
git clone https://github.com/VictorTomaili/agent-cli.git
cd agent-cli
npm install
npm link            # global `agent-cli` backed by this checkout

npm run check       # syntax-check every src/*.js
npm test            # node --test test/*.test.js
```

**Never point a development build at your real brain.** Every command and every test
honours `AGENT_CLI_HOME`:

```bash
AGENT_CLI_HOME=$(mktemp -d) agent-cli doctor
```

CI runs `npm run check && npm test` on ubuntu × windows × Node 22 × 24.

See [CONTRIBUTING.md](CONTRIBUTING.md) for layering, invariants, and conventions;
[ARCHITECTURE.md](ARCHITECTURE.md) for how the code is organised;
[CHANGELOG.md](CHANGELOG.md) for what changed;
[SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[MIT](LICENSE) © Victor Tomaili
