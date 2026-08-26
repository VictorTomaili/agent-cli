// src/instructions.js — the canonical LLM-facing guide to agent-cli.
//
// Purpose: when an AI agent (Claude, Codex, DSH, Cursor, …) is driving the
// CLI, it needs ONE document that tells it what agent-cli is, what commands
// exist, how to read its output, what the JSON contract is, and what recipes
// to follow for common tasks. `agent-cli instructions` (alias `prompt`)
// prints that document — short enough to paste into a system prompt, dense
// enough to navigate without rereading the README.
//
// Two output modes:
//   - Human / default: a Markdown document (terminal-friendly; bullets, fenced
//     code, no ANSI).
//   - `--json`: { content, commands[], topics[], version, byteLength } so a
//     smarter agent can choose what to load into its context window.
//
// The instructions document is deliberately written in the second person
// ("you", "your") so it reads as instructions to the agent, not as
// documentation about the agent. It is the same text for every model — no
// per-vendor variants — because the contract is the contract.
//
// Content lives in `INSTRUCTIONS_MARKDOWN` (a constant string) so it stays
// reproducible (snapshot-tested) and easy to grep.

export const INSTRUCTIONS_MARKDOWN = `# agent-cli — instructions for AI agents

> One canonical AGENTS.md at \`~/.agents/AGENTS.md\`, mirrored to every AI
> coding tool you have installed (Claude Code, Codex, DSH, Cursor, Windsurf,
> Cline, Copilot, OpenCode, Goose, Zed, Warp, Aider, Junie, Trae, qwen, pi,
> Gemini). Edit once, every tool sees it.

## What this CLI is for

You are driving an end-user's AI tooling configuration through \`agent-cli\`.
The user has one master instructions file (\`~/.agents/AGENTS.md\` for global,
\`[cwd]/.agents/AGENTS.md\` for a project) plus a "brain" of supporting files
(IDENTITY.md, SOUL.md, USER.md, LESSONS.md, ENVIRONMENTS.md, MODELS.md,
WORKFLOW.md, agents/, skills/). Every AI coding tool they use gets a small
pointer stub redirecting to that master, so the user never edits the same
prose twice.

\`agent-cli\` is the lifecycle tool for that brain: bootstrap, link to new
tools, snapshot, upgrade, audit, repair.

## How to run it

- \`agent-cli <command> [--json]\` — every command supports \`--json\` for a
  versioned JSON envelope (see "Output contract" below). **You should always
  pass \`--json\`.** It is the only contract you can rely on; human output is
  for the user, not for you.
- \`--offline\` / \`AGENT_OFFLINE=1\` — never hit the network (used by brief,
  doctor, update). Use this when network is unreliable or forbidden.
- \`--no-update-check\` / \`AGENT_CLI_NO_UPDATE_CHECK=1\` — skip the npm-version
  freshness check the CLI runs at the start of every invocation. The check
  emits a top-level \`updateNotice\` field on every envelope when installed <
  latest, so you can react to it programmatically.
- Exit codes: 0 = success / intentional no-op; 1 = error; 2 = actionable
  work available (\`brief --check\`, \`doctor\`); 3 = partially applied.

## Output contract (\`--json\` envelope)

Every \`--json\` payload is \`{ ok, command, apiVersion, data }\` (+ optional
\`error\`, \`updateNotice\`). The \`data\` field is command-specific. When a
command fails, \`ok\` is \`false\` and a top-level \`error\` string carries the
human-readable reason. \`updateNotice\` is the npm-update advisory described
above. Treat unknown fields as forward-compatible additions.

\`apiVersion\` is "2.0.0". Don't pattern-match on specific field sets; instead
use \`ok\` to branch.

## How to discover what's available

- \`agent-cli --json manifest\` — full machine-readable command tree (every
  command, every option). Use this at the start of a session to enumerate.
- \`agent-cli schema [command]\` — JSON Schema for the envelope \`data\` shape
  of any command. Use this when you need to validate a specific output.
- \`agent-cli help <command>\` — human-readable help (still useful to you as
  prose, e.g. for examples).
- \`agent-cli instructions\` — this document. Call again if you need a
  reminder mid-session.

## Core workflows (recipes)

### Bootstrap a new machine
\`\`\`bash
agent-cli init          # idempotent — runs the first time, no-ops after
agent-cli --json status # verify pointers, hooks, brain health
agent-cli --json doctor # full diagnostic; exit 2 if anything needs attention
\`\`\`

### Onboard the user's identity / preferences
\`agent-cli onboard\` (alias \`agent-cli identity --onboard\`) walks them
through the identity archetype + USER + SOUL fields. Each missing field
becomes a structured question; never invent values, always ask. After the
user answers, you fill the field via \`agent-cli identity/soul/user/env set\`.

### Add a new AI coding tool
\`agent-cli --json target enable <id>\` — installs a pointer stub at the
tool's native location. \`<id>\` is one of: claude, codex, pi, gemini, qwen,
cursor, windsurf, cline, copilot, aider, junie, trae, zed, warp, opencode,
goose, deepseek. \`agent-cli targets\` lists all known ids with install
status. \`agent-cli where <id>\` shows the on-disk path.

### Sync skills across tools (cross-tool sharing)
\`agent-cli link skills\` creates \`~/.claude/skills\` → \`~/.skill-cli/store\`
(and the same for every other tool that supports skills). \`agent-cli link
agents\` does the same for sub-agent personas. \`agent-cli --json doctor\`
warns when an enabled+installed tool is missing a share link.

### Upgrade the brain schema
Existing users may be on an older schema (prose-only IDENTITY.md etc.).
\`agent-cli memory upgrade status --json\` reports the current schema version
and pending migrations. \`agent-cli memory upgrade plan --json\` returns a
plan with a plain-English \`instructionsForAgent\` walkthrough — paste it
into your system prompt and follow each migration's \`steps\` (run
\`agent-cli identity/soul/user set <FIELD> "<value>"\` for each), then call
\`agent-cli memory upgrade apply <id>\` to mark the migration applied.
Backups land in \`~/.agents/.upgrade-backups/<ts>-<id>/\`.

### Pull content a user wrote in a native file
If a tool's native config (e.g. \`~/.claude/CLAUDE.md\`) has the user's
prose, \`agent-cli pull <id>\` adopts it into the master, then re-links the
pointer stub. \`agent-cli --json status\` reports \`state: native\` for tools
that have un-pulled content.

### Refresh the npm-update notice mid-session
\`agent-cli --json doctor --force\` does a fresh registry check (bypasses the
24h cache in \`config.json\`) and surfaces the result via the envelope's
top-level \`updateNotice\` field.

## Hard rules for driving agent-cli

1. **Always pass \`--json\`.** Treat the envelope as the contract.
2. **Read \`updateNotice\` on every envelope.** When installed < latest,
   tell the user, then \`npm i -g @victortomaili/agent-cli@latest\`. The CLI
   auto-refreshes after the install (no manual cache flush needed).
3. **Never edit \`~/.agents/\` files by hand.** Use the per-file \`set\`
   commands (\`identity set\`, \`soul set\`, \`user set\`, \`env set\`,
   \`models set\`). They use atomic writes so partial edits never land.
4. **Never clobber user prose.** If a tag is empty but the surrounding
   prose has the same content, leave the prose; just add the tag. The
   \`memory upgrade\` migration notes tell you when to ask vs. preserve.
5. **Never bypass the locked config write.** Use \`target enable\` /
   \`target disable\`; never write to \`~/.agents/config.json\` directly.
6. **Treat secrets as secrets.** \`agent-cli secret set/get/list/rm/env\`
   exists precisely so you never have to read or write secrets yourself.
   Never echo them to logs or to the user.

## Quick reference

| Need | Command |
|---|---|
| Enumerate commands | \`agent-cli --json manifest\` |
| Envelope schemas | \`agent-cli schema [command]\` |
| Re-read this guide | \`agent-cli instructions\` |
| Bootstrap | \`agent-cli init\` |
| Status snapshot | \`agent-cli --json status\` |
| Full diagnostic | \`agent-cli --json doctor [--force] [--plan] [--fix-safe]\` |
| Edit master | \`agent-cli edit\` |
| Add a tool | \`agent-cli --json target enable <id>\` |
| Sync personas | \`agent-cli link agents\` |
| Sync skills | \`agent-cli link skills\` |
| Upgrade brain | \`agent-cli memory upgrade plan --json\` |
| Pull native content | \`agent-cli pull <id>\` |
| Update notice | \`agent-cli --json doctor --force\` |
| File inventory | \`agent-cli files --json\` |
| Session brief | \`agent-cli brief [--for "<task>"] [--plan] [--apply-safe] [--json]\` |
| Snapshot / restore | \`agent-cli snapshot\` / \`agent-cli restore <name>\` |
| Shipped updates | \`agent-cli update list\|stage\|diff\|apply\|clear\` |
| Skill manager | \`agent-cli skill list\|install\|enable\|disable\|…\` |
| MCP server | \`agent-cli serve\` |

When in doubt: \`agent-cli --json brief --plan\` returns the ordered action
list with safe-to-automate flags and one-line reasons — that is the closest
thing to a "what should I do next" oracle and is safe to call at the start
of every turn.
`;

/** Structured metadata for the JSON variant. Updated when the markdown moves
 *  so the JSON envelope always reports what the agent is getting. */
export const INSTRUCTIONS_TOPICS = [
	"what-this-cli-is-for",
	"how-to-run-it",
	"output-contract",
	"how-to-discover",
	"core-workflows",
	"hard-rules",
	"quick-reference",
];

export const INSTRUCTIONS_BYTE_LENGTH = Buffer.byteLength(INSTRUCTIONS_MARKDOWN, "utf8");

/** The canonical command tree — derived from the registered program at runtime
 *  by the CLI command; this constant is only the order-of-introduction list. */
export const INSTRUCTIONS_CORE_COMMANDS = [
	"init",
	"status",
	"doctor",
	"brief",
	"edit",
	"target enable|disable",
	"link",
	"memory upgrade",
	"update list",
	"skill list|install|enable|disable",
	"serve",
	"instructions",
	"manifest",
	"schema",
	"help",
];

/** Build the instructions payload for `agent-cli instructions [--json]`. */
export function buildInstructionsPayload({ version, byteLength } = {}) {
	return {
		content: INSTRUCTIONS_MARKDOWN,
		topics: INSTRUCTIONS_TOPICS,
		coreCommands: INSTRUCTIONS_CORE_COMMANDS,
		version: version || null,
		byteLength: byteLength ?? INSTRUCTIONS_BYTE_LENGTH,
	};
}