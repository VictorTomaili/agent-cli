# agent-cli contract — the machine-readable surface

This document is the formal specification for the parts of `agent-cli` that
an AI agent (or any other programmatic consumer) can rely on. It is the source
of truth; the README, the `instructions` command, the `prompt` command, and
every `--help` text all defer to this spec.

If anything here disagrees with what the CLI actually does, **the CLI wins**
and this document is the bug. Open an issue.

## The JSON envelope

Every command that supports `--json` emits **exactly one** JSON object on
stdout, terminated by a newline. The shape is versioned via `apiVersion`:

```json
{
  "ok": true,
  "command": "<command-name>",
  "apiVersion": "2.0.0",
  "data": { ...command-specific... },
  "error": "optional, present only when ok=false",
  "updateNotice": "optional, present only when installed < latest"
}
```

### Field guarantees

| Field | Type | When present | Notes |
| --- | --- | --- | --- |
| `ok` | `boolean` | always | `false` iff `error` is set |
| `command` | `string` | always | The command that emitted the envelope, e.g. `"brief"`, `"doctor"`, `"link"` |
| `apiVersion` | `string` | always | `"2.0.0"`. Bumps on **breaking** changes to the envelope shape |
| `data` | `object` | always | Command-specific payload. Shape varies per command |
| `error` | `string` | only when `ok=false` | Human-readable failure reason. The `data` field still carries partial results when applicable |
| `updateNotice` | `object` | only when newer version exists | `{ latest, installed, message, reason, checkedAt }` |

### `apiVersion` policy

- **MAJOR** bump (1.x → 2.x): a field was removed, a field's type changed, or the
  shape's semantics changed (e.g. a previously-optional field becomes required).
- **MINOR** bump (x.1 → x.2): a new optional field was added. Consumers
  pattern-matching on a known set of fields keep working.
- **PATCH** bump: documentation / clarification, no shape change.

Consumers SHOULD ignore unknown fields. Consumers SHOULD branch on `ok`
rather than try/catch on field presence.

### `updateNotice` shape

```json
{
  "latest": "1.2.3",
  "installed": "1.0.0",
  "message": "agent-cli 1.2.3 available — run: npm i -g @victortomaili/agent-cli@latest  (current 1.0.0)",
  "reason": "cached" | "fresh" | "offline" | "network-failed" | "opt-out",
  "checkedAt": "2026-08-24T12:34:56.789Z"
}
```

- `reason` values:
  - `cached`: read from the daily cache in `config.json`; no network hit
  - `fresh`: just hit the registry; cache updated
  - `offline`: `--offline` / `AGENT_OFFLINE=1`; cache only
  - `network-failed`: registry unreachable; fall back to stale cache if any
  - `opt-out`: user disabled the check (`--no-update-check`, `AGENT_CLI_NO_UPDATE_CHECK=1`)

## Exit codes

| Code | Constant | Meaning |
| --- | --- | --- |
| `0` | `OK` | Success, or intentional no-op (e.g. `unlink` on a missing target) |
| `1` | `ERROR` | Error, usage failure, or anything that prevents the command from completing |
| `3` | `PARTIAL` | Some operations succeeded and some failed (e.g. `link agents` succeeded for 4 of 5 targets; see `data.results[]`) |

> Note: `EXIT.WORK = 2` is reserved by `brief --check` and `doctor` for
> "actionable work available" semantics. Most commands exit `0` on success
> regardless of whether work was found.

### Exit code rules

- `0` ≠ "nothing happened" — `unlink --target missing` returns `0` with
  `{ skipped: "unsupported" }` in the envelope. Success includes intentional
  no-ops.
- Exit codes are stable; do NOT use the code itself to branch on the outcome.
  Read `ok` in the envelope first, then inspect `data`.
- `process.exit(1)` is reserved for fatal/non-recoverable errors. All
  command-defined failures emit an `ok:false` envelope and `process.exit(0)`
  unless the error happens before the action handler runs (parse error,
  unknown command, etc.).

## Idempotency

Every command in `agent-cli` is **idempotent** — running it twice produces
the same end state as running it once, and the second run returns the
appropriate `unchanged` / `skipped` / `missing` flags in the envelope rather
than corrupting state.

Specifically:

- `agent-cli init` — running on an already-initialized home repairs
  anything missing without disturbing the user's edited master content.
- `agent-cli link` — re-running on a target whose stub already matches the
  current pointer state returns `{ linked: true, unchanged: true }` without
  touching disk.
- `agent-cli target enable/disable` — calling `enable` on an already-enabled
  target is a no-op (`unchanged: true`).
- `agent-cli skill install/enable` — re-installing the same source is a no-op.

Use `unchanged: true` as your "did this command actually do anything"
signal in the envelope.

## Ordering and atomicity guarantees

- **Atomic writes**: every file the CLI writes goes through `util.writeFile`,
  which uses exclusive-create + fsync + rename-over-existing. A reader never
  sees a partial file. POSIX and Windows are both supported.
- **Locked config writes**: `~/.agents/config.json` is read-merge-written
  through a cross-process file lock (`config.js`). Two concurrent `agent-cli`
  invocations cannot lose each other's writes to `global`, `models`,
  `runners`, etc.
- **Schema-version marker**: `~/.agents/.schema-version` is read+written
  atomically. The `memory upgrade plan`/`apply` commands bump it; the
  ordering of migrations is monotonic (you can never accidentally skip a
  migration by jumping the marker past it).
- **Backup-first writes**: `link --force` and `memory upgrade prepare` back
  up the user's existing content to a timestamped `.agent-cli-backup-<iso>`
  file BEFORE overwriting. The backup path is surfaced in the envelope's
  `backup` field. The user can always recover.

## Error taxonomy

Errors emitted by `agent-cli` follow a vocabulary that lets consumers
classify failures. The envelope's `error` field is a human-readable string;
consumers should pattern-match on substrings when classifying:

| Substring | Category | Suggested next action |
| --- | --- | --- |
| `Unknown command` | usage | `agent-cli --help` / `agent-cli instructions` |
| `corrupt` | state | `agent-cli doctor --fix-safe` |
| `native-content` | user-owned | `agent-cli pull <id>` then retry |
| `already applied` / `already installed` | idempotent-noop | none — re-run is harmless |
| `not yet applicable` | preconditions | `agent-cli memory upgrade plan --json` |
| `network` / `timeout` / `ECONNREFUSED` | transient | retry with `--offline` to use cache |
| `Permission denied` / `EACCES` | environment | fix filesystem perms; on Windows, run as admin for junction ops |
| `Module not found` (during script runs) | build/dev | `npm install` |

## Command manifest

`agent-cli --json manifest` emits the complete command tree, options, and
exit-code enum. **Always** call this first when wiring a new agent — it's
the canonical machine-readable surface for "what commands exist":

```bash
$ agent-cli --json manifest | jq '.commands[].name'
```

The manifest's exit-code field is the same `EXIT` enum documented above.

## Schema-driven validation

For any specific command's `data` shape:

```bash
$ agent-cli schema <command>  # JSON Schema for the data field
```

Use this when you need to validate the shape programmatically before consuming
it. Schemas are generated from the runtime, not maintained by hand.

## Cross-process behavior

- **Env overrides**: `AGENT_CLI_HOME` (override HOME), `AGENT_OFFLINE=1`
  (skip network), `AGENT_CLI_NO_UPDATE_CHECK=1` (skip npm-version check),
  `DSH_HOME` (deepseek target — currently unused, see target).
- **MCP server**: `agent-cli serve` exposes a JSON-RPC 2.0 stdio MCP server
  wrapping the SDK (`src/api/index.js`). For the full `initialize`
  capabilities, resources, prompts, and tools, see **MCP surface** below.
- **File watching**: `agent-cli watch` polls configured paths and emits
  `agent-cli --json` envelopes on change.

## MCP surface

`agent-cli serve` is a minimal Model Context Protocol (MCP) server over stdio:
JSON-RPC 2.0, newline-delimited on stdin/stdout, no dependencies. It wraps the
SDK (`src/api/index.js`) so an MCP host (Claude Desktop, VS Code, Cursor, etc.)
can call the CLI's read tools and read/subscribe to resources without shelling
out. `SERVER_NAME` is `agent-cli`, `SERVER_VERSION` is `2.0.0`, and
`PROTOCOL_VERSION` is `2025-06-18`. The surface is versioned: v0.8.0 is
read-only; writes arrive in v0.8.1 (see the capability gating below).

### `initialize` capabilities

The `initialize` response advertises the server's capabilities. v0.8.0 is
read-only and always sends `READ_CAPABILITIES`:

```json
{
  "capabilities": {
    "tools": { "listChanged": false },
    "resources": { "subscribe": true }
  }
}
```

- `tools.listChanged: false` — the tool list is static per connection; the
  server never changes it mid-session.
- `resources.subscribe: true` — the server supports `resources/subscribe` for
  the two subscribable URIs below.

v0.8.1 introduces writes, and the write capability is **opt-in** (A16): the
server adds `WRITE_CAPABILITY` to the response only when the client offers it
during `initialize` by setting `capabilities.experimental.agentCli.writeTools`
to the exact boolean `true` (truthy strings fail closed):

```json
{
  "capabilities": {
    "experimental": { "agentCli": { "writeTools": true } }
  }
}
```

So the v0.8.0 server never advertises a write surface it does not ship, and a
v0.8.1 server never silently drops the declaration.

### `resources/list`

`resources/list` returns 11 resource descriptors — 10 concrete URIs plus one
RFC 6570 URI template. All payloads are `application/json`:

| URI | name | kind |
| --- | --- | --- |
| `brain://files/SOUL.md` | Soul profile | soul |
| `brain://files/IDENTITY.md` | Identity | identity |
| `brain://files/USER.md` | User profile | user |
| `brain://files/LESSONS.md` | Lessons | lessons |
| `brain://files/ENVIRONMENTS.md` | Environments | environments |
| `brain://files/MODELS.md` | Models | models |
| `brain://skills/{name}` | Skill manifest | skill |
| `brain://targets` | Enabled targets | targets |
| `brain://lessons/inbox` | Lessons inbox | lessons-inbox |
| `brain://lessons/core` | Lessons core | lessons-core |
| `brain://session/current` | Current session | session |

`brain://skills/{name}` is the URI template; the `{name}` placeholder resolves
at read time to an installed-skill name. `brain://brief` is deliberately
**absent** from this list — it is subscribe-only (see below) and no
`resources/read brain://brief` ever succeeds.

### `resources/read` payload contract

`resources/read` returns the metadata-shaped payload contract (A3):

```json
{
  "uri": "brain://files/SOUL.md",
  "kind": "soul",
  "scope": "global",
  "schemaVersion": "1.2.0",
  "lastModified": "2026-08-24T12:34:56.789Z",
  "size": 4200,
  "content": "# SOUL ...",
  "exists": true,
  "symlink": false
}
```

Contractual guarantees:

- `schemaVersion`, `lastModified`, `size`, `content`, `exists` are the stable
  A3 fields consumers rely on. `uri`, `kind`, `scope`, and `symlink` are also
  always present.
- `exists: false` (file missing) or `symlink: true` (path is a symlink or
  junction, refused per A8 so a symlinked file cannot leak
  `~/.agents/secrets/*`) → the `content` field is **omitted**. Never treat a
  missing or symlinked resource as having content.
- Content respects a **64 KiB cap** (T6.1.6): if the on-disk file exceeds it,
  `content` is truncated and the payload adds `{ truncated: true,
  originalSize }` so the host can detect truncation and re-fetch the full file
  via the CLI. `size` always reports the on-disk file size, not the truncated
  payload.
- v0.8.0 exposes resources under the `global` scope; project-scoped reads are
  not wired (a Phase 6 follow-up).

### `resources/subscribe` (A18)

`resources/subscribe` accepts exactly two URIs:

- `brain://brief` — subscribe-only; **not** readable via `resources/read`
- `brain://session/current` — also readable

Delivery is **stateless and message-driven** (A18): the server keeps no timer
and no file watcher. On each inbound request or ping it recomputes a sha1
fingerprint of the current value of every subscribed URI and emits a
`notifications/resources/updated` notification for any URI whose fingerprint
changed since the prior check — but never a synthetic update in the same turn
as the subscribe. A reconnect resets the subscribed set and the prior
fingerprint, and must pass through `initialize` again. There is no pushed,
async event stream that runs outside a request.

### `prompts/list` + `prompts/get`

`prompts/list` returns 3 prompt descriptors; each maps one-to-one to a CLI
command, and `prompts/get` returns the canonical prompt text. No v0.8.0 prompt
requires an argument; `session-start` and `brief-plan` accept an optional `for`
(task-aware retrieval), `instructions` takes none.

| name | URI | returns |
| --- | --- | --- |
| `session-start` | `prompt://session-start` | Equivalent of `agent-cli prompt [--for "<task>"]` — the dynamic, state-aware system-prompt recommendation |
| `instructions` | `prompt://instructions` | Equivalent of `agent-cli instructions` — the static long-form reference guide |
| `brief-plan` | `prompt://brief-plan` | Equivalent of `agent-cli --json brief --plan` — the ordered action list with safe-to-automate flags |

### `tools/list` + `tools/call`

v0.8.0 exposes **6 read-only tools** (A16): `brief`, `doctor`, `search`,
`snapshot`, `status`, and `spect_status`. Write tools are a **v0.8.1**
addition, gated by `capabilities.experimental.agentCli.writeTools` (the opt-in
above) — a v0.8.0 host never sees them, and a v0.8.1 host sees them only after
the handshake offers the capability. `tools.listChanged: false` means the tool
set is stable across the connection.

> Note: this section describes the MCP framing only. For the JSON envelope /
> exit-code contract of the underlying commands, see the rest of this document.

## Guarantees for AI agents

The contract is designed for autonomous AI consumers. Specifically:

- **No silent failures**: every `ok:false` carries a human-readable reason
  AND a substring-matchable category from the table above. Agents can
  pattern-match without parsing prose.
- **No partial envelopes**: the JSON is fully written or not at all (atomic
  write on the JSON output via `serializeEnvelope` → `JSON.stringify` →
  `console.log`).
- **Forward-compatible**: new fields are additive; consumers that ignore
  unknown fields continue to work. `apiVersion` MAJOR bumps are the
  exception.
- **No background processes by default**: every `agent-cli` invocation is a
  synchronous JSON producer. The only long-running modes are explicit
  (`serve`, `watch`, `brief-hooks`) and they declare themselves as such.

If you find an envelope that violates any of these guarantees, that's a
bug — open an issue with the failing JSON output.