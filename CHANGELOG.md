# Changelog

Notable changes to `@victortomaili/agent-cli`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Releases are automatic: bumping `version` in `package.json` on `main` publishes
to npm and pushes the matching `vX.Y.Z` tag.

## [Unreleased]

## [0.8.0]

The MCP server, and the dev-team instrumentation it measures itself with.

### Added

- **MCP server over stdio** (`agent-cli serve`) — usable from Claude Desktop,
  VS Code, Cursor, or any MCP host. 6 read tools, 11 resources (`brain://*`),
  3 prompts, and **10 write tools behind an opt-in capability**: a host sees
  them only after offering `capabilities.experimental.agentCli.writeTools: true`
  during `initialize`. A host-supplied `cwd` never redirects where a write
  lands. Full surface in [`docs/contract.md`](docs/contract.md).
- **Dispatch ledger** (`agent-cli ledger start|record|end|show|clear`) — an
  append-only, session-scoped JSON-lines log of which role ran which task on
  which model. `ledger start` pins a session id so separate CLI processes append
  to one ledger.
- **Team KPI harness** (`agent-cli team eval run|report`) — aggregates a
  session's ledger into per-role counts, success rate, and elapsed time.
- **Retro persistence** (`agent-cli retro record|count|mark`) — dev-team retros
  are written to the lessons store instead of an in-session note, so the
  Self-Improvement Loop's "5 entries since the last loop" threshold survives
  session boundaries.
- **Handoff artifacts** (`agent-cli ledger --handoff <taskId>`) — assembles a
  dependent task's predecessor context from the ledger.
- **Content-hash staleness detection** — `brief` and `doctor` now warn when the
  live `~/.agents/skills/dev-team` tree has fallen behind the shipped seed,
  instead of comparing version strings only.
- `update apply --overwrite` / `upgrade --overwrite` — take the shipped version
  of a file that diverged, backing the previous content up first.

### Changed

- **The dev-team protocol is instrumented.** `WORKFLOW.md` now records one
  ledger line per finished dispatch (Stage 6), persists the retro (Stage 8), and
  reads a real number for the Self-Improvement trigger. Every command is marked
  host-optional, so the protocol still runs where `agent-cli` is not installed.
- Protocol rewrite: tiered refutation, dual-check validation, an evidence table
  with a closed verdict enum, a citation re-derivation rule, structured
  perspectives, and a role rubric.
- `retro record` no longer requires `--session`, and accepts `--lesson <text>`
  in addition to stdin.
- npm tarball now allowlists `docs/contract.md` rather than the whole `docs/`
  folder.

### Fixed

- **Path containment in three places** — a session id could escape the `.logs`
  directory on read (`team eval report --session ../../x`), and a task id could
  write a handoff artifact outside `~/.agents/handoffs/`. Both now fold through
  a single `sanitizePathSegment` chokepoint.
- **The secrets key could be destroyed by a race.** `loadKey` derived the
  AES-256 key with `existsSync`-then-write: two processes starting together
  both saw "no key", both generated one, and the second overwrote the key the
  first had already encrypted secrets with — silently making them
  undecryptable. Now an exclusive `wx` create that re-reads the winner's key.
- **Regex injection in two places** — `env-capture` built its field matcher by
  interpolating a caller-supplied field name, so a field of `.*` matched every
  line and the typo guard reported the opposite of the truth. `add-target`'s
  double-add guard had the same shape. Both now match literally.
- **Test isolation** — `add-target` tests scaffolded into the live
  `src/targets/` tree, and since `node --test` runs files in parallel
  processes, an unrelated worker could import a module not yet written. It
  surfaced as intermittent `ERR_MODULE_NOT_FOUND` and "does not provide an
  export named `TARGETS`" failures in other test files. Scaffolding now targets
  a temp copy via `AGENT_CLI_SCAFFOLD_ROOT`.
- **`upgrade` could never deliver a staged payload.** Any file whose content
  differed from the payload was skipped as "diverged" — which is every file that
  actually changed between seeds — while the command still printed success. It
  now warns, names each skipped file, and offers `--overwrite`.
- **Windows: drift reports used a mixed path separator** (`skills\dev-team/…`),
  which also kept the Windows CI legs red.
- Model aliases reject invalid names on write.
- `snapshot` no longer leaves an unawaited `ensureDir` in sync paths.

- npm tarball allowlists `docs/contract.md` rather than the whole `docs/`
  folder, so a local planning note cannot reach the registry.

### Security

- Write tools are capability-gated and default-off; `restore` is deliberately
  not exposed over MCP.
- Read-side and write-side security audits informed the release; findings are
  fixed in the shipped code.
- **CodeQL** now runs on every push, pull request, and weekly, over both the
  CLI and the workflows, using the `security-and-quality` suite.
- CI workflows declare least-privilege `permissions` instead of inheriting the
  repository default.
- npm releases are published with **provenance**, so each tarball carries a
  verifiable attestation linking it to the workflow run and commit.

### Dependencies

- commander 12 → 15, `@inquirer/core` 10 → 12, `@inquirer/prompts` 7 → 8,
  `actions/checkout` 5 → 7, `actions/setup-node` 5/6 → 7. `setup-node` v7
  removes the dummy `NODE_AUTH_TOKEN` export that previously interfered with
  OIDC publishing.

## [0.7.0] and earlier

See the [commit history](https://github.com/VictorTomaili/agent-cli/commits/main).

[Unreleased]: https://github.com/VictorTomaili/agent-cli/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/VictorTomaili/agent-cli/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/VictorTomaili/agent-cli/releases/tag/v0.7.0
