# Contributing

Thanks for taking the time. This is a small, opinionated codebase — the fastest
way to get a change merged is to match what is already there.

## Getting set up

```bash
git clone https://github.com/VictorTomaili/agent-cli.git
cd agent-cli
npm install
npm run check && npm test
```

Node **22 or newer** is required (`package.json` `engines`). The test script
relies on the runner's own glob expansion, which needs Node 21+.

**Never run the CLI against your real brain while developing.** Point it
somewhere disposable:

```bash
AGENT_CLI_HOME=$(mktemp -d) node src/cli.js doctor
```

Every command and every test honours `AGENT_CLI_HOME`. If you find one that does
not, that is a bug worth reporting on its own.

## Before you open a pull request

```bash
npm run check && npm test
```

CI runs exactly these two commands on ubuntu × windows × Node 22 × 24. The
Windows legs are not decorative — this project has shipped Windows-only path
bugs before, so if your change touches a path, think about the separator.

## How the code is laid out

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) first; it is short and current.
The layering matters and is enforced by `test/import-boundaries.test.js`:

```
src/cli.js          entry point — the only file that may import every command
src/commands/*.js   thin: parse options, call lib, format output
src/*.js            the library
src/api/index.js    a read-only SDK over the library
src/skills/**       self-contained; two sanctioned bridges reach in
```

Command modules export `registerXCommands(program, deps)` and receive their
dependencies injected. Keep them thin — logic belongs in the library, where it
can be tested without spawning a process.

## Invariants not to weaken

`ARCHITECTURE.md` lists these in full. The short version:

- atomic writes, locked config writes,
- path containment on anything driven by input,
- pointer-only deletion,
- secrets never synced, snapshotted, or searched.

If a change appears to require breaking one of these, open an issue first — it
usually means there is a better shape for the change.

## Conventions

- **Tests are not optional.** A bug fix gets a regression test that fails
  before the fix; a feature gets tests for the contract, not just the happy
  path. Use `node:test` and an isolated `AGENT_CLI_HOME`.
- **Comments explain why, not what.** The surrounding code is dense with
  rationale — match that. A comment restating the line below it is noise.
- **Commits** use conventional-commit prefixes (`feat:`, `fix:`, `docs:`,
  `build:`, `chore:`) and a body that says what was wrong, not just what
  changed.
- **File size.** Modules stay around 500 lines. Past that, split by concern.
- **JSON output is a contract.** Adding a field is fine; renaming or removing
  one is a breaking change to `apiVersion` (see [`docs/contract.md`](docs/contract.md)).

## Adding support for a new AI coding tool

This is the most common contribution and it is deliberately easy — see
[the README section](README.md#adding-a-new-ai-coding-tool). In short: add a
target descriptor, and the pointer/link/detect machinery picks it up. Include a
test proving detection works when the marker exists and does not when it does not.

## Releasing

Maintainer only, and fully automatic: bump `version` in `package.json` and push
to `main`. `.github/workflows/publish.yml` publishes to npm via OIDC trusted
publishing and pushes the `vX.Y.Z` tag. A red `check` or `test` blocks the
release.

## Reporting security issues

Do not open a public issue — see [`SECURITY.md`](SECURITY.md).
