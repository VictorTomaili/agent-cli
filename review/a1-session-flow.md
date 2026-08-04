# AI session and agent-in-the-loop experience review

## Summary

`@tomaili/agent` is already oriented toward coding agents: the root CLI advertises `--json`, most commands are non-interactive by default, `brief` exists as a session-start command, and the identity, lessons, skills, SPECT, snapshots, and model-alias features are all agent-relevant.

The main gap is that the tool reports state more than it drives an autonomous session. `agent brief --json` gives useful inventory, but it does not yet answer the agent's core startup question: "What should I read, ask, fix, skip, and do next, in a safe order?" The current schema leaves too many decisions in free-text arrays or separate commands. That is manageable for a human-facing CLI, but it creates friction and false confidence for Claude Code, Codex, Cursor, or another coding agent that must run the tool at session start and keep working without loops.

The best next direction is a first-class session orchestration layer: a richer `brief` or new `agent session start --json` command that combines skill gating, memory loading, SPECT state, project/global pointer health, model aliases, pending lessons, and safe self-healing into typed, prioritized `nextActions`.

## Top agent-experience wins already present

1. **A real session-start entrypoint exists.**  
   `src/cli.js:1781-1995` implements `brief`, and it gathers pointer state, update state, consolidation scores, onboarding gaps, memory files, lessons, model alias warnings, and SPECT state into one JSON payload. This is the right shape of feature for autonomous agents.

2. **The load manifest is much better than a status page.**  
   `brief` builds `sessionStart.load` at `src/cli.js:1824-1870`, including global and project identity files plus SPECT files. This is directly usable by an agent that needs to decide which files to read before acting.

3. **Lessons have machine-readable primitives.**  
   `src/lessons-lib.js:109-140` lists lessons with path, scope, occurrences, mark state, and timestamps. `src/cli.js:1040-1170` exposes list, add, show, inbox, and triage commands. The path-as-summary model is simple and agent-friendly.

4. **Consolidation has a cheap check mode.**  
   `src/consolidate.js:57-143` returns scores, reasons, and metrics, while `src/cli.js:1173-1226` exposes `agent consolidate --check`. This lets an agent avoid unnecessary writes.

5. **SPECT is discoverable without opt-in writes.**  
   `src/spect.js:193-247` returns `initialized`, `partial`, `load`, `missing`, and counts. `brief` includes this at `src/cli.js:1814-1815` and `src/cli.js:1992-1994`, so an agent can notice an existing specification workflow.

6. **Model alias failures are surfaced.**  
   `findUnresolvedModels` at `src/cli.js:140-154` and `brief` at `src/cli.js:1905-1936` surface unresolved model aliases with commands to repair them.

## Pain points for autonomous agents

### 1. `brief` is useful, but not yet an autonomous action plan

`brief` currently emits a mixed inventory plus a flat string list in `suggestedActions` (`src/cli.js:1920-1936`). For an autonomous agent, strings are awkward because they omit:

- priority and blocking level
- read-only vs write vs destructive safety class
- whether user confirmation is required
- expected exit codes
- whether the action can be auto-applied
- what condition made it necessary
- what command should be run in JSON mode
- what to do if it fails

Example: onboarding gaps are reported in `onboarding.gaps` (`src/cli.js:1816-1823`, `1978`) but there is no typed next step that says "ask exactly this user question now" or "do not ask because this field is optional for the current task." Similarly, SPECT files are added to `sessionStart.load`, but there is no task-specific indication of which specs are relevant.

### 2. `brief` does not include the skill gate

The START GATE instructions require `agent skill active` first, but `brief` is advertised as the AI session entrypoint (`src/cli.js:1778-1784`). These two startup paths are separate. An agent that follows both has to run two commands, parse two contracts, and reconcile precedence.

In JSON mode, skill passthrough is not a native schema. `src/cli.js:1509-1522` wraps the skill CLI stdout as a string, including ANSI escape codes. The underlying active command at `src/skills/commands/defaults.js:12-58` prints prose instructions rather than structured records. This means an agent cannot reliably parse active skills, classify them, or generate one clean user question without LLM interpretation of terminal text.

### 3. The START GATE model creates loops for autonomous agents

The gate requires the agent to propose every cost, speed, or style skill and end the turn before doing any work. That may be a valid policy choice, but the tool does not provide enough state to make it practical:

- Skills have no explicit `impact` metadata. `cmdActive` says classification is the agent's judgment from description only (`src/skills/commands/defaults.js:5-11`).
- Skills have no structured activation options. The agent must infer whether parameters exist from prose.
- There is no session memory for "the user declined this skill for this task." The agent may ask again on later messages because the canonical block says to re-run classification on every later message.
- There is no `--json` skill output with `mustAsk`, `loadNow`, or `alreadyLoaded` fields.
- There is no way to batch "load correctness/quality skills" and "ask trade-off questions" in one deterministic plan.

This is high-friction for an autonomous coding agent because it turns a tool bootstrap into a user interaction loop, and the CLI does not help the agent prove it handled the gate correctly.

### 4. Session-start reads can be too broad and too shallow at the same time

`sessionStart.load` includes every global file plus project placeholders, plus all SPECT templates and specs when SPECT exists (`src/cli.js:1824-1870`). In the observed `brief --json` output, that included five SPECT template files plus one actual spec. An agent still has to decide what is relevant and manually read each file.

At the same time, `brief` gives only paths for most memory files. It includes `lessons.core` content (`src/cli.js:1884-1904`, `1982-1988`) but not safe excerpts or token estimates for identity, user, environment, MODELS.md, or SPECT. This creates a trade-off: either the agent over-reads everything or risks skipping a critical file.

### 5. `brief` has side effects and possible network latency

`brief` calls `ensureUpdateCheck` at `src/cli.js:1793-1795`, which may fetch npm metadata with a 3 second timeout and then save config when refreshed. The helper is best-effort (`src/npm-check.js:59-113`), but a session-start command should ideally support a strict read-only/offline mode. Agents often run startup checks inside time budgets, sandboxes, or no-network CI contexts.

Recommended shape: `agent brief --json --offline --no-write --max-ms 1000` should never mutate config and should skip network checks.

### 6. Model aliases are not first-class in the brief

`brief` loads MODELS.md into `sessionStart.load` and reports only unresolved aliases under `modelAliases.unresolved` (`src/cli.js:1989-1991`). The actual alias map from `src/models.js:58-70` is not included. An agent deciding whether to delegate to a sub-agent or select a model still needs another `agent models list --json` command and then needs to join it with agent personality metadata.

### 7. Sub-agent/personality data is mostly absent from `brief`

`src/agents-lib.js:90-134` can list project and global sub-agent personalities with description, tools, model, thinking, scope, and path. `brief` uses related functions for unresolved model aliases, but does not include an `agents` section with available personalities, validation state, or recommended delegation constraints. For an "agent-in-the-loop" tool, this is a missed opportunity.

### 8. Lessons are captureable, but not easy to triage autonomously

The lessons flow gives raw primitives, but it lacks agent workflow support:

- `agent lessons inbox` returns file paths only (`src/cli.js:1106-1115`), no preview, stable ID, hash, suggested title, or content summary.
- `agent lessons triage --file <i>` uses an index (`src/cli.js:1124-1136`), which is fragile if files change between list and triage.
- `agent lessons add` accepts `--body` (`src/cli.js:1077-1087`) but has no structured fields for evidence, source task, repo, files touched, validation, confidence, or expiration.
- `listLessons` returns metadata but not relevance support (`src/lessons-lib.js:109-140`). The agent must search and rank lesson files manually.

This means lessons can be stored, but autonomous capture, triage, and retrieval still depend heavily on the agent inventing conventions.

### 9. Consolidation is too opaque for safe autonomous application

`consolidate --check` is safe, but `consolidate` can mark, promote, and delete files. The result only reports counts (`src/consolidate.js:328-341`). It does not list which lesson files would be promoted, marked, or deleted, even in `--dry-run`. That makes it difficult for an agent to decide whether it is safe to apply or whether to ask the user.

A safe autonomous flow needs a plan with file-level operations and an apply step that takes that exact plan.

### 10. Restore is too easy to invoke for an agent-facing CLI

`agent restore [name]` (`src/cli.js:1555-1578`) is non-interactive and destructive in the sense that it replaces the current brain, even though `src/snapshot.js:113-121` creates a pre-restore backup. For an agent, this command should require a stronger contract than a positional name, such as `--yes --snapshot <name>` or an explicit `restore --plan` followed by `restore --apply <planId>`.

### 11. SPECT surfaces files, not next work

`inspectSpect` returns counts and load files (`src/spect.js:193-247`), and `brief` includes those files. It does not parse specs, plans, or task checkboxes into a next-action model. An agent still has to read all SPECT files, infer open requirements, find unchecked tasks, and decide whether implementation is allowed.

For agent-in-the-loop work, SPECT should produce a typed task graph or at least "next unchecked tasks with requirement IDs and verification commands."

## Concrete feature and command proposals

### Proposal 1: Add `agent session start --json`

Keep `brief`, but add a higher-level session command that returns an ordered plan.

Suggested schema:

```json
{
  "schemaVersion": 1,
  "command": "session.start",
  "mode": "autonomous",
  "state": { "healthy": true, "confidence": "partial" },
  "readSet": [
    {
      "id": "global-user",
      "path": ".../USER.md",
      "scope": "global",
      "kind": "user",
      "priority": "high",
      "reason": "User preferences affect every task",
      "exists": true,
      "tokensApprox": 420,
      "loadPolicy": "read-now"
    }
  ],
  "gates": [
    {
      "id": "skill-tradeoffs",
      "type": "ask-user",
      "blocking": true,
      "question": "Enable concise-replies? It reduces response length. yes/no",
      "choices": [{ "value": "yes" }, { "value": "no" }]
    }
  ],
  "nextActions": [
    {
      "id": "repair-skill-store",
      "title": "Initialize skill store",
      "priority": 20,
      "safety": "safe-write",
      "autoApply": true,
      "command": ["agent", "--json", "skill", "setup"],
      "reason": "skill.available is false",
      "onFailure": "surface stderr and continue without skills"
    }
  ],
  "warnings": []
}
```

Rationale: an autonomous agent needs a deterministic action graph, not a dashboard plus strings. This would subsume the most useful parts of `brief`, `skill active`, `doctor`, and SPECT status without removing those commands.

### Proposal 2: Replace flat `suggestedActions` with typed `nextActions`

In `brief` (`src/cli.js:1920-1936`), keep `suggestedActions` for backwards compatibility but add a typed array:

- `id`
- `priority`
- `kind`: `read`, `ask-user`, `safe-command`, `repair`, `manual-review`, `destructive`
- `scope`: `global`, `project`, or `both`
- `command`: argv array, not a shell string
- `jsonCommand`: argv array with `--json`
- `reason`
- `blocksTask`: boolean
- `requiresUserConsent`: boolean
- `expectedExitCodes`
- `successPredicate`
- `fallback`

Rationale: agents can execute arrays safely, avoid shell parsing, know when to stop and ask, and recover from failures.

### Proposal 3: Give skills native JSON and metadata

Add native `--json` support inside `src/skills/cli.js`, not just root passthrough wrapping. Add metadata fields to skill frontmatter and store parsing:

```yaml
impact: correctness | quality | cost | speed | style | none
startup: load | propose | skip
activationOptions:
  level: [light, normal, strict]
```

Then make `agent --json skill active` return:

```json
{
  "command": "skill.active",
  "active": [
    {
      "name": "frontend-design",
      "description": "...",
      "triggers": ["frontend-design"],
      "impact": ["quality"],
      "startupAction": "load",
      "activationOptions": [],
      "source": "global-default"
    }
  ],
  "requiredGate": {
    "askUser": [],
    "loadNow": ["frontend-design"]
  }
}
```

Rationale: the current `cmdActive` prose at `src/skills/commands/defaults.js:12-58` asks the model to infer policy from descriptions. That is brittle and creates loops. Metadata lets the tool do the mechanical part while preserving user choice for trade-offs.

### Proposal 4: Integrate skill gating into `brief` and session start

Add a `skills` section to `brief` with active skill records and a computed gate plan. If the tool intentionally does not want to classify unknown skills, it can still return:

- active skills as structured objects
- missing metadata warnings
- a generated user question for all trade-off skills with known metadata
- `needsAgentClassification: true` for unknowns

Rationale: `brief` is presented as the AI session entrypoint, but the real required first command is currently `skill active`. Combining them removes startup ambiguity.

### Proposal 5: Add `agent repair --plan --json` and `agent repair --apply <planId>`

Build a self-healing layer over existing commands:

- initialize missing master and required files
- set up skill store
- refresh managed blocks
- relink stale pointers
- write MODELS.md from aliases
- repair partial SPECT skeleton when already initialized

The plan should classify actions as safe write, user-content risk, or destructive. Applying should skip anything that became unnecessary.

Rationale: agents should fix safe drift instead of surfacing it. Today `doctor` and `brief` provide diagnostics, but the agent still manually maps strings to commands.

### Proposal 6: Add `agent lessons search` and richer `lessons show --json`

Add retrieval-oriented commands:

```text
agent lessons search <query> --json --limit 5 --preview 500
agent lessons relevant --files src/cli.js src/skill.js --json
agent lessons show <name> --json --frontmatter --content
```

Return previews, tags, occurrences, promoted state, source scope, and reasons for match.

Rationale: `brief.lessons.index` (`src/cli.js:1875-1882`, `1982-1988`) tells agents what exists, but not what to read for the current task. Search and relevance prevent both over-loading and missed memory.

### Proposal 7: Add stable inbox IDs and preview triage

Change inbox triage from mutable numeric index to stable IDs:

```text
agent lessons inbox --json --preview 1000
agent lessons triage --file-id <id> --to <topic/name>
agent lessons triage --delete-id <id>
```

Return `id`, `file`, `scope`, `createdAt`, `sha256`, `preview`, and maybe `suggestedPath`.

Rationale: numeric indices at `src/cli.js:1124-1147` are easy for agents to misuse if the inbox changes. Stable IDs make multi-step autonomous triage safer.

### Proposal 8: Make consolidation produce an auditable operation plan

Enhance `consolidate --dry-run --json` to list file-level operations:

```json
{
  "operations": [
    { "op": "promote", "file": "...", "lessonRef": "lessons/foo.md", "summary": "..." },
    { "op": "mark", "file": "...", "reason": "single occurrence grace pass" },
    { "op": "delete", "file": "...", "reason": "marked and still unrepeated" }
  ]
}
```

Then add `agent consolidate --apply-plan <id>` or `--apply <planFile>`.

Rationale: counts at `src/consolidate.js:328-341` are not enough for safe autonomous deletion or promotion. Agents need reviewable diffs.

### Proposal 9: Add `agent spect next --json`

Parse SPECT markdown enough to expose:

- active specs by status
- open questions
- unchecked tasks
- requirement IDs without verification
- recommended files to read for the current task
- whether implementation is blocked by draft/open questions

Example:

```json
{
  "command": "spect.next",
  "initialized": true,
  "nextTasks": [
    { "id": "TASK-002", "reqs": ["REQ-001"], "file": ".spect/tasks/x.md", "text": "Add verification" }
  ],
  "blockingQuestions": [],
  "readSet": [".spect/specs/x.md", ".spect/plans/x.md"]
}
```

Rationale: `inspectSpect` is a manifest (`src/spect.js:193-247`). Agents need workflow state.

### Proposal 10: Add read-only and bounded startup modes

For `brief` and any future `session start`, add:

- `--offline`: skip npm/network checks
- `--no-write`: do not save update cache or mutate config
- `--max-ms <n>`: return partial results with warnings if checks exceed budget
- `--no-spawn`: skip subprocess checks such as skill version
- `--include-content none|core|small|all`

Rationale: session start should be reliable in CI, sandboxes, and low-latency agent loops. `brief` currently may do npm checks and config writes (`src/cli.js:1793-1795`).

### Proposal 11: Include model aliases and agent personalities in `brief`

Add:

```json
{
  "models": { "aliases": {}, "unresolved": [] },
  "personalities": {
    "available": [
      { "name": "reviewer", "description": "...", "tools": [], "model": "smart", "resolvedModel": null, "scope": "global" }
    ],
    "invalid": []
  }
}
```

Rationale: `agents-lib` already has the data (`src/agents-lib.js:90-134`), and `models.js` already exposes aliases (`src/models.js:58-70`). This would let an orchestrating agent decide whether and how to delegate without extra commands.

### Proposal 12: Harden destructive UX with plans and explicit consent flags

Add `restore --plan`, require `restore --yes --name <snapshot>`, and include safety metadata in `brief.nextActions`. Treat destructive or broad rollback commands as never auto-applicable.

Rationale: `restore` is intentionally non-interactive, but autonomous agents need stronger guardrails than humans. A backup reduces risk, but it does not make replacement of the whole brain a safe default.

## Suggested target end-state

The ideal agent startup flow would be:

1. Agent runs `agent session start --json --offline --no-write`.
2. Tool returns a typed read set, skill gate, warnings, and safe repair plan.
3. Agent loads required correctness/quality skills using provided commands.
4. Agent asks one consolidated user question only if there are real blocking trade-off gates or identity gaps.
5. Agent auto-applies safe repairs with `agent repair --apply-plan`.
6. Agent reads only relevant memory and SPECT files.
7. During and after the task, agent captures lessons with structured evidence and runs consolidation only from a file-level plan.

That would turn `@tomaili/agent` from a strong AGENTS.md manager with agent-friendly commands into a true AI-session operating layer.

## Validation performed

- Read `PROJECT-ANALYSIS.md` first to avoid re-reporting already documented security and correctness issues.
- Reviewed `src/cli.js`, especially `skill`, `doctor`, `brief`, `lessons`, `consolidate`, `identity`, `models`, `snapshot`, and `spect` command regions.
- Reviewed `src/agents-lib.js`, `src/lessons-lib.js`, `src/consolidate.js`, `src/snapshot.js`, `src/identity.js`, `src/models.js`, `src/spect.js`, `src/skill.js`, and key `src/skills/**` command files.
- Ran `node src\cli.js --json brief` and `node src\cli.js --json skill active` from `S:\agent` to inspect actual machine-facing output.
