# Security Policy

## Supported versions

Only the latest published version of `@victortomaili/agent-cli` receives security
fixes. There are no long-term support branches.

| Version | Supported |
| --- | --- |
| latest on npm | ✅ |
| anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/VictorTomaili/agent-cli/security/advisories/new)
for this repository. Include:

- what an attacker can do, and what they need in order to do it,
- a reproduction — ideally a command line against a throwaway
  `AGENT_CLI_HOME=$(mktemp -d)`, so nothing of yours is touched,
- the version (`agent-cli --version`) and platform.

You should get an acknowledgement within a few days. This is a single-maintainer
project, so please allow reasonable time for a fix before disclosing publicly.

## What this tool touches

`agent-cli` is a local CLI. It reads and writes files under your home directory
and the tools' config directories, and it can start an MCP server over stdio.
It has no server component and no telemetry.

The security-relevant surface is:

- **`~/.agents/`** — the canonical brain: instructions, personas, lessons,
  sessions, secrets, and the dispatch ledger.
- **Pointer stubs** written into each detected tool's config directory.
- **`agent-cli serve`** — an MCP server over stdio. It is read-only unless the
  connecting host opts into the write capability during `initialize` (see
  [`docs/contract.md`](docs/contract.md)).

## Invariants a security report can hold us to

These are enforced by tests, and a violation of any of them is a bug worth
reporting:

- **Path containment.** No input-driven read, write, or delete resolves outside
  its intended root. Relative paths go through `resolveContained`; identifiers
  that become filenames go through `sanitizePathSegment`.
- **Pointer-only deletion.** `unlink` removes pointer stubs, never the content
  they point at, and never a file it did not write.
- **Secrets stay put.** Secrets are never synced, snapshotted, searched, or
  emitted in `--json` output.
- **Atomic writes.** Brain writes are exclusive-create → fsync → rename, so an
  interrupted write cannot truncate an existing file.
- **Config writes are locked.** Cross-process compare-and-swap, so two
  concurrent agents cannot clobber each other's config.
- **The MCP write surface is opt-in.** A host that does not offer
  `capabilities.experimental.agentCli.writeTools` never sees a write tool, and
  a host-supplied `cwd` never redirects where a write lands.

## Scope

In scope: anything that escapes the intended directory, leaks secrets, executes
unintended code, or lets a hostile MCP host drive a write it did not earn.

Out of scope: issues that require an attacker who already has your user account
on your machine, and anything in a dependency that is better reported upstream.
