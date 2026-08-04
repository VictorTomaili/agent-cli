# A4 — Automation / CI / Agent-Protocol Contract Review: `@tomaili/agent`

**Lens**: machine-callable API. Does the CLI behave as a stable protocol endpoint for scripts, CI pipelines, cron, and AI agents?
**Method**: full read of `src/cli.js`, `src/commands/target.js`, `src/config.js`, `src/skills/cli.js` (+ skill commands), `src/consolidate.js`, `src/snapshot.js`, `src/pointer.js`, `src/seed.js`, `src/npm-check.js`, `src/skill.js`, `src/util.js`, `package.json`; empirical probes (spawned the real CLI against isolated `AGENT_CLI_HOME` homes) covering 40+ invocations: every JSON command, error paths, help/version, idempotency runs, and skill passthrough.
**Scope note**: security/correctness bugs already in `PROJECT-ANALYSIS.md` (CRITICAL-1..3, HIGH-1..6, M1..M10, GAP-1..17) are **not re-reported**; they are referenced only where the automation contract depends on them.

---

## Summary

The tool is genuinely AI-first in intent and mostly delivers: **stdout carries exactly one JSON object for every JSON-capable command**, error paths return parseable JSON with non-zero exits, `link`/`init`/`spect init` are file-idempotent, and `brief` already emits a `suggestedActions` array. But the protocol layer has five systemic gaps:

1. **No contract discipline**: no schema version on any envelope, no documented exit-code taxonomy, inconsistent error envelope shapes (`{ok,error}` vs `{ok,reason}`), and mode-dependent behavior divergence (`identity apply <unknown> --json` silently mutates state while human mode refuses).
2. **Machine-output pollution**: ANSI escape codes leak into JSON `error` strings and into the `skill` passthrough envelope.
3. **False success/failure**: several commands exit 0 when nothing was done (`link --target bogus`, `unlink --target bogus`, `models resolve <missing>`) and exit 1 when there is simply nothing to do (`consolidate` on an empty install). `agent help` and bare `agent` exit 1.
4. **No concurrency story**: zero file locking anywhere; config.json read-modify-write races (CRITICAL-3), non-atomic skill config writes, and unlocked master/snapshot/consolidate sections make parallel agent/CI invocations unsafe.
5. **No higher-level automation surface**: no programmatic API (importing the package executes the CLI), no MCP server, no daemon/watch, no hooks/events, no cron helper, no exit-code contract doc.

---

## 1. Protocol-contract findings (file/line refs)

### 1.1 JSON output: coverage, purity, shape

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| P1 | **ANSI escape codes leak into JSON `error` strings.** `agent target enable bogus --json` returns `{"ok":false,"error":"Unknown target: bogus. Run \u001b[36magent targets\u001b[39m."}` (verified bytes). `fail()` embeds pre-colored messages built with `c.cyan()` at `src/commands/target.js:32`; the JSON emission at `src/cli.js:93-98` never strips codes. Machine consumers must strip ANSI from "structured" output. | `src/commands/target.js:30-36`, `src/cli.js:93-98` | **High** |
| P2 | **Skill passthrough envelope is ANSI-polluted human text, not structured skill data.** `agent skill list --json` returns `output` containing `\u001b[1mskill list\u001b[22m...` (verified). `agent skill cat <missing> --json` returns a correct `{command, passthrough, args, output, error, code, ok}` envelope with exit 1 — good shape, but content is colorized text. No JSON mode exists inside `src/skills/cli.js` at all (text-only `console.log`, `src/skills/cli.js:59-107`). | `src/cli.js:1509-1523`, `src/skills/cli.js` | Medium (envelope exists; content weak) |
| P3 | **`-h`/`--help`/`-v`/`--version` never emit JSON even with `--json`** (verified: `agent -h --json` prints plain usage, exit 0; `agent --version --json` prints `0.2.1`). Undocumented exception to the "stdout is exactly one JSON value" promise; help content also missing from the "every command emits JSON" claim. | `src/cli.js:180, 2111-2114` | Medium (needs documenting or wrapping) |
| P4 | **Error envelope shape is inconsistent.** `fail()` emits `{ok:false, error, ...details}` (`src/cli.js:93-98`); command-level failures emit `{command, ok:false, reason}` (consolidate `src/cli.js:1215-1219`; restore `src/cli.js:1568-1573`; lessons triage `src/cli.js:1129-1134`; update clear `src/cli.js:1354-1358`). Same command diverges: `agent restore --json` (bare, no snapshots) → `{ok:false, error}` **without** a `command` key, while `agent restore nope --json` → `{command, ok:false, reason}`. `target enable` errors → `{ok:false, error, command, action, id}`. A machine client cannot rely on one error schema. | `src/cli.js:93-98, 1215-1219, 1354-1370, 1566-1573`; `src/commands/target.js:31-60` | **High** |
| P5 | **No schema version / API marker anywhere.** No emitted envelope contains `schemaVersion`, `apiVersion`, or a stable `tool` marker except `brief` (`tool:"agent-cli"`, `version` at `src/cli.js:1939-1940`). `brief` has version; `status`/`doctor`/`link` do not. Machine consumers cannot detect breaking changes or validate payloads. | `src/cli.js` all `emit()` calls | **High** |
| P6 | **Inconsistent path rendering across commands.** `status` emits raw absolute `path: MASTER_FILE` (`src/cli.js:468`); `brief` emits both `pretty()` (tilde-shortened) and `absolute` (`src/cli.js:1942-1944`); `link` emits absolute paths with backslashes (`src/cli.js:376`). Same logical value, three conventions. | `src/cli.js:468, 1942-1944` | Low |
| P7 | **Redundant payload noise.** `link` results embed the full `target` object (id, name, docs, global, project, detect) per result (`src/cli.js:376`), inflating payloads. Minor, but indicates no designed schema. | `src/cli.js:370-377` | Low |

**What is solid (verified):** every JSON-capable command emits exactly one JSON value on stdout, nothing else (no trailing human text); non-JSON human output is fully suppressed in JSON mode; JSON errors are parseable with non-zero exits (`target enable bogus`, `user apply` on existing, `restore` no-snapshot, `lessons triage --file 0`, `update clear 9.9.9`, `agents show <missing>` all verified).

### 1.2 Exit codes: taxonomy, false success/failure

Current de-facto taxonomy: `0` success (incl. no-op), `1` any failure (including "nothing to do" and usage/help), `2` doctor-issues. It is **undocumented** (no README/contract doc; package.json `files` references a README.md that does not exist — PROJECT-ANALYSIS L4).

| # | Finding | Evidence | Severity |
|---|---------|----------|---------|
| E1 | **`agent help` exits 1** (verified: exit 1, plain usage on stdout, `(outputHelp)` on stderr). `-h`/`--help` exit 0. The catch at `src/cli.js:2111-2114` whitelists `commander.helpDisplayed`/`commander.version` but **not** `commander.help`, so the `help` subcommand falls into the error branch (`src/cli.js:2115-2122`) and exits 1. Automation probes that run `agent help` to discover the surface get a failure. | `src/cli.js:2108-2126` | **High** |
| E2 | **Bare `agent` exits 1** with usage on **stderr** and empty stdout (verified). `agent --json` bare → `{"ok":false,"error":"(outputHelp)","code":"commander.help"}` exit 1. An agent asked to "use the agent tool" with no args fails instead of learning capabilities; there is no machine-readable manifest endpoint. | `src/cli.js:2108-2126` | **High** |
| E3 | **`identity apply <unknown> --json` and `soul apply <unknown> --json` exit 0 and WRITE the fallback default** (`fallback:true`, `resolved:"general-purpose"`, IDENTITY.md changed — verified). Human mode exits 1 (`src/cli.js:772-776`). JSON mode is silently more permissive and mutates user state that human mode refuses: a script with a typo overwrites identity config with exit 0. | `src/cli.js:770-794` (identity), `831-851` (soul) | **High** |
| E4 | **`models resolve <missing> --json` exits 0 with `resolved:null`** (verified), while `agents show <missing>` exits 1. "Lookup miss" is signaled inconsistently; a machine cannot distinguish "no such alias" from "resolved to null". | `src/cli.js:989-999` vs `654-666` | Medium |
| E5 | **False success in bulk ops (HIGH-2 family):** `link --target bogus --json` and `unlink --target bogus --json` exit 0 with `results: []`; `link` over native content exits 0 with `blocked:"native-content"` (verified) while the single-target `target enable` correctly exits 1 for the same condition (`src/commands/target.js:67-82`). Bulk vs single semantics diverge; already reported as HIGH-2 — cited for the contract, not re-reported. | `src/cli.js:355-389, 397-422`; `src/commands/target.js:67-82` | (HIGH-2) |
| E6 | **False failure: `consolidate` on an empty install.** After a fresh `init`, `agent consolidate --json` exits 1 with `{ok:false, reason:"no lessons dir"}` while `agent consolidate --check --json` exits 0 with `ok:true, score:0` (both verified). A cron/CI "consolidate if needed" loop turns a nothing-to-do state into a failure. | `src/cli.js:1207-1219`, `src/consolidate.js:253` | **High** |
| E7 | **`doctor`'s exit-2 contract is useful but undocumented and unreferenced.** Exit 2 (issues) vs 0 (healthy) verified byte-stable across runs; but `brief` always exits 0 even when issues exist, and `consolidate` fails with 1 — three different signaling styles for "state needs attention". `doctor` also does a network call by default (3s timeout, `src/cli.js:1731`, `src/npm-check.js:17`) — offline CI adds up to 3s and can flip `npm-update` to "unable to check". | `src/cli.js:1774, 1731`, `src/npm-check.js:14-29` | Medium |
| E8 | **`update list`/`brief`/`doctor` write `config.json` as a side effect of a read** (`if (upd.refreshed) await saveConfig(cfg)` at `src/cli.js:1312, 1734, 1795`; mutation in `src/npm-check.js:83-85`). A "list"/"status" command mutating state is surprising, and it makes every first-run-after-cache-expiry a write — increasing contention surface in CI. | `src/cli.js:1312, 1734, 1795`; `src/npm-check.js:83-85` | Medium |

### 1.3 Idempotency (verified empirically)

| Command | Result |
|---------|--------|
| `init` ×3 | Exit 0 each run; non-destructive (master `action` flips `starter`→`exists`, seeds skip existing, identity files `skipped`). Semantically idempotent, not byte-identical: stdout differs and `config.updatedAt` churns every run (PROJECT-ANALYSIS M9). |
| `link` ×2 | Exit 0; second run `unchanged:true`, no file writes. Byte-stable pointer content (compare in `src/pointer.js:200-209`). |
| `unlink` on missing | Exit 0 with `missing:true`. Safe. |
| `spect init` ×2 | Exit 0; second run `skipped`/`preserved`. Safe. |
| `doctor` ×2 | Byte-identical stdout, exit 2 both. Stable. |
| `consolidate --check` | Stable. |
| `snapshot` | Intended non-idempotent (new snapshot per run); `restore` is destructive by design with pre-restore backup (rollback broken — GAP-1). |
| `user apply` | Fails on existing file without `--force`; safe by design. |

Verdict: `init`, `link`, `unlink`, `spect init`, `doctor`, `consolidate --check`, `update list` are safe to run repeatedly. The two non-safe ones are flagged (`user apply` requires `--force`; `restore`/`snapshot` are designed to be stateful). No action needed beyond documenting it — and adding a `changed:boolean` top-level summary so scripts can detect no-ops without counting `results` (currently `init` has `steps.master.changed`, `link` does not).

### 1.4 Concurrency / locking

**There is no locking anywhere in `src/`** (grep confirms zero lock primitives; `proper-lockfile` is not a dependency). Every critical section is an unlocked read-modify-write or read-write sequence:

- `config.json`: atomic temp+rename write (`src/config.js:119-128`) but the read-modify-write cycle has no mutual exclusion → CRITICAL-3 (verified 20/20 concurrent runs lost data). This is the primary blocker for parallel agent/CI `target enable`/`init`/`update list`.
- Skill configs: **not even atomic** — `writeGlobalConfig`/`writeProjectConfig` use plain `fs.writeFileSync` (`src/skills/lib/config.js:88-100, 122-131`); two concurrent `skill enable` runs can interleave partial YAML writes. Distinct surface from CRITICAL-3.
- Master file: `ensureMaster`/`writeMaster` (`src/store.js`) have no lock; two parallel `init` on a fresh home race the starter template.
- `snapshot`/`restore`: no lock; a concurrent snapshot can copy a brain mid-restore.
- `consolidate`: multi-step mutation (deletes + core write + state file, `src/consolidate.js:243-342`, non-transactional per GAP-2) with no lock; two concurrent consolidates double-promote or double-delete.
- npm-cache writes compound the config race: every `doctor`/`brief`/`update list` may write `config.json` (E8).

### 1.5 Machine-actionability

- **`brief` is the best machine surface**: structured `suggestedActions`, `sessionStart.load`, `consolidation`, `update`, `pointerTargets`, `drift` (`src/cli.js:1938-1995`). But `suggestedActions` is a flat array of **human shell strings** (`"agent pull X && agent link X"`, `"npm i -g @tomaili/agent@latest"` — `src/cli.js:1920-1936`), not structured `{command, args, why, priority}`. An agent must parse shell syntax to act, and the compound `&&` strings are not directly executable as a single argv. Contains known bug M7 (`agent link <id>` suggested, but `link` takes `--target`, not a positional).
- `doctor` has structured `checks[]` (`src/cli.js:1592-1760`) but `issues[]` are human strings with commands embedded in prose; no issue codes, no `fix` field, no top-level `nextCommands`.
- No capability/manifest endpoint (E2); no `--quiet`/`--silent`/`--batch` flags and no `NO_COLOR` handling anywhere (verified by grep) — JSON mode is the only batch mode.
- `skillVersion()` spawns a **Node subprocess per diagnostic call** (`src/skill.js:104-116` → `runSkill(["--version"])`), executed by `status`, `doctor`, `brief`, `skill status` — avoidable latency for high-frequency machine polling.
- No watcher, no daemon, no cron helper, no MCP server, no SDK. `package.json` `main`/`exports "."` point at `src/cli.js`, whose top level runs `program.parseAsync(process.argv)` (`src/cli.js:2108`) — **importing the package as a library would parse the host's argv and can exit the host process**; only `@tomaili/agent/targets` is safely importable. There is no programmatic API today.

---

## 2. Prioritized automation improvements

### P0 — must fix for a trustworthy machine contract

1. **Strip ANSI from every JSON payload** (P1, P2): make `emit()`/`fail()` render messages through a plain-strip (or build messages without colors in JSON mode); strip sub-CLI output in the `skill` passthrough envelope (`src/cli.js:1509-1523`). Add a regression test asserting no `\u001b` in any `--json` stdout.
2. **Unify the error envelope** (P4): every failure emits exactly `{ok:false, command, error, code?, details?}`. Keep `reason` as a sub-field of `details`, never a replacement for `error`. Single schema version for errors.
3. **Document + fix the exit-code taxonomy** (E1, E2, E6, E7): publish `0 = ok/no-op`, `2 = actionable state (doctor issues)`, `1 = operational failure`, `3 = usage error`. Fix `agent help` and bare `agent` to exit 0 (and make bare `agent --json` return the manifest, §3). Make `consolidate` on empty exit 0 with `{ok:true, nothingToDo:true}`.
4. **JSON-mode behavior parity** (E3): `identity apply`/`soul apply` with an unknown key must exit non-zero in JSON mode exactly as in human mode, or require an explicit `--fallback` flag. Never let `--json` silently take a state-mutating default the human path refuses.
5. **Schema versioning** (P5): add a top-level `schemaVersion` (or `api:"agent-cli/vX"`) to every envelope, bump on breaking change, additive-only within a major. Start now while the surface is small.

### P1 — high value, low risk

6. **Add locking** (§1.4): one cross-process advisory lock (lockfile + stale detection, e.g. `proper-lockfile`) around every read-modify-write: `saveConfig`, `ensureMaster`/`writeMaster`, skill config writes, `consolidate`, `snapshot`/`restore`, `update stage/clear`. This closes CRITICAL-3, the skill-config race, and the snapshot/consolidate races in one move.
7. **Make read commands pure** (E8): `update list`/`brief`/`doctor` should only write the npm cache when the cached value changes, or move refresh behind `--refresh`; in offline/CI mode (`--offline` or env) skip the network entirely and use the cache.
8. **Add `--quiet`/`--silent` and `NO_COLOR` support**; in JSON mode suppress the leftover stderr from commander (M10) so stderr is empty on success and structured on failure.
9. **Structured `suggestedActions` in `brief`** (A5/M7): emit `{command, args: string[], why, priority, safe}` instead of shell strings; fix the `link <id>` suggestion to `link --target <id>`.
10. **Add `changed`/`nothingToDo` booleans** to `link`/`unlink`/`consolidate` top-level output so scripts can detect no-ops without counting `results` (§1.3).
11. **Native `--json` inside the skill sub-CLI** (P2): structured `list`/`show`/`enable`/`update` output instead of wrapping colorized text; the parent envelope stays as a compatibility layer.
12. **Deterministic paths** (P6): always raw absolute paths in JSON; keep tilde-shortened forms only for human display.

### P2 — polish

13. **`doctor` issue codes + `fix` field** (A5): `{code:"pointer-stale", target:"claude", fix:{command:"link", args:["--target","claude"]}}`.
14. **Drop the subprocess spawn in `skillVersion()`** by reading the integrated version statically (P13, §1.5).
15. **Deterministic ordering/ids**: give checks/issues stable ids; sort `suggestedActions` by priority; add `generatedAt` ISO timestamp to `brief`.

---

## 3. New capabilities (higher-level workflows)

### 3.1 MCP server (`agent mcp`) — highest value
Expose the tool's read/diagnostic surface over stdio MCP: `brief`, `doctor`, `status`, `consolidate_check`, `snapshot`, `snapshots`, `skill_list`, `skill_cat`, `skill_trigger`, `lessons_list`, `lessons_inbox`, `lessons_add`, `models_resolve`, `identity_list`. Tool results = existing JSON envelopes (they already parse). MCP maps naturally onto "suggestedActions as tool calls". Ship with a `--transport stdio|sse` flag and a static manifest. This converts the CLI from "one-shot script" into a resource an agent can interrogate mid-session without paying process startup + subprocess-per-probe cost.

### 3.2 Programmatic API / SDK
Refactor `src/cli.js` so each command is `runCommand(name, argv, opts) -> Promise<{code, json}>` (or reuse the `src/commands/` extraction from HIGH-3). Export it as the package root: `import { agent } from "@tomaili/agent"` with `agent.brief()`, `agent.doctor()`, `agent.link({targets, scope, force})`, `agent.consolidate({dryRun})`, `agent.snapshot()`. CLI stays a thin `argv → runCommand` wrapper. This also enables the daemon/watch and MCP server without subprocess spawns.

### 3.3 Hooks / events
`post-init`, `post-link`, `post-consolidate`, `post-snapshot`, `post-update-staged` hooks: either a `~/.agents/hooks/<event>.sh` convention (spawned with the command's JSON envelope on stdin; non-zero exit recorded as a warning) or `--on-complete <cmd>` flags. For machine-native consumers, prefer emitting an event line (`agent-link:changed` etc.) from the SDK so a watcher/MCP can subscribe.

### 3.4 Daemon / watch
`agent watch` — watch `~/.agents/` and `[cwd]/.agents/` for master/identity/lessons changes; on change, re-classify pointers and emit **NDJSON events** (`{event:"master-changed", before, after}`) for MCP/UI/sidecar integration. `agent daemon` — long-running loop doing scheduled `snapshot` + `consolidate --check` + `doctor`, writing `~/.agents/backups/daemon-state.json`, honoring the exit-code contract.

### 3.5 Cron / scheduling surface
`agent cron install` — write a crontab entry (or Windows Task Scheduler via `schtasks`) running `agent doctor --json` + `agent consolidate --check --json` with contract-respecting exits; `agent cron status|remove`. Key design point: cron is only safe after P0-3 (nothing-to-do must not be a failure) and P1-6 (locking), otherwise two scheduled invocations race.

### 3.6 Exit-code contract doc + JSON schema docs
Add a `docs/contract.md` (and fix the missing README, PROJECT-ANALYSIS L4) specifying: the exit-code taxonomy (§2-3), the envelope schema (`{schemaVersion, tool, command, ...}`), the error envelope, "stdout = exactly one JSON value except `-h`/`-v` which are declared plain-text", path conventions, and the stability policy (additive-only within a major version). This is the single cheapest way to make the tool "safe for agents/CI" in the way the README claims.

### 3.7 Schema versioning
`schemaVersion` on every envelope (§2-5) plus an `agent schema` command that prints the current JSON schemas (`agent schema doctor`, `agent schema envelope`) so generated clients can validate. Add `agent manifest --json` (also served by bare `agent --json`) listing commands, options, and the JSON schema versions they emit — closing E2.

---

## Appendix: empirical probe summary (isolated homes, real CLI)

- Single JSON value on stdout: confirmed for `init, status, link, unlink, targets, target enable/disable (fail+ok), doctor, brief, consolidate --check/--json (fail+ok), update list, update clear, snapshots, snapshot, restore, spect init, edit --print-path, where, files, onboard suggest, models list/set/resolve, agents list/show/new/validate, lessons list/inbox/triage/show, skill status, skill list, skill cat`.
- ANSI in JSON: `target enable bogus`, `skill list` (output field), `skill cat` (error field).
- Exit anomalies: `help`=1, bare `agent`=1, bare `agent --json`=1, `identity apply bogus --json`=0 (writes!), `soul apply bogus --json`=0 (writes!), `models resolve missing --json`=0, `link/unlink --target bogus`=0, `link` over native=0, `consolidate` empty=1.
- Idempotency: `init`×3 ok (updatedAt churn), `link`×2 unchanged, `spect init`×2 preserved, `doctor`×2 byte-identical.
