# Changelog

Notable changes to `@victortomaili/agent-cli`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Releases are automatic: bumping `version` in `package.json` on `main` publishes
to npm and pushes the matching `vX.Y.Z` tag.

## [Unreleased]

### Fixed

- **`models set` destroyed every other alias in MODELS.md (data loss, high).**
  `writeModelsMd()` rendered the whole `## Aliases` block from
  `config.json#models.aliases`, so a single `agent-cli models set <alias>
  <provider/model>` deleted every `<ALIAS>` line the config had not (yet) heard
  of, and `setAlias()` merged over a config-only `prev`, so the target's
  `fallbacks=""` chain was cleared as well. `~/.agents/MODELS.md` is
  hand-editable by design, is the record the whole alias system reads, and is
  not tracked by git — so the drift that triggers this (a hand-edited file, a
  restored MODELS.md, a repaired or reset `config.json`) is normal and the loss
  was unrecoverable. The command printed a success line either way.

  The `## Aliases` block is now maintained by a per-line upsert: a line is
  rewritten only when config says something different about that alias,
  appended when config has an alias the file lacks, and deleted only for names
  passed in the new `writeModelsMd({ drop })` option (which `models rm` now
  supplies). Every other line — including one for an alias `config.json` has
  never seen, and one whose attributes are hand-ordered — comes back
  byte-identical. `setAlias()` fills gaps from MODELS.md before merging, so
  `models set` without `--fallback` preserves the existing chain (and its
  category/thinking); `--fallback` still replaces it. `models rm` can now also
  clear a line that exists only in MODELS.md, which was previously unremovable.
  Regression coverage in `test/models-md-preserve.test.js`.

## [0.9.0]

Closes 57 of 58 open CodeQL security alerts (the 1 remaining is the
`js/missing-workflow-permissions` rule on `.github/workflows/codeql.yml`
itself, which the workflow already satisfies — the alert is stale until
the next re-scan). Adds two new safe-FS helpers in `src/util.js`,
enables branch protection on `main` with the CodeQL Analyze
context as a required status check, and ships the
`scripts/codeql/severity-policy.json` mapping each rule family to
block/advisory.

### Security

Four critical fixes ship in this release; all four are recommended
upgrades for anyone running `agent-cli` in production.

- **CRITICAL: skill-tool sandbox bypass (P0-4).** `src/skills/commands/run.js`
  previously checked static imports against the allowlist, but `FORBIDDEN_IMPORT`
  was dead code and the active `IMPORT_SPEC` regex required quoted specifiers —
  so a malicious `SKILL.tool.js` doing `const s = "node:child_process"; return
  import(s)` was accepted and ran the disallowed module in-process. The new
  regex splits static (quoted only) and dynamic (quoted OR identifier) forms;
  unquoted identifiers in a dynamic position are always banned. Added test
  coverage in `test/skill-authoring.test.js`. Audit of `~/.skill-cli/store`:
  no installed skill triggers the new check.
- **`agent-cli snapshot --json` returned invalid envelope (P0-1).** `snap()`
  is async; the previous `const r = snap()` spread a Promise into the
  envelope, yielding `{ok: undefined, files: undefined}`. Added `await`.
- **`agent-cli clear` no-op vs clear could leak the empty file (P0-2).** The
  `existsSync` + `writeFileSync` race in `clearLedger` is gone — replaced with
  `openSync(p, "r+")` + `ftruncateSync(0)`. `flag: "r+"` requires the file to
  exist; ENOENT is translated to `cleared:false` (no-op on missing).
- **Temp dir parent symlinkable (P0-3).** `src/runners.js` used
  `mkdirSync({recursive:true})` on a predictable parent path, which an
  attacker could symlink on shared systems. Now uses `mkdtempSync` (0700 unique
  dir) + `crypto.randomBytes(8)` filename suffix. Windows-safe precedent at
  `src/consolidate.js:264` and `src/archetypes.js:84`.

### Added

- `src/util.js` exports two new safe-FS helpers used by 9 call sites across
  `src/`:
  - `writeFileIfAbsent(p, content, {mode})` — exclusive-create (`wx`) open.
    Throws through any error other than `EEXIST`. Returns
    `{created: true|false}`. Reference implementation: `src/secrets.js:35`.
  - `readFileNoFollow(p, {maxBytes})` — opens fd with `O_NOFOLLOW` (POSIX) or
    `O_RDONLY` + `fstatSync` isFile guard (Windows). Refuses symlinks,
    directories, devices; optional byte cap.
- `scripts/codeql/severity-policy.json` — the rule-family → block/advisory
  mapping enforced via branch protection. Block rules are real security or
  correctness bugs; advisory rules are quality/maintainability findings that
  batch in the next minor instead of blocking each PR.
- Branch protection on `main`: `Analyze (javascript-typescript)` is a required
  status check. `enforce_admins: true`, `required_linear_history: true`.

### Fixed

- **`js/file-system-race`** (17 sites closed, 0 remaining in `src/`+`scripts/):
  - 3 write-side sites migrated to `writeFileIfAbsent`:
    `src/skills/commands/create.js`, `scripts/add-target.js`, and
    `src/dispatch-ledger.js` (overwrite case — `existsSync` dropped, `r+`
    - `ftruncateSync` used).
  - 5 read-side sites migrated to `readFileNoFollow`: `src/skills/lib/store.js`,
    `src/snapshot.js:229,313`, `src/sync.js:79`, `src/skills/commands/run.js:45`.
  - 1 mkdir race suppressed with rationale comment:
    `src/snapshot.js:111` (`copyDirSync` — both src/dst are agent-cli-owned,
    single-process, benign).
  - 8 test/ sites suppressed with per-site rationale (single-process
    fixtures / restore helpers / the race-the-test-simulates case).
- **`js/incomplete-multi-character-sanitization`** (2 real fixes, 0
  remaining): `src/lessons-lib.js` and `src/agents-lib.js` switched to a
  loop-until-stable HTML comment strip. A single-pass regex left `<!--`
  behind when adjacent text created new `<!--` substrings.
- **`js/superfluous-trailing-arguments`** (4 sites): `src/skills/cli.js`
  stopped forwarding `rest` to `cmdSearch()`/`cmdActive()`/`cmdDefaults()`
  — all three are zero-arg.
- **`js/unused-local-variable`** (30 sites closed via the bulk cleanup PRs):
  `src/actions.js`, `src/api/index.js`, `src/commands/{inspect,prompt}.js`,
  `src/consolidate.js`, `src/handoff.js`, `src/hooks.js`, `src/managed-resource.js`,
  `src/memory.js`, `src/memory-upgrade.js`, `src/prompt-report.js`,
  `src/search.js`, `src/skills/commands/{capture,run}.js`, `src/store.js`,
  plus 6 test files (`captured`/`kebabToHeading`/`mkdirSync`/`readFileSync`/
  `lstatSync`/`statSync`). A handful were restored after linter
  false positives (e.g. `mkdirSync` IS used in `test/skill-install.test.js`
  16 times).
- **`js/incomplete-sanitization`** (2 false-positive suppressions):
  `src/models.js:534` and `test/cli.test.js:1811` already use the `/g` flag;
  inline `// lgtm` comments cite the regex semantics.

### Layering note

`src/skills/**` cannot import from `src/util.js` per the import-boundary
test (`test/import-boundaries.test.js:117`). The 3 skills/ file-system-race
sites use direct `fs.openSync(p, "wx"/"r")` + `fstatSync` + close in a
try/finally — the same primitive the new helpers wrap, inlined so the
self-contained skills subsystem stays layer-pure.

## [0.8.1]

0.8.0 could reject a bad model alias but not remove one.

### Added

- `agent-cli models rm <alias>` — delete a model alias. 0.8.0 made `models set`
  reject a name outside `^[a-z0-9][a-z0-9-]*$`, but nothing could remove the
  ones already written before that check landed (e.g. a key with a trailing
  HTML comment). `removeAlias` deliberately skips the name check, since
  validating on delete would leave exactly those keys unfixable.

### Fixed

- **`doctor` read the real home even under `AGENT_CLI_HOME`.** The
  `no-orphan-personalities` check resolved `~/.pi/agent/agents` through
  `os.homedir()` while every other path in the module went through the
  override-aware `HOME`, so a sandboxed report described the developer's own
  machine. Linking that directory for real was enough to turn an unrelated
  sandboxed test red, with nothing in the test to explain why. CI never caught
  it because a fresh runner has no `~/.pi`.

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

[Unreleased]: https://github.com/VictorTomaili/agent-cli/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/VictorTomaili/agent-cli/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/VictorTomaili/agent-cli/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/VictorTomaili/agent-cli/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/VictorTomaili/agent-cli/releases/tag/v0.7.0
