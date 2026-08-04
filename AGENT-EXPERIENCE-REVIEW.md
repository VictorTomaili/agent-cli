# Agent Experience & Usability Review — New Features and Capabilities

> **Method**: 6 specialized parallel agents over `@tomaili/agent` v0.2.1, focused on **agent experience, usability, and new capabilities** — a different lens from the security/correctness work in `PROJECT-ANALYSIS.md`. Models: gpt-5.6-luna (deep) + deepseek-v4-flash (5 lenses).
>
> **Per-lens reports**: `review/a1-session-flow.md` (AI session), `review/a2-features.md` (feature gaps), `review/a3-ergonomics.md` (CLI ergonomics), `review/a4-automation.md` (protocol/CI), `review/a5-workflows.md` (end-to-end workflows), `review/a6-skills.md` (skill ecosystem).
>
> **Scope note**: security/correctness defects already catalogued in `PROJECT-ANALYSIS.md` are **not re-reported**; they are referenced only where they constrain an improvement.

---

## Executive Summary

`@tomaili/agent` is already the best-shaped AI-first CLI of its kind: `--json` everywhere, idempotent `link`, a `brief` that emits a session-load manifest and suggested actions, and a coherent single-source-of-truth mental model (`~/.agents` master + identity/memory files). All six reviewers converged on the same thesis:

**It is a single-machine, single-operator "brain" today. The leap from config manager to agent-enablement platform needs three moves: *portability* (sync + secrets), *executability* (SPECT tasks, update-apply, handoffs, session lifecycle), and *retrieval* (search).** On top of those, the machine contract (structured actions, exit codes, SDK/MCP) and the first-run/help experience must be hardened.

The single highest-leverage technical change: **make `brief` a versioned, executable session contract** and **extract a programmatic SDK** — both unblock most of the other proposals.

---

## The one-sentence-able themes (all six reports agree)

1. **`brief` is a diagnostic snapshot, not an executable plan.** `suggestedActions` are free-form shell strings (`src/cli.js:1920-1936`) with no IDs, priority, safety, or dependencies. Agents must parse English and sequence work themselves.
2. **The START GATE / skill `active` model is aspirational, not machine-checkable.** It forces agents to infer axis classification and parameters from free-text descriptions and to interrupt for a user turn. There's no durable policy or JSON gate protocol.
3. **No programmatic surface.** Only a subprocess CLI exists — no SDK, no MCP server, no daemon/watch/hooks/cron. Nothing can react to drift without polling.
4. **No portability.** Snapshots are local copies; there is no multi-machine/team/backup-to-remote story, and no place to safely store secrets (which sync would leak).
5. **SPECT and seed-updates are half-built.** `spect init|status` scaffold only; `update list|diff|stage|clear` has no `apply`. Both are scaffolding without the executing loop.
6. **First-run and help are the worst UX.** Bare `agent` exits non-zero with a red `✗` on stderr, `agent skill --help` hides the real skill surface, `init` human output is nearly silent, and the `-g/-p` scope defaults are **inverted** between the root and skill halves of the same binary.

---

## Tier 1 — Product-defining new capabilities

### 1. Git-backed brain sync + encrypted secrets store (`agent sync`, `agent secret`) — the keystone pair

**Why**: `~/.agents` has zero portability story (H1, a2). Lessons learned on machine A should reach machine B; teams should share conventions without hand-copying. But a portable brain needs a place for machine-local data and tokens, so **secrets are the enabler for sync**.

**Sync behavior** (`new src/sync.js`, `src/commands/sync.js`):
- `agent sync init [--remote <git-url>]`, `push` / `pull` / `status` / `log` / `diff [<commit>]` / `rollback <commit>` — all structured JSON.
- `agent sync auto on` to commit on every mutating command; `pull` auto-runs `agent link` (pointers embed absolute `master-abs:` paths, `src/pointer.js:12-36`).
- **Default exclusion policy**: `config.json`, `ENVIRONMENTS.md`, `backups/`, `.consolidate-state.json`, `.secrets.*`. Merge strategy: "most recent mtime wins per file" with `--take local|remote` conflict resolver (config.json / LESSONS.md core can conflict).
- `config.json` gains `sync: {remote, autoCommit, excluded, lastPull}`.

**Secrets behavior** (`new src/secrets.js`, `src/env-capture.js`, uses `node:crypto`):
- `agent secret set/get/list/rm/env` — AES-256-GCM store in `~/.agents/.secrets.json` (+ project scope), `0600` key file. Never synced; redacted from `files`/`brief`; `brief` reports `secrets: {missing:[...]}`.
- `agent env capture` — fills ENVIRONMENTS.md (currently seeded + gap-detected but with **no command to fill it**; `src/archetypes.js:156-187` tells the agent to do it by hand). Autodetect OS/arch/shell/home + parse `~/.ssh/config` aliases.

### 2. Executable SPECT workflow (`agent spect task|validate|report|next|close`)

**Why**: SPECT claims spec-driven development (`src/spect.js:10-45`) but only scaffolds dirs and lists files. This is the most half-built high-value feature and the piece that makes agent-cli a development platform (H3, a2; journey 4, a5).

- `agent spect task list [--spec SPEC-01] [--status]` — parse `tasks/*.md` checkboxes (`- [ ] TASK-001 [REQ-001] …`, `src/spect.js:123-131`) into structured tasks linked to REQ-IDs.
- `agent spect task done|open <TASK-001>` — mark by stable ID, not fragile prose.
- `agent spect validate` — cross-reference integrity: every `[REQ-XXX]` in a task exists in some spec; flag orphan REQs (defined, never implemented) and dangling task REQs (implemented, never verified).
- `agent spect report [--spec] --json` — per-REQ acceptance-criteria coverage `{req, implemented, verified, status}`. Fold the headline into `brief`.
- `agent spect next` / `agent spect close` — print the next unchecked task with files + acceptance criteria; on close, write a lesson + suggest a snapshot.
- `agent spect trace <spec-id> --json` — REQ→TASK→verification traceability check: orphan REQs (defined, never implemented), dangling TASK REQs (implemented, never verified), REQs with no verification line. Pure read-only (a5 P0-4).
- Wire to seeded planner/worker/reviewer roles (`seed/agents/*.md`) and to lessons/consolidation.

### 3. Memory retrieval (`agent search`, `agent lessons search`)

**Why**: the brain stores lessons whose *filenames* are the summaries, plus identity files, core pointers, and SPECT docs — but there is **no search primitive** (H4, a2). Retrieval turns stored memory into working memory.

- `agent search <query> [--kind lessons|identity|spect|all] [--project] [--limit] --json` — rank across `lessons/`, `LESSONS.md` core, identity files, and `.spect/`, returning `{path, score, excerpt, tokens, scope}`. Start tokenized TF + filename scoring (no deps); an embedding provider slots in behind the same contract later.
- `agent lessons search <query>` — scoped, per-file `{path, occurrences, marked, excerpt}`.
- This is the base layer for `brief --for <task>` (Tier 2).

### 4. Versioned, executable session contract (`brief --plan`, `agent run`)

**Why**: the single highest-leverage technical change (a1, a4, a5 all converge). Convert `brief` from "state + strings" into a stable protocol agents can consume and act on.

- Add `schemaVersion`, `health` (`ready|degraded|blocked`), `warnings`, `blockers`, and **`actions:[{id, command, args, reason, severity, idempotent, safeToAutomate, precondition, verification, rollback}]`** alongside the current compatibility fields.
- `agent brief --next --json` (highest-priority action + preconditions), `--plan` (ordered plan, no writes), `--apply-safe` (execute only `safeToAutomate` actions, stop before user/destructive, return receipts), `--for <task>` (task-aware retrieval), `--since <etag>` / `--watch` (cache/bound repeated scans).
- `agent action verify <id> --json` — closes the feedback loop for every action.
- **Make `brief` observational by default**: move the npm update check behind `--refresh` (`src/cli.js:1793-1795`); today a "session brief" mutates config and hits the network.
- `doctor` mirrors the same `actions` contract (`agent doctor --plan`, `agent doctor --fix-safe`).

### 5. Programmatic SDK + MCP server + automation bus

**Why**: `package.json` `main`/`exports` point at the bin; nothing is callable as a function; there's no MCP, watch, hooks, or cron (F19-F20, a4; H9, a2). The SDK is the keystone that unblocks MCP/daemon/hooks/cron and in-process tests.

- Extract `src/api/*` exporting `init/link/unlink/consolidate/doctor/brief/status/snapshot(...)` returning the **same shape the CLI emits** without calling `process.exit`. `cli.js` becomes a thin adapter.
- `agent serve --mcp --stdio|--http <port>` — tools: brief, search, doctor, snapshot, files, skills, lessons, spect.
- `agent watch` — monitor `~/.agents`, `.agents`, `skill.config`, `.spect`; emit typed events (`memory.changed`, `spect.blocked`, `skill.drift`, `sync.conflict`).
- `agent hooks install --git` + `agent automation add <name> --event --command` + `agent webhook add <url> --events` (signed, redacted).
- Add `--offline` / `--no-network` (env `AGENT_OFFLINE=1`) and document a `docs/contract.md` (envelope, exit-code table, schema-version bump policy).

### 6. A real skill ecosystem (structured START GATE, authoring, publishing)

**Why**: the skill manager has a strong local lifecycle but is a compatibility bridge, not an ecosystem (a6). The START GATE forces agents to infer too much from free-text descriptions.

- **Structured gate (P0)**: add `activation: {mode: auto|ask|manual, axes, parameters, question}` to skill frontmatter; `agent skill active --json` returns structured records; `agent skill gate --task "..." --json` computes `autoLoad[]/ask[]/manual[]/questions[]`; `agent skill gate ack --enable ... --disable ... --session|--remember`. Remove "auto-load" wording until implemented; track gate decisions with stable `decisionId`s.
- **Authoring contract (P1)**: publish `skill.schema.json`; add `skill create`, `skill validate <path>`, `skill preview <path>`, `skill test <path>`.
- **Packaging/provenance (P1)**: `skill.lock` (exact source, revision, content hash, dependency graph), version constraints, provenance everywhere, trust levels (local / pinned commit / catalog / unsigned).
- **Discovery (P2)**: non-interactive `skill search <query> --json --local|--remote`, `skill recommend --task`, trigger-collision diagnostics.
- **Integration (P3)**: fold active/default/gate/recommended skills into `brief`; skill bundles; org policy (allow/deny sources, signed skills, pinned versions).
- **Fix the gate's coverage and dead code**: the START GATE reaches only 4 of 8+ marketed agents (`AGENT_GLOBALS` covers claude/codex/gemini/pi only; `paths.js:17-24`), and `injectToAllAgents`/`injectToAgentGlobal` (`agents-md.js:79-101`) have zero call sites — a dead competing design. Single-source the gate text (one constant feeding master injection, `active` output, and any future per-agent adapter) so prose and protocol can't drift (a6).
- **Lifecycle vocabulary cleanup**: `enable -g` ≡ `default` and `disable -g` ≡ `undefault` (same `defaults` list mutation), while `skill defaults` (plural) aliases the *active* catalog, not default-marked skills — six overlapping user-facing states. Merge to one canonical verb each (alias retained), make `defaults` list default-marked skills, and add a TTY "enable here / make default / leave passive" prompt at end of `install` (a6).
- **Executable skills + skill↔lessons loop**: add `skill run <name> -- <args>` for bundled `SKILL.tool.js` with a declared tool allowlist; `skill capture <name>` appends a lesson about a skill; `skill update` bumps that lesson's `lastSeen`; `brief` surfaces "skill X changed since your lesson about it" (a6).

---

## Tier 2 — High-value capabilities

### Session lifecycle & memory loop
- **`agent session start|end`** — record `{startedAt, endedAt, cwd, repo, branch, task, lessonsCaptured[]}`; `brief` surfaces the current session (M5, a2).
- **`agent lessons capture <topic> [--inbox|--direct]`** — **revive the dead triage loop**: today nothing in the tool writes `lessons/.inbox` (`src/lessons-lib.js:143-168` is read-only, "from the optional pi extension"), so `inbox`/`triage` counts are always 0 from in-tool usage (G3, a5). `capture --inbox` writes the capture + `sourceSession`/`repo`/`branch` frontmatter; `capture --direct` = today's `addLesson`. Then `lessons triage --plan` maps inbox items to candidate lesson paths before applying.
- **`agent memory check`** — implements the **documented but dead `consolidate.prompt: ask|auto|off`** preference: the string exists only in the USER.md template (`src/archetypes.js:142-145`), no code reads it (G2, a5). Read it via `readTag`, return `{action, consolidate:{score, recommend}}`; `--apply` runs `consolidate` only when `prompt=auto` + `recommend`.
- **`agent backups list|diff`** — consolidation's pre-run core backup (`~/.agents/backups/LESSONS-*.md`, `src/consolidate.js:207-224`) is **excluded from `snapshot()`** (`src/snapshot.js:59`) and invisible to `restore` (G4, a5). Surface the history; consider including consolidation backups in snapshot coverage.
- **`agent memory maintain`** — snapshot → triage inbox → consolidate (when recommended) → brief summary, in one command; `--global|--project|--all` (a5).
- **`agent session report`** — turn completed work into a structured lesson candidate + optional SPECT task verification update (a5).
- **`agent consolidate --plan --json` / `--apply <plan-id>`** — per-file promote/mark/keep/delete with reasons and a receipt; stable lesson IDs for safe retries (a1, a4).

### Composite workflow commands
- **`agent day-start` / `session-start`** — run skill-gate + `brief` as one action; `--bundle` embeds small files, `--paths-only` for low-token mode (a5).
- **`agent setup wizard` / `agent setup --project`** — orchestrate init, onboarding, model aliases, targets, skills, project bootstrap, baseline snapshot → readiness report (a5, a3).
- **`agent update apply <version>`** — copy staged files with pre-copy backup, refuse diverged live files, emit receipt `{applied, skipped, backedUp, diffStat}` (H5, a2).
- **`agent upgrade`** — compose update list → diff review → clear + link + skill refresh (a3).
- **`agent brain sync`** — git-backed versioning/diff/rollback (complement to Tier-1 sync; a5).
- **`agent doctor --fix` / `agent repair-plan`** — apply auto-fixable items, skip destructive, show before/after (a3, a5).

### Multi-agent orchestration
- **`agent handoff create|list|show|accept|close`** — real artifacts for delegated agents (the "Handoff" template section exists but has no wire format, `src/agents-lib.js:189-190`); `handoff close --lesson` files a learned lesson; surface `handoffs: {open: n}` in `brief` (H7, a2).
- **`agent agents brief` / `agent agents roster --json` / `agent agents edit <name>` / `agent delegate prepare <agent> --task ...`** — render a delegation prompt from a personality + current brief + relevant SPECT + lessons; `roster` joins agents × aliases × models into a positive verification view (currently only *unresolved* aliases warn); `edit` opens the personality in `$EDITOR` like `agent edit` (a5 P1-6). Today `identity apply` clobbers a set `<AGENT_NAME>` (archetype always emits it empty, `src/archetypes.js:99-100`; a5 Journey 6) and there is no `agents edit` at all.
- **`agent agents rename|remove|export|import`** — complete the personality lifecycle (currently list/show/new/validate/path only; M3, a2).
- **`agent whoami --json`** — one-line "who am I" from identity/soul/user/environments + gaps (M7, a2).

### Project & model tooling
- **`agent project detect|init|doctor`** — fingerprint repo, scaffold project `.agents`, check pointer health vs global (M1, a2).
- **`agent models lint` / `usage` / `test <alias>`** — aggregate unresolved/unused aliases, reverse index `{alias → [personalities]}`, optional provider connectivity probe (M4, a2).
- **`agent archetype export|import`**, **`agent template install`** — shareable identity/personality bundles reusing the proven fetch machinery (M2, a2).
- **`agent stats [--since]`** — local, privacy-safe usage analytics from sessions + snapshot history + consolidation state (M5, a2).

### Backup & restore hardening
- **File-level `restore <name> [--file rel...]`**, **`snapshot --retain <n>`**, **`snapshot diff <a> <b>`**, and **pre-mutation auto-snapshot** before `consolidate`/`restore`/`update apply`/`identity apply` (H6, a2; F14, a4). Extend snapshot coverage beyond global `~/.agents` to project `.agents`, `.spect`, and `~/.skill-cli` (a5).
- **`agent restore --relink`** — after restore, run `link` so pointer stubs match the restored master; today restore rolls `config.json` back but never re-links, leaving stubs pointing at a changed master (G5, a5). Add `--diff` preview mode (reuses `diffLines`).
- **Skill store + `skill.config` are outside the brain**: `~/.skill-cli` (`src/skill.js:17-19`) and `[cwd]/skill.config` (G9, a5) have no backup/restore path and `doctor` never checks project skill config — a false-green gap for "all checks passed".

---

## Tier 3 — Ergonomics & protocol fixes (high-impact, low-cost)

These are mostly UX/protocol correctness items verified live against a fresh install (a3):

### First-run / help correctness (P0)
- **Bare `agent`, `agent help`, `agent help <cmd>`: print help, exit 0, no stderr leak.** Today bare `agent` exits non-zero with `✗ (outputHelp)` (`src/cli.js:2108-2123`).
- **Make `agent skill --help` and `agent help skill` surface the real skill surface** — commander intercepts `--help` at any position and shows a 4-line stub; the rich help is only reachable as `agent skill help`.
- **`init` human output must summarize work** — created identity files, MODELS.md, seeded personalities, skill store, detected targets; add "Next: agent targets / agent target enable <id> -g" when 0 targets are enabled.
- **`agent` bare → guided quick start** in TTY (6-line primer), minimal primer in non-TTY; exit 0.

### Consistency (P1)
- **Reconcile inverted scope defaults.** Root commands default to **global** (`-p` = project); skill commands default to **project** (`-g` = global). Document or unify.
- **Make `-g`/`-p` mutually exclusive everywhere** (`link -g -p` runs both scopes; `target -g -p` lets `--project` win).
- **Disambiguate destructive `--force`** (4 meanings): rename `link --force` → `--overwrite`, `user --force` → `--replace`; leave `--force` for cache-refresh/skip-prompt.
- **`link --target <unknown>` must error** listing known ids, not print `✓ 0 linked` (silent success).
- **`where -p` should report the project master** (`masterPaths(scope)`, `src/cli.js:1270`).
- **Rename `lessons triage --file` → `--index`** (number) to disambiguate from `update diff --file` (path).
- **`brief` suggestions must include target onboarding** when `cfg.global` is empty, and the gap hint must mention `agent edit environments` (E17, E16).
- **Silence JSON-mode stderr** and strip commander's `error:` prefix from JSON error strings.

### Protocol contract (P0, a4 — all empirically verified)
- **Strip ANSI from every JSON payload**: `agent target enable bogus --json` returns `\u001b[36m`-colored text inside the `error` string, and `skill list`/`skill cat` payloads embed ANSI (`src/commands/target.js:32`, `src/cli.js:93-98`, `1509-1523`). Add a regression test asserting no `\u001b` in any `--json` stdout.
- **JSON-mode behavior parity**: `identity apply <unknown> --json` and `soul apply <unknown> --json` exit 0 and **write the fallback default** (IDENTITY.md changed) while human mode refuses with exit 1 (`src/cli.js:770-794`, `831-851`). Never let `--json` silently take a state-mutating default the human path refuses; require explicit `--fallback`.
- **Fix false failure on "nothing to do"**: `consolidate` on an empty install exits 1 with `{ok:false, reason:"no lessons dir"}` (`src/cli.js:1207-1219`) — a cron "consolidate if needed" loop fails on a healthy state. Exit 0 with `{ok:true, nothingToDo:true}`.
- **Fix false success on lookups**: `models resolve <missing> --json` exits 0 with `resolved:null` while `agents show <missing>` exits 1 — inconsistent miss signaling (E4, a4).
- **`agent help` and bare `agent` exit 1** — the catch handler whitelists `commander.helpDisplayed`/`commander.version` but not `commander.help` (`src/cli.js:2111-2114`). A discovery probe "fails". Bare `agent --json` should return a machine-readable manifest.
- **Adopt a shared JSON envelope**: `{ ok, command, apiVersion, data }` through a single `envelope()` — `ok` is today missing from success payloads and inconsistently shaped on failure (`consolidate` omits `error`; `restore` diverges between bare and named; `lessons triage`/`edit` bypass JSON).
- **Document an exit-code contract**: `0` ok/no-op, `2` actionable work available (`brief --check`, `doctor`), `3` partial, `1` error/usage, forward subprocess codes. Publish in `docs/contract.md` (and add the missing README, PROJECT-ANALYSIS L4).
- **Add `brief --check` / `--ci`** exiting `2` when actions are non-empty — the cron/monitor primitive.
- **Give the skill subsystem a native JSON mode** (today `agent skill <sub> --json` wraps ANSI text as an escaped string, `src/cli.js:1509-1522`); honor `--json` inside skill commands, which today silently ignore it.
- **Make read commands pure**: `brief`/`doctor`/`update list` mutate `config.json` as a side effect of the npm check (`src/cli.js:1312, 1734, 1795`); move refresh behind `--refresh` and add `--offline`/`AGENT_OFFLINE=1`.
- **Enforce the stdout single-value guard** (route `log.*` to stderr in JSON mode / guard centrally).
- **Add `--json=compact`, `--quiet/--silent`, and `NO_COLOR` support.**
- **Drop the subprocess spawn in `skillVersion()`** (`src/skill.js:104-116`) — every `status`/`doctor`/`brief` pays a Node subprocess for a version that is statically known.
- **Add `changed`/`nothingToDo` top-level booleans** to `link`/`unlink`/`consolidate` so scripts detect no-ops without counting `results`.
- **Add `agent manifest --json` and `agent schema [command]`** — machine-readable command surface + JSON schemas; `agent schema` doubles as the contract doc (a4 §3.7).

### Discoverability / mental model (P2-P3)
- **Reorder top-level help** (init first, then view-state, then mutation groups) or add a `Quick start: agent init` banner.
- **Per-command "Actions" blocks** in `--help` for the positional-action commands.
- **`agent config` command** — print config path + effective settings (config.json is currently undiscoverable, E18/E31).
- **`agent edit models`** — add the `models` kind to `edit` (currently "Unknown kind: models", E32).
- **`agent completion bash|zsh|fish|powershell`** — the single highest-ROI convenience missing for a 26-command tool (E29).
- **`agent version`** subcommand; **`status`** legend + reconciled summary; **`agent environments set`** so every memory file has a `set` verb; **`brief --oneline`** for shell prompts.
- Reconcile vocabulary: rename `agents` → `personas` (alias retained); drop `onboard`'s useless `[action]`.

---

## Recommended implementation order

**Phase 0 (foundation)** — these unblock everything:
1. **SDK extraction** (`src/api/*`) — prerequisite for MCP, daemon, hooks, cron, and in-process tests.
2. **Versioned JSON envelope + exit-code contract + `--check` + `--offline`** — makes cron/CI reliable. Includes the empirically verified protocol fixes: strip ANSI from JSON, JSON-mode behavior parity (`identity/soul apply` fallback), `consolidate` empty → `{ok:true, nothingToDo:true}`, `models resolve` miss → non-zero, `agent help`/bare `agent` → exit 0, `skillVersion()` subprocess removal.
3. **Make `brief`/`doctor` read-only** (`--refresh` gate) and structured-actions-based.

**Phase 1 (product-defining features):**
4. **Sync + secrets** together (Tier-1 #1) — portability with a safe place for tokens.
5. **Structured `brief` session contract + `agent run`** (Tier-1 #4).
6. **SPECT execution** (Tier-1 #2) — highest workflow value, self-contained in `src/spect.js`.
7. **Search** (Tier-1 #3) — unlocks retrieval for everything stored.

**Phase 2 (complete broken loops — the cheapest user-visible lies):**
8. **Memory wiring first** (a5 recommends this over new features): `lessons capture --inbox` revives the dead triage loop; `memory check` honors the documented-but-unimplemented `consolidate.prompt`; `backups list|diff` makes consolidation history visible; `restore --relink`.
9. **`update apply`**, **snapshot/restore hardening**, **handoff artifacts**, **`setup` + `models suggest`** (turns 4 manual `models set` commands into one guided pass).
10. **Skill ecosystem P0** (structured gate + single-source text + lifecycle verb merge) then P1 (authoring/publishing).
11. **MCP server / watch / hooks / cron** on top of the SDK.

**Phase 3 (ergonomics + composite commands):**
12. First-run/help fixes, scope-flag reconciliation, shell completion, `manifest`/`schema` commands.
13. Composite commands: `session-start`/`day-start`, `setup wizard`, `memory maintain`, `session report`, `upgrade`, `doctor --fix`, `agents roster/edit/delegate`.

**Key dependencies**: H1's exclusion policy needs H2's secrets path; H4 search should exclude the same machine-local paths; the SDK refactor is a prerequisite for cleanly implementing handoff/session/stats without growing the `src/cli.js` monolith (HIGH-3). Protocol fixes (Phase 0) are prerequisites for any cron/daemon safety, since "nothing to do" must not be a failure and config writes must be locked.

---

## Bottom line

The product already owns the single-machine brain (memory, identity, pointers, skills) and is the best-shaped AI-first CLI of its kind. The missing capabilities are the ones that make a brain **portable** (sync + secrets), **executable** (SPECT tasks, update-apply, handoffs, session lifecycle), **retrievable** (search), and **contractible** (structured actions, exit codes, SDK/MCP). Those four moves — portability, executability, retrieval, contract — are what turn a config manager into an agent-enablement platform, and every one is buildable on primitives that already exist in this codebase.
