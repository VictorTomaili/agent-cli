# agent-cli — Machine Contract

This document is the canonical contract for programmatic use of `agent` (the
`@tomaili/agent` CLI). Version 2 of the contract shipped with the 1.0.0 major
release (clean break from the pre-1.0 ad-hoc payloads).

---

## 1. JSON envelope

Every `--json` invocation writes **exactly one JSON value** to stdout with this
shape:

```json
{
  "ok": true,
  "command": "status",
  "apiVersion": "2.0.0",
  "data": { }
}
```

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | `true` = the command ran successfully; `false` = it failed (`error` present). |
| `command` | string | The command/action that produced this payload (e.g. `brief`, `doctor`, `link`). |
| `apiVersion` | string | Protocol version of this envelope. Bumped only on breaking contract changes. |
| `data` | object | The command-specific payload. Shape varies per command. |
| `error` | string | Present **only** when `ok` is `false`; a human-readable reason. |

Notes:

- **ANSI is stripped from every `--json` payload.** No `\u001b` escape sequences
  appear anywhere in stdout. Consumers may parse blindly.
- `--json=compact` (alias for `--json --compact`) emits the same value on a
  single line with no whitespace.
- Human (non-JSON) output goes to stdout and is guarded so it never mixes with
  a JSON value; `--quiet`/`--silent` suppress informational output (errors
  still print). `NO_COLOR=1` (picocolors) disables color in human output.
- In JSON mode the only stdout value is the envelope; diagnostics go to stderr.

### Failure examples

```json
{ "ok": false, "command": "models", "apiVersion": "2.0.0",
  "data": { "action": "resolve", "alias": "nope" },
  "error": "No such model alias: 'nope'" }
```

Commands that internally signal `ok:false` (e.g. `update clear`, `restore`,
`consolidate` on a real failure) are emitted as failure envelopes with the
reason surfaced in top-level `error`.

---

## 2. Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, or an intentional no-op (`nothingToDo:true`). |
| `1` | Error, usage error, or failure. |
| `2` | Actionable work is available — `doctor` with issues, `brief --check` with suggestions. |
| `3` | Partially applied (reserved for future `--apply-*` commands). |

Subprocess codes (e.g. `agent skill <sub>`) are forwarded as-is.

Cron/monitor loops MUST treat exit `0` with `nothingToDo:true` as success, not
a failure. `brief --check` and `doctor` are the recommended probes:

```sh
agent brief --check --offline --json   # exit 2 when work exists, 0 otherwise
agent doctor --json                    # exit 2 when issues exist
```

---

## 3. Read-only commands and the network

`brief`, `doctor`, and `update list` are **observational by default**: they
never hit the network and never write `config.json` unless you opt in.

| Flag | Effect |
|---|---|
| `--refresh` | Force a fresh npm registry check; writes the `updateCheck` cache into `config.json`. |
| `--offline` / `--no-network` | Never hit the network; use the cached check only (stale or unknown). |
| env `AGENT_OFFLINE=1` | Same as `--offline` for every command. |
| `--force` (on `doctor`/`update list`) | Alias for `--refresh`. |

`doctor`'s `--force`/`--refresh` and `brief --refresh` are the only paths that
mutate `config.json` (the `updateCheck` cache). Everything else is pure.

---

## 4. Versioning policy

- `apiVersion` (`2.0.0`) is bumped only when the envelope or a documented
  payload shape changes incompatibly.
- `schemaVersion` inside `brief.data` tracks the session-brief payload shape
  independently of `apiVersion` (bumped when new brief fields are added).
- `agent schema [command]` prints the current envelope contract and one
  command's option surface; `agent manifest --json` lists every command.
- New commands/options are additive and do not bump `apiVersion`.

---

## 5. Scope flags

- Root commands default to the **global** scope (`~/.agents`); `-p/--project`
  selects the project master (`[cwd]/.agents/AGENTS.md`).
- `-g` and `-p` are mutually exclusive on a given invocation.
- `where -p` reports the project master (`[cwd]/.agents/AGENTS.md`);
  `where` (global) reports the global master at `~/AGENTS.md` (the
  `~/.agents/AGENTS.md` file is now agent-cli's self-pointer stub that
  redirects to it).

---

## 6. No-op detection

`link`, `unlink`, and `consolidate` emit `changed` and `nothingToDo` booleans so
scripts can detect a no-op without counting `results`:

- `link`: `changed` = any pointer written; `nothingToDo` = no pointer needed writing.
- `unlink`: `changed` = any stub removed; `nothingToDo` = none removed.
- `consolidate`: `nothingToDo:true` when there is no lessons dir or nothing to
  promote/prune/mark.
