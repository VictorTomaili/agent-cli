# SPEC-006: Phase 6 — MCP first-class

Status: **accepted** (all 9 user-decision items resolved 2026-08-24; plan ready for
v0.8.0 implementation. Sign-off record at `.spec/plans/phase-6/USER-DECISIONS.md`.)

> **Companion documents:**
> - Full plan: `.spec/plans/phase-6/MASTER-PLAN.md` (706+ lines, 24 tasks, 19 audit checks)
> - Team meeting minutes: `.spec/plans/phase-6/meeting/MINUTES.md` (held 2026-08-24)
> - Strategic context: `.spec/ROADMAP.md` §4 (Phase 6 status: approved, ready to start)
> - Starting instructions: `.spec/plans/phase-6/STARTING-INSTRUCTIONS.md` (also §14 of MASTER-PLAN.md)
> - User sign-off record: `.spec/plans/phase-6/USER-DECISIONS.md`
>
> **Planning cycle:** 2 planning rounds + 1 team meeting (2 rounds) via pi sub-agent dispatch.
> 20 sub-agent invocations, all exit 0. 5 distinct model families. See MASTER-PLAN.md §13.
> **No implementation work dispatched yet** per user instruction.

---

## Problem

`agent-cli serve` is currently a read-only JSON-RPC stdio bridge (6 tools: `brief`,
`doctor`, `search`, `snapshot`, `status`, `spect_status`). Hosts that want to do anything
more than inspect state must shell out to the CLI, breaking the protocol parity the
dev-team skill (v0.7.0) and the contract spec (`docs/contract.md`) just established.

The roadmap points to MCP first-class as Phase 6 (§4 of `.spec/ROADMAP.md`). Without MCP
parity, every release after v0.7.0 either grows the CLI vs. MCP gap or duplicates logic
across two surfaces.

## Goals

- **G1.** Make `agent-cli serve` the equal of the CLI for every supported MCP host. MCP
  stops being the read-only side door and becomes the canonical machine surface.
- **G2.** Ship resources (read-side, 11 canonical URIs) + prompts (3 canonical prompts) +
  write-capable tools (8 tools) in two releases (v0.8.0 / v0.8.1).
- **G3.** Preserve the four "do not weaken" invariants in `ARCHITECTURE.md` and add
  invariant #5 (cross-process operation lock).
- **G4.** Hand the user a sign-off surface that fits in 9 single-item decisions (down
  from 13 in the pre-meeting plan).

## Non-goals

- **NG1.** Plugins for third-party targets/skills/runners (Phase 8).
- **NG2.** Telemetry / observability (Phase 10).
- **NG3.** Documentation site / Mintlify / Docusaurus (potential Phase 13).
- **NG4.** Web UI / chat surface (per roadmap §11 anti-goals).
- **NG5.** MCP `restore` ships in v0.8.1 — **deferred to v0.8.2** per team meeting C1.
- **NG6.** `AGENTS.md` exposed as a `brain_write` target — **omitted** per team decision A2.
- **NG7.** Host-supplied `cwd`, project root, master path, or destination path (per A17).

---

## Scenarios and acceptance criteria

### SCN-001: MCP host reads SOUL.md via resource

Given `agent-cli serve` is launched and the host calls `initialize` + `resources/read`
with `uri: "brain://files/SOUL.md"`,

When the resource is read,

Then the response is `{ contents: [{ uri: "brain://files/SOUL.md", mimeType:
"application/json", text: "<JSON>" }] }` where `JSON.parse(text)` has `{ schemaVersion,
lastModified, size, content, exists }`.

- **REQ-001.1:** `resources/list` returns the 11 canonical URIs. (T6.1.2)
  - Verification: `test/serve.test.js: resources/list returns the canonical URIs`.
- **REQ-001.2:** `resources/read` for `brain://files/SOUL.md` returns
  `{ contents: [{ uri, mimeType, text }] }`. (T6.1.2)
  - Verification: `test/serve.test.js: resources/read brain://files/SOUL.md returns contents with metadata`.
- **REQ-001.3:** Missing file → `{ exists:false, content:null, size:null, lastModified:null }`,
  not an error. (T6.1.1)
  - Verification: `test/serve.test.js: resources/read a missing brain file reports exists:false`.
- **REQ-001.4:** Symlinked `SOUL.md` → `{ exists:false, symlink:true, content:null }`,
  no read through the link. (T6.1.1 + A7/R4)
  - Verification: `test/serve.test.js: brain://files/SOUL.md on symlinked path returns exists:false symlink:true`.
- **REQ-001.5:** Content size capped at 64 KiB; `truncated: true` beyond. (T6.1.6)
  - Verification: `test/serve.test.js: resource payload truncated at 64 KiB`.

### SCN-002: MCP host subscribes to `brain://brief`

Given the host sends `resources/subscribe` with `uri: "brain://brief"`,

When the host sends another JSON-RPC message after a brain state change,

Then the host receives `notifications/resources/updated` with `{ uri: "brain://brief" }`
exactly once per change. No timers, no watchers.

- **REQ-002.1:** Subscribe restricted to `brain://brief` + `brain://session/current`. (T6.1.2)
  - Verification: `test/serve.test.js: resources/subscribe to brain://targets returns -32602`.
- **REQ-002.2:** Non-subscribable URIs rejected with `-32602`. (T6.1.2)
  - Message: `"unknown resource: <uri>"` (invalid URI) or
    `"resource does not support subscribe: <uri>"` (valid URI, not subscribable).
  - Data: `{ uri, subscribable: ["brain://brief", "brain://session/current"] }`.
  - Verification: `test/serve.test.js: subscribe rejection shape`.
- **REQ-002.3:** Subscribe + state change + inbound message → exactly one update. (T6.1.2 + A18)
  - Verification: `test/serve-stdio.test.js: subscribe emits one update per state change`.
- **REQ-002.4:** Delivery contract documented in `docs/contract.md`. (release-time docs)
  - Verification: `test/contract.test.js: contract.md contains MCP extensions section`.

### SCN-003: MCP host calls `brain_write` after `initialize`

Given the host has sent `initialize` with
`capabilities.experimental.agentCli.writeTools: true`,

When the host calls `tools/call` with `name: "brain_write"` and `{ kind: "SOUL", content:
"..." }`,

Then the brain file is written atomically, the host receives the CLI envelope shape, and
the next `resources/read` of `brain://files/SOUL.md` reflects the new content.

- **REQ-003.1:** Pre-`initialize` write calls refused with structured error, no filesystem
  change. (T6.2.5 + A19)
  - Verification: `test/mcp-write.test.js: pre-initialize write refusal`.
- **REQ-003.2:** `initialize` response carries `capabilities.experimental.agentCli.writeTools`
  as a **separate** constant (not merged with read-side capabilities). (T6.0.1 + A16)
  - Verification: `test/serve.test.js: initialize advertises MCP capabilities`.
- **REQ-003.3:** `brain_write` accepts exactly the six kinds: SOUL, IDENTITY, USER,
  LESSONS, ENVIRONMENTS, MODELS. `AGENTS.md` rejected. **`scope` matrix enforced:**
  IDENTITY/USER/MODELS reject `scope: "project"` with a structured error;
  SOUL/LESSONS/ENVIRONMENTS accept `scope: "project"` and resolve to the server's
  launch-directory `cwd/.agents/<kind>.md`. The server's `cwd` is the trust boundary;
  no host-supplied cwd/project-root/path. (T6.2.2, A17)
  - Verification: `test/mcp-write.test.js: brain_write accepts 6 kinds rejects AGENTS.md`;
    `test/mcp-write.test.js: brain_write scope matrix`.
- **REQ-003.4:** `brain_write` writes via `util.writeFile` (atomic). (T6.2.2 + invariant #1)
  - Verification: `test/mcp-write.test.js: brain_write uses util.writeFile`.
- **REQ-003.5:** `brain_write` returns CLI envelope shape. (T6.2.0 + T6.2.2)
  - Verification: `test/mcp-write.test.js: brain_write returns contract envelope`.

### SCN-004: MCP host calls `lesson_consolidate` with `applyChanges: false`

Given the host has sent `initialize` with the write capability,

When the host calls `tools/call` with `name: "lesson_consolidate"` and `{ applyChanges:
false }`,

Then the host receives the planned changes in `data.changes[]` and `data.stats`, no
filesystem mutation occurs.

- **REQ-004.1:** `applyChanges: false` (or missing/non-boolean) = dry-run; only exact
  boolean `true` = apply. (T6.2.5 + A11-w)
  - Verification: `test/mcp-write.test.js: lesson_consolidate defaults to dry run`.
- **REQ-004.2:** Dry-run captures full lesson-dir snapshot before any mutation. (T6.2.4b + P0-5)
  - Verification: `test/consolidate.test.js: dry-run preserves transactional snapshot`.
- **REQ-004.3:** `consolidate.js` writes use `util.writeFileSync` (atomic), not raw
  `fs.writeFileSync`. (T6.2.4b + invariant #1)
  - Verification: `test/mcp-concurrency.test.js: consolidate uses util.writeFileSync`.

### SCN-005: Two concurrent `target_enable` calls on the same target

Given two MCP hosts (or one host, two connections) call `target_enable` for the same
target id simultaneously,

When both calls complete,

Then one reports `enabled: true`, the other reports `unchanged: true`; config has the
target enabled exactly once.

- **REQ-005.1:** Concurrent `target_enable` uses `atomicEnableGlobal` (or
  `atomicEnableProjectTarget`), not `loadConfig`+`saveConfig`. (T6.2.2 + A6)
  - Verification: `test/mcp-concurrency.test.js: target_enable concurrent CAS`.
- **REQ-005.2:** Cross-process lock (`config.js` CAS) serializes config mutations. (invariant #2)
  - Verification: `test/config.test.js` (existing) + `test/mcp-concurrency.test.js`.

### SCN-006: MCP host tries `restore` in v0.8.1 (should fail)

Given the host has sent `initialize` with the write capability,

When the host calls `tools/call` with `name: "restore"`,

Then the host receives a structured "tool not available in v0.8.1" refusal; `restore` is
deferred to v0.8.2 per team meeting C1.

- **REQ-006.1:** `restore` is **not listed** in `tools/list` for v0.8.1. (T6.2.5 + meeting C1)
  - Verification: `test/serve.test.js: tools/list excludes restore in v0.8.1`.
- **REQ-006.2:** `restore` ships only when T6.2.4a lands with all of: atomic-rename
  primitives, validated symlink-safe traversal, recursive secret exclusion, staging,
  verified pre-restore backup, shared conflict locking. (T6.2.4a + meeting C1)
  - Verification: `test/mcp-write.test.js: restore blocked until snapshot refactor verified`
    (regression guard until v0.8.2).

### SCN-007: Two concurrent compound mutations (brain_write + consolidate)

Given a `lesson_consolidate` is running with `applyChanges: true` while a host calls
`brain_write` with `kind: "LESSONS"`,

When both calls proceed,

Then one waits for the other up to the lock timeout (default: implementation-defined,
recommend 5s); the loser either acquires the lock after the winner releases, or returns
a structured "operation busy" refusal.

- **REQ-007.1:** Operation lock has a defined conflict matrix; `consolidate` conflicts
  with `brain_write` for the LESSONS kind. (T6.0.4 + T6.0.2 + meeting C3)
  - Conflict matrix:
    ```
    snapshot    conflicts with: brain_write (all kinds), lesson_capture, lesson_consolidate, restore
    consolidate conflicts with: lesson_capture, brain_write (LESSONS kind)
    config      already handled by config.js CAS
    ```
  - Verification: `test/mcp-concurrency.test.js: consolidate vs brain_write LESSONS` +
    `test/operation-lock.test.js` (new).
- **REQ-007.2:** Lock acquisition bounded with structured refusal on timeout. (T6.0.2 +
  invariant #5)
  - Verification: `test/mcp-concurrency.test.js: lock timeout refusal`.
- **REQ-007.3:** Stale lock (process killed mid-operation) detected via pid-alive check. (T6.0.2)
  - Verification: `test/operation-lock.test.js: stale lock recovery`.
- **REQ-007.4:** No public MCP force-release tool; CLI-only `lock-release` is v0.9.0. (meeting D2)
  - Verification: `test/serve.test.js: no force_unlock in tools/list`.

---

## Constraints

- **C1.** ESM, Node.js >= 22, zero build step, no new dependencies.
- **C2.** `src/cli.js` is the only file that imports every command module. `src/commands/*`
  may import from `src/*.js` (lib); lib modules must not import from `src/commands/*`.
  `src/api/index.js` is a read/write SDK over lib; `src/serve.js` is the one lib file
  allowed to consume it. `src/skills/**` is self-contained — only `src/skill.js` and
  `src/blocks.js` bridge into it. Enforced by `test/import-boundaries.test.js`.
- **C3.** All five "do not weaken" invariants in `ARCHITECTURE.md` (the four existing +
  the new #5 cross-process operation lock).
- **C4.** `docs/contract.md`'s envelope shape unchanged; new fields are additive; `apiVersion`
  bumps on breaking changes only.
- **C5.** MCP transport: JSON-RPC 2.0 over stdio, zero-dependency server in `src/serve.js`.
- **C6.** All MCP arguments untrusted; hosts are not authenticated; `initialize` is protocol
  order, not authorization.
- **C7.** Capability declaration: `initialize.params.capabilities.experimental.agentCli.writeTools === true`
  (exact boolean; truthy strings fail closed).
- **C8.** No `edit`/`write` outside `src/` and `test/` for implementation tasks; docs land on
  release commits per meeting A6.

## Interfaces and data

### New files

| Path | Owner | Produces |
|---|---|---|
| `src/serve/registry.js` | dev-1 | `READ_CAPABILITIES`, `WRITE_CAPABILITY` (separate constants), `RESOURCE_DESCRIPTORS`, `PROMPT_DESCRIPTORS`, `SUBSCRIBABLE`, `WRITE_TOOLS` |
| `src/api/write.js` | dev-2 | `brainWrite`, `lessonCapture`, `lessonConsolidate`, `targetEnable`, `targetDisable`, `link`, `unlink`, `memoryUpgradePrepare`, `memoryUpgradeApply`, `snapshotNow` |
| `src/api/envelope.js` | dev-2 | `ok(command, data, opts)`, `err(command, error)` |
| `src/operation-lock.js` | dev-2 | `withOperationLock(name, fn, { timeoutMs })` + conflict-matrix comment |

### Modified files

| Path | Owner | Change |
|---|---|---|
| `src/serve.js` | dev-1 / dev-2 | resources + prompts + write tools + subscriptions + capability binding + `serverInitialized` flag |
| `src/api/index.js` | dev-1 / dev-2 | read SDK growth (`brainFile` with symlink refusal, `targets`, `lessonsCore`, `sessionCurrent`, `skillsList`, `skillManifest`, prompt helpers) + re-export from `./write.js` |
| `src/lessons-lib.js` | dev-1 | `readCoreLessons({ cwd })` |
| `src/skill.js` | dev-1 | `listInstalledSkills`, `getInstalledSkill` |
| `src/actions.js` | dev-1 | replace inline core-extraction with `readCoreLessons` (-10 lines) |
| `src/snapshot.js` | dev-2 | refactor to atomic-rename + `withOperationLock('snapshot', …)` + symlink-safe traversal + recursive secret exclusion |
| `src/consolidate.js` | dev-2 | refactor to `util.writeFileSync` + `withOperationLock('consolidate', …)` + sanitized errors |

### New test files

| Path | Owner | Covers |
|---|---|---|
| `test/serve-stdio.test.js` | dev-1 + qa | spawned `agent-cli serve` over stdio; init handshake; capability negotiation; subscribe notifications; prompt text parity against real CLI output |
| `test/api-write.test.js` | dev-2 | every function in `src/api/write.js`; envelope shape; `applyChanges` semantics |
| `test/mcp-write.test.js` | dev-2 + qa + sec | write tools; capability binding; pre-init refusal (A19); closed enum `{ kind, scope }`; A1-w, A2, A4–A12, A16, A17 |
| `test/mcp-concurrency.test.js` | dev-2 + qa | spawned `agent-cli serve` children; barrier-synced parallel legs; 5 race scenarios (R1-R5 from qa-agent §3) |
| `test/mcp-security.test.js` | sec + dev-2 | hostile-host assumptions; symlink/path/secret coverage; A3, A7, A8, A9, A15, A18 |
| `test/operation-lock.test.js` | dev-2 + qa | `withOperationLock` semantics; conflict matrix; pid-alive stale lock recovery; bounded timeout refusal |

### Modified test files

- `test/serve.test.js` — extend with `initialize`, `resources/list`/`read`/`subscribe`, `prompts/list`/`get`; pre-init write refusal; `applyChanges` opt-in; symlink refusal; subscribe scope restriction.
- `test/api.test.js` — extend with new read SDK exports + `lstat` symlink refusal + content size cap.
- `test/contract.test.js` — extend with envelope parity + **pinned canonical Phase 6 resource/tool/prompt set** (per qa-agent M11).
- `test/import-boundaries.test.js` — extend with zero-import guard for `src/serve/registry.js` (per meeting D5).
- `test/security-fixes.test.js` — extend with A10 backup preservation; A9 pointer-only deletion.

### Modified docs (release-time commits, per meeting A6)

- `docs/contract.md` — MCP extensions section (v0.8.0). Owner: devops + cto review.
- `README.md` — MCP section pointing hosts at `agent-cli serve` (v0.8.0). Owner: devops.
- `ARCHITECTURE.md` — serve.js paragraph + new invariant #5 (v0.8.1). Owner: cto.

---

## Open questions

> **Status (2026-08-24):** all 9 user-decision items resolved same day. Full record at
> `.spec/plans/phase-6/USER-DECISIONS.md`. Summary at `.spec/ROADMAP.md` §12.1.
>
> **No blocking open questions remain.** Implementation work can begin when the user
> gives the go-ahead to dispatch agents per `.spec/plans/phase-6/STARTING-INSTRUCTIONS.md`.

**Implementation decisions deferred** (active, not blocking):
- Lock timeout default — recommended 5 seconds; cto-agent + dev-agent-2 decide when
  implementing T6.0.2.
- v0.8.1 write-tool inventory — 8 tools confirmed; `restore` deferred to v0.8.2;
  `snapshot_now` ships only if T6.2.4a lands with all six conditions;
  `lesson_consolidate` ships only if T6.2.4b lands with all six conditions.

**Open follow-up** (flagged by the orchestrator after Item 1 resolution):
The v0.8.0 read-side URIs (`brain://files/SOUL.md` etc.) are global-only. The matrix
decision enables project-scoped *writes* for SOUL/LESSONS/ENVIRONMENTS, but the
matching project-scoped *reads* are not yet exposed. Flagged for dev-agent-1 to
document the asymmetry in the T6.1.2 commit message and open a follow-up issue for
a `?scope=project` query param or project-scoped URIs in a later release.

---

## Cross-references

- `.spec/ROADMAP.md` §4 — strategic context
- `.spec/ROADMAP.md` §12.1 — user-decision items
- `.spec/plans/phase-6/MASTER-PLAN.md` — full plan (706 lines)
- `.spec/plans/phase-6/meeting/MINUTES.md` — meeting resolutions
- `.spec/plans/phase-6/context.md` — shared planning context anchor
- `ARCHITECTURE.md` — "do not weaken" invariants
- `docs/contract.md` — JSON envelope + exit codes + idempotency contract

---

_Spec accepted 2026-08-24 after user sign-off on all 9 open questions. Status
transitions: `accepted` → `in-progress` when v0.8.0 work begins → `shipped` when
v0.8.0 + v0.8.1 both land and the audit gate clears._
