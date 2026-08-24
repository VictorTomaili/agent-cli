# AGENTS.md

Instructions for any AI coding agent (Claude Code, Codex, Cursor, etc.) working in this repo.
Humans: see [README.md](README.md) for the user-facing docs and [ARCHITECTURE.md](ARCHITECTURE.md)
for the full layer-by-layer map.

## What this is

`agent-cli` (npm: `@victortomaili/agent-cli`, bin: `agent-cli`) manages `AGENTS.md`-style
instruction files and syncs them across every AI coding tool a user has installed. Node.js
>= 22, ESM (`"type": "module"`), zero build step — `src/cli.js` runs directly.

## Install / update / init

These are the commands a user (or an agent driving `npm`/`agent-cli` on a user's behalf) runs
against the *published package*, not this checkout:

```bash
npm install -g @victortomaili/agent-cli        # install
npm update -g @victortomaili/agent-cli          # update to latest published version
agent-cli init                                  # bootstrap ~/AGENTS.md + pointer stubs (idempotent)
```

Don't confuse that `npm update` with `agent-cli update` / `agent-cli upgrade` — the latter apply
*shipped-default content* (seed files, managed instruction blocks) to an already-installed
user's `~/.agents/` brain and are unrelated to the package version.

## Working in this checkout

```bash
npm install     # dependencies
npm link        # global `agent-cli` command backed by this checkout (for manual testing)
npm run check   # syntax-check every src/*.js file (= npm run lint = npm run build)
npm test        # node --test test/*.test.js
```

Run `npm run check && npm test` before considering any change done — CI (`.github/workflows/ci.yml`)
runs the same two commands on the ubuntu/windows × Node 22/24 matrix, and `.github/workflows/publish.yml`
publishes to npm automatically on every `master` push whose `package.json` version isn't on the
registry yet, so a broken `check`/`test` blocks a real release, not just a PR.

## Conventions to preserve

- **Layering** (`src/cli.js` → `src/commands/*.js` → `src/*.js` lib; `src/api/index.js` is a
  read-only SDK over lib; `src/skills/**` is self-contained). Enforced by
  `test/import-boundaries.test.js` — read it before adding a new cross-module import.
- **DI pattern**: every command module exports `registerXCommands(program, deps)`; `src/cli.js`
  builds `deps` once. Keep command files thin — parse options, call lib functions, format
  output.
- **Cross-cutting invariants** (see ARCHITECTURE.md's "do not weaken these"): atomic writes
  (`util.js`), locked config writes (cross-process CAS in `config.js`), path containment on any
  write/delete driven by untrusted input, pointer-only deletion in `unlink`, secrets never
  synced/snapshotted/searched.
- **npm publish surface**: only what's listed in `package.json`'s `"files"` array
  (`src`, `seed`, `README.md`, `LICENSE`) ships in the tarball. `ARCHITECTURE.md` and `.spec/`
  never do — don't assume a new root-level doc is visible to an installed user.
- **`.spec/`** — single local-only folder for the project's spec-driven-dev workflow AND
  internal planning notes (`README.md`, `constitution.md`, `specs/`, `plans/`, `tasks/`,
  `templates/`, `ROADMAP.md`, `findings.md`). Gitignored, never committed, never shipped in
  the tarball. The CLI's `spect` command points here. Don't recreate these docs at the repo root.

## Commit messages

No co-authorship trailer (no `Co-Authored-By`) — this is a house rule for this project, not the
harness default.
