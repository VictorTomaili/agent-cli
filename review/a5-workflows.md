# End-to-End Workflows & Cross-Feature Integration Review — `@tomaili/agent` (agent-cli v0.2.1)

**Lens**: user- and agent-facing journeys end to end; how identity, memory, SPECT, skills, models, snapshots, and multi-agent personalities fit together as workflows.
**Scope read**: `src/cli.js`, `src/identity.js`, `src/archetypes.js`, `src/fields.js`, `src/agents-lib.js`, `src/lessons-lib.js`, `src/consolidate.js`, `src/snapshot.js`, `src/spect.js`, `src/models.js`, `src/skill.js`, `src/skills/**`, `src/store.js`, `src/pointer.js`, `src/blocks.js`, `src/config.js`, `src/seed.js`, `src/npm-check.js`, `src/detect.js`, `src/targets.js`, `seed/agents/*`.

> Scope note: security/correctness defects already catalogued in `PROJECT-ANALYSIS.md` (CRITICAL-1..3, HIGH-1..6, GAP-1..17, M1..M10, T1..T9) are **not re-reported**. They are referenced only where they constrain a workflow improvement below. Protocol/session-format findings covered in `review/a1-session-flow.md` and `review/a4-automation.md` are also not re-reported; this review focuses on **cross-feature wiring and composite capabilities**.

---

## Summary

The tool has excellent *primitives*: a pointer model that makes the master single-source (`src/pointer.js`), a rich session brief (`src/cli.js:1780-2106`), an agent-driven lesson store with occurrence tracking (`src/lessons-lib.js`), occurrence-based consolidation (`src/consolidate.js`), whole-brain snapshot/restore (`src/snapshot.js`), a project-local spec workflow (`src/spect.js`), a bundled skill manager (`src/skills/**`), model aliases (`src/models.js`), and reusable personalities with a validation contract (`src/agents-lib.js`). Each subsystem works in isolation.

But **no end-to-end workflow is closed**. Every journey examined stops at a point where a human or agent must hand-wire two subsystems by hand:

1. **Setup** seeds four personalities whose model aliases (`coding-model`, `smart-model`, `fast-model`, `review-model` in `seed/agents/*.md`) do not exist — `init` deliberately writes an empty `MODELS.md` (`src/cli.js:276-281`). A fresh install immediately reports 4 unresolved aliases in `doctor`/`brief` and gives the user 4 separate `agent models set` commands to run, with no suggested mapping.
2. **Session start** — `brief` aggregates state but omits the three things an orchestrator most needs: the personality roster (`listAgents` is never called in the brief handler), active skills, and the resolved agent→alias→model mapping. The START GATE's `agent skill active` remains a separate, text-only call.
3. **Memory** — the capture→triage→consolidate→snapshot loop has a hole at capture: nothing in the tool writes `lessons/.inbox` (it is read-only, "from the optional pi extension", `src/lessons-lib.js:143-148`), so "defer to triage" is unexpressible; `lessons add` commits straight to the store. Consolidation backups (`~/.agents/backups/LESSONS-*.md`) live in a directory that `snapshot` explicitly excludes (`src/snapshot.js:59`), making them unreachable through `agent restore`. And a documented `consolidate.prompt: ask|auto|off` preference in the `USER.md` template (`src/archetypes.js:142-145`) is honored by **no code at all**.
4. **SPECT** is a template scaffold with no pipeline: `spect init` ends with "copy .spect/templates/spec.md into .spect/specs/" (`src/cli.js:1433-1435`). There is no spec/plan/task scaffolding, no REQ→TASK traceability check, and no connection to the seeded `planner` personality.
5. **Multi-agent identity** is file management, not a delegation surface: nothing can run or hand off to a personality, brief doesn't surface the roster, and there is no `agent agents edit`.

The highest-leverage fixes are **composite commands that wire existing primitives together**: `agent setup` (bootstrap), `agent day-start` (session kickoff), `agent report` (session-end lesson + snapshot), `agent memory capture` (revives the dead inbox), `agent spect new/plan/status` (spec→plan→task), `agent brain git` (git-backed brain), and `agent restore --relink`. Each is concretely specified in the last section.

---

## Journey-by-journey usability assessment

### Journey 1 — New user setup (`init → link → brief → onboard → models`)

**What works.** `agent init` is non-destructive and coherent: ensures the master (`src/cli.js:204-211`), detects and enables installed global targets (`212-220`), sets up the skill store and block (`223-229`), seeds defaults and identity files (`234-282`), and deploys pointer stubs (`291-302`). It prints actionable next steps (`322-325`).

**Where it breaks/stalls.**

- **Ships broken personalities.** `installSeeds` copies `planner/reviewer/scout/worker.md` into `~/.agents/agents/` (`src/cli.js:234-247`), and each references an alias that `init` never creates (`seed/agents/planner.md:5`, `scout.md:5`, `reviewer.md:5`, `worker.md:5`; `MODELS.md` is seeded empty at `src/cli.js:276-281`). The user is told "Next: run `agent brief`" and the first `brief`/`doctor` is a wall of unresolved-alias warnings (`src/cli.js:1689-1702`, `1905`, `2016-2024`). The only remediation is 4 hand-typed `agent models set <alias> <provider/model>` commands with no suggestion of what to set. The tool designed this in deliberately ("init never invents provider choices", `src/cli.js:253-254`), but it ships no *aid* either — no `models suggest`, no mapping file, no guided prompt.
- **Onboarding leaves 3 of 4 identity fields + the name + USER.md undone.** `agent onboard suggest` asks one question (`src/archetypes.js:203`); `identity apply` writes the archetype but leaves `<AGENT_NAME>` empty by design (`src/archetypes.js:99-100`) and never touches USER.md preferences/goals/context. So after "onboarding", `agent brief` still reports gaps for name + user fields.
- **No setup state machine.** There is no "setup checklist" persisted anywhere; the agent re-derives the same 6-10 steps from `brief` every session. `init` is re-runnable but only re-links; it does not finish the job.
- **The skill store is empty with no guidance.** `ensureSkillStore` creates an empty store (`src/skill.js:89-101`) and the master block instructs the gate, but there is no starter-skill suggestion in `brief` (`suggestedActions` only fires when skills are *unavailable*, `src/cli.js:1929`).

**Verdict**: usable but multi-step; the *signal* (doctor/brief) and the *remediation* (4+ commands) are disconnected. Needs a single `setup` composite (see C2).

### Journey 2 — Ongoing agent session start (`brief → skill active → load → work`)

**What works.** `brief` aggregates master state, target drift, skill availability, onboarding gaps, consolidation scores, lesson index + core content, model-alias health, SPECT state, staged updates, and a load manifest (`src/cli.js:1938-1995`). It prints the load list, core lessons, and suggestions (`1997-2104`).

**Where it breaks/stalls.**

- **The orchestrator's roster is missing.** `listAgents` is called only inside `findUnresolvedModels` (`src/cli.js:140-153`); the brief payload has no `personas`/`agents` section. An agent told by the master to "Prefer specialized sub-agents" (`src/store.js:62-63`) must remember to run `agent agents list` separately.
- **Active skills and the resolved model map are missing.** `brief.skill` is `{available, version, source}` (`src/cli.js:1951-1955`); `modelAliases` only lists `unresolved` (`1989-1991`). The gate-mandated `agent skill active` is a second, text-only call (`src/skills/commands/defaults.js:12-58`), and the positive mapping agent→alias→provider is nowhere — the agent cannot tell whether `scout` will run on the fast model without joining `agents list` × `models list` by hand.
- **Hidden side effect.** `brief` runs the npm update check and may `saveConfig` (`src/cli.js:1793-1795`) — a "session start" that mutates state. (Protocol angle in a4 F10.)
- **Two commands do the session-start job of one.** `brief` + `skill active` must both run; a `day-start` composite removes the seam (see C1).

**Verdict**: the best aggregate surface in the tool, but it stops at *state* and leaves *orchestration context* (personas, active skills, model map) to separate commands.

### Journey 3 — Memory: capture → triage → consolidate → snapshot → restore

**What works.** `lessons add` creates/refreshes a lesson with occurrence + first/lastSeen frontmatter and recurrence-clears the grace mark (`src/lessons-lib.js:170-209`). `consolidate` promotes recurring → core, marks singletons, prunes marked singletons, backs up the core file, and records state (`src/consolidate.js:243-342`). `snapshot`/`restore` copy/validate/roll back the whole global brain (`src/snapshot.js`).

**Where it breaks/stalls.**

- **Capture has no triage queue.** Nothing writes `lessons/.inbox`. `inboxLessons`, `fileInboxItem`, `clearInbox` only read it (`src/lessons-lib.js:143-168`, `220-270`), and the comment says captures come "from the optional pi extension". The CLI's `lessons triage` UI (`src/cli.js:1124-1167`) therefore has nothing to triage unless an external tool writes `.inbox`. The designed loop "capture raw → triage → file" is unexpressible inside agent-cli; the only in-tool path (`lessons add`) commits a judgment immediately. (a1 proposed `lessons capture/review/close-session`; this review adds: it must *write `.inbox`* so the existing triage commands become alive.)
- **Consolidation backups are invisible to snapshots.** `ensureBackup` writes `~/.agents/backups/LESSONS-<ts>.md` (`src/consolidate.js:207-224`), but `snapshot()` excludes the whole `backups/` tree (`src/snapshot.js:59`), and `listSnapshots`/`restore` only know `backups/snapshots/` (`src/snapshot.js:42-53`). The only pre-consolidation copy of the core file is thus not restorable via any command; there is no `backups list`/`backups diff` for consolidation history.
- **Consolidation is unsafe to run unattended** (marks→deletes on the second pass, `src/consolidate.js:290-306`) and `brief`'s only automation hook is `suggestedActions` — which contradicts the documented `consolidate.prompt: auto` preference that no code reads (`src/archetypes.js:142-145`; grep confirms the string appears only in the template). The USER.md literally documents an auto-consolidation mode the CLI never implements.
- **Snapshot/restore is global-only.** Project-scope memory (`[cwd]/.agents/lessons`, `LESSONS.md`, agents, identity), SPECT state, and the skill store (`~/.skill-cli`) are outside the brain. A project lesson consolidated away or a skill removed has no snapshot. Restore also rolls `config.json` back to the snapshot's version but never re-links pointer stubs afterwards (restore touches only `~/.agents`; the stubs in `~/.claude/CLAUDE.md` etc. now point at a changed master and drift until `agent link` — restore emits no hint).
- **No session boundary.** Lessons get captured mid-session with no source-session/repo metadata, and nothing snapshots or summarizes at session end. (a1's lifecycle proposal stands; the composite C3 below adds the snapshot/consolidate wiring.)

**Verdict**: the memory loop is the most fragmented journey — capture bypasses triage, consolidation history is unreachable, snapshot coverage is global-only, and the documented automation preference is dead code.

### Journey 4 — Spec-driven project (`spect`)

**What works.** `spect init` scaffolds README/constitution/templates non-destructively (`src/spect.js:162-180`); `inspectSpect` produces a read manifest + missing-file list (`193-247`); `brief` surfaces SPECT state and load list (`src/cli.js:1814-1815`, `1857-1869`, `2073-2082`). Templates encode a real methodology (SCN/REQ ids, verification plans, task checklists, `src/spect.js:65-132`).

**Where it breaks/stalls.**

- **It's a scaffold, not a pipeline.** After `spect init`, the CLI's own next-step is "copy .spect/templates/spec.md into .spect/specs/ and define acceptance criteria" (`src/cli.js:1433-1435`) — manual copy/paste. There is no `spect new <id>`, no `spect plan <spec>`, no `spect task`, no status-per-task, and no REQ→TASK traceability check (the templates declare the linkage, `src/spect.js:127-131`, but nothing verifies it).
- **No wiring to the seeded planner.** The `planner` personality's output contract ("Plan / Files to Modify / Risks", `seed/agents/planner.md:50-77`) mirrors `templates/plan.md`, but no command generates a PLAN from a spec or hands the spec to the planner. The spec→plan→task decomposition is left entirely to the agent's ad-hoc prompt.
- **No state tracking.** Tasks are `- [ ]` checkboxes in files; nothing reads them, so `spect status` reports counts only (`src/spect.js:245`), not "spec X blocked on REQ-002 verification".

**Verdict**: a good *agreement* layer with no *execution* layer. Needs the `spect new/plan/status` pipeline (C5).

### Journey 5 — Skills: install / enable / update

**What works.** Install via `npx skills add` with temp-dir isolation and `.source` recording (`src/skills/commands/install.js:20-82`); update with staged swap + rollback (`src/skills/commands/update.js:110-176`); a clear activation model: global `defaults` + project `allow`/`deny`/`inherit` (`src/skills/lib/config.js:148-170`); the integrated block in the master (`src/skills/lib/agents-md.js:13-69`).

**Where it breaks/stalls.**

- **Skill state is outside the brain.** Store + config live in `~/.skill-cli` (`src/skill.js:17-19`); snapshot/restore cover only `~/.agents`. Removing a skill or losing `config.yaml` has no restore path. There is no `skill export/import` and no backup story.
- **The gate is transcript-only and brief doesn't help.** `agent skill active` prints ANSI text instructing the agent to classify and propose (`src/skills/commands/defaults.js:19-57`); there's no JSON, no durable ack, and `brief` doesn't call it (only availability). A session-start agent gets *two* sources of truth about skills — brief's availability line and the gate's active list — with no merge. (Protocol fixes are in a1/a6; the cross-feature gap here is that brief could surface `active` + `defaults` and a `sessionPolicy` for the gate.)
- **Project activation lives in `[cwd]/skill.config`**, a third home besides `~/.agents` and `~/.skill-cli` — invisible to `agent files`, `agent doctor` (which never checks skill.config), and snapshots.
- **Update requires the original source.** `updateOne` fails with "source unknown" when `.source` is absent (`src/skills/commands/update.js:90-97`) and requires network. No offline patch path.

**Verdict**: the lifecycle itself is solid; the seams are backup/restore coverage, JSON/state for the gate, and doctor visibility into `skill.config`.

### Journey 6 — Multi-agent identity

**What works.** Personality files with frontmatter (`name`, `description`, `tools`, `model`, `thinking`) + a required-section contract + placeholder validation (`src/agents-lib.js:91-133`, `307-358`); project-over-global dedupe (`118-121`); scaffold-from-template (`193-213`); model-alias resolution warnings in `validateAgent` (`327-342`); doctor aggregates unresolved aliases (`src/cli.js:1689-1702`).

**Where it breaks/stalls.**

- **File management ≠ delegation.** Nothing can execute or hand off to a personality; the tool's own master says "Prefer specialized sub-agents" (`src/store.js:62-63`) but provides no delegation aid — no handoff-prompt generator, no roster in `brief` (see Journey 2), no way to wire a personality into a specific agent runtime.
- **`identity apply` clobbers the name.** `applyIdentity` rewrites the whole file from the archetype (`src/identity.js:28-35`), and the archetype always emits `<AGENT_NAME></AGENT_NAME>` empty (`src/archetypes.js:99-100`). Setting a name and later re-applying an archetype silently erases it.
- **Unknown-key semantics differ by mode.** `identity apply <unknown>` calls `fail()` (exit 1) in human mode but proceeds with the `general-purpose` fallback in `--json` mode (`src/cli.js:770-776`); identical split in `soul apply` (`836-842`). The same command has different success semantics depending on `--json`.
- **No edit command.** `agent agents show` prints content and `agents path` prints directories, but there is no `agent agents edit <name>`; `agent edit` supports only the six identity kinds (`src/cli.js:578-628`). Editing a personality means copying a path into `$EDITOR` manually.
- **Positive verification is missing.** `validateAgent` warns only on *unresolved* aliases; nothing reports the joined view "scout → fast-model → <provider/model> @ thinking" for all personalities.

**Verdict**: a well-formed *schema* with no *runtime* and thin *tooling*. The composite `agent agents roster --json` + `agent delegate` handoff generator (C6) would make the roster actionable without a runtime.

---

## Cross-feature integration gaps

| # | Gap | Evidence | Impact |
|---|-----|----------|--------|
| G1 | **`brief` omits personas, active skills, and the resolved model map** — the three orchestration inputs. | `listAgents` never called in brief handler; `skill` = availability only (`src/cli.js:1951-1955`); `modelAliases` = unresolved only (`1989-1991`); persona roster absent (`1938-1995`). | Session-start agent must run 3 extra commands and join results by hand; delegation guidance in the master is unsupported by data. |
| G2 | **Documented `consolidate.prompt: ask\|auto\|off` is unimplemented.** | String appears only in `USER.md` template (`src/archetypes.js:142-145`); no code reads it. | Auto-consolidation users believe in never happens; the "auto" contract is a lie. |
| G3 | **Capture→triage loop is dead in-tool.** | `.inbox` is read-only: `inboxLessons`/`fileInboxItem`/`clearInbox` (`src/lessons-lib.js:143-168`, `220-270`); no writer exists; CLI triage UI (`src/cli.js:1106-1167`) has nothing to file. | "Defer to triage" unexpressible; every capture is an immediate commitment; inbox count in `assess`/`brief` is always 0 from in-tool usage. |
| G4 | **Consolidation backups are invisible to snapshot/restore.** | `ensureBackup` → `~/.agents/backups/LESSONS-*.md` (`src/consolidate.js:207-224`); `snapshot` excludes `backups/` (`src/snapshot.js:59`); `restore` only sees `backups/snapshots/` (`src/snapshot.js:42-53`). | The pre-consolidation core copy is unrecoverable via any command; no diff/history surface for LESSONS.md. |
| G5 | **Snapshot/restore is global-only and restore never re-links.** | Brain = `~/.agents` (`src/snapshot.js:8`); project `.agents`, `.spect`, `~/.skill-cli` outside. Restore wipes `~/.agents` then copies (`src/snapshot.js:116-120`) and returns no link hint. | Project lessons, SPECT, and skills have no rollback; restored config.json may disagree with on-disk pointers until a manual `agent link`. |
| G6 | **Identity onboarding does not integrate with models or agents.** | `onboard suggest`→`identity apply` touches only IDENTITY.md (`src/identity.js:28-35`); name left empty (`src/archetypes.js:99-100`); seed personalities reference 4 unseeded aliases (`seed/agents/*.md:5`); `init` writes empty MODELS.md (`src/cli.js:276-281`). | Onboarding ends with unfilled name + USER.md + 4 broken personalities; no guided model mapping. |
| G7 | **Multi-agent identity has no edit or delegation surface.** | No `agents edit`; `agent edit` kinds fixed to six (`src/cli.js:578-628`); no roster in brief (G1); no handoff generator. | Personality authoring is path-copy + external editor; nothing makes the roster actionable. |
| G8 | **SPECT is scaffold-only; no spec→plan→task pipeline.** | `spect init` next-step is manual template copy (`src/cli.js:1433-1435`); no `spect new/plan/task`; `inspectSpect` counts only (`src/spect.js:245`); planner personality unwired to PLAN template. | The documented SPECT loop (specify→plan→decompose) has no CLI support; traceability is unverifiable. |
| G9 | **Skill state split across three homes.** | store+config in `~/.skill-cli` (`src/skill.js:17-19`); project activation in `[cwd]/skill.config` (`src/skills/lib/config.js:102-104`); brain in `~/.agents`. Doctor never checks `skill.config`. | No backup/restore for skills; doctor's "all checks passed" can be false-green for a broken project skill config. |
| G10 | **Skill gate and brief are two unmerged sources of skill truth.** | `brief.skill` = availability (`src/cli.js:1951-1955`); gate needs `skill active` text (`src/skills/commands/defaults.js:19-57`). | Session start duplicates skill handling; no single "what skills are active and what do they need" answer. |
| G11 | **Convention split across subsystems.** | Root: tabs + double quotes + async/await (`src/cli.js`, `src/lessons-lib.js`); skills: 2-space + single quotes + sync (`src/skills/commands/list.js`, `store.js`). Scope: root `-p/--project` + `-g/--global`; skills `-g` only (project via cwd). `--json` global in root, absent in skills. `identity apply` fallback semantics differ between modes (`src/cli.js:770-776`, `836-842`). | Different mental model per subsystem; agents must special-case the skill surface (no `--json`), and identical commands behave differently in JSON mode. |
| G12 | **Update path has no safety composite.** | Staged updates are reviewed/diffed/cleared by hand (`src/cli.js:1344-1346`); no pre-update snapshot; no `apply` that snapshots then migrates non-conflicting seed files. | Upgrades are manual forever; no one-click path with rollback. |
| G13 | **`agent edit` stops at identity files.** | Kinds: `agents|soul|identity|user|lessons|environments` (`src/cli.js:578-594`). No `edit spect`, `edit agents/<name>`, `edit models`, `edit skills`. | The "one editor for the brain" story is incomplete; the other subsystems must be edited via paths. |

---

## Prioritized NEW composite capabilities

Each entry names concrete CLI behavior and the existing pieces it wires. Priority: **P0** = closes a broken journey with the most reuse; **P1** = high value; **P2** = polish.

### P0-1 — `agent day-start` (session kickoff) — closes Journeys 2 & 6, fixes G1/G10

One command that returns a single merged JSON session manifest and prints the human brief:

```
agent day-start [--json] [--for <task>]
```

Behavior:
- Runs the current `brief` builder **read-only** (moves the npm update check behind `--refresh`, reusing `ensureUpdateCheck` with `force:false` + no save).
- Merges in: persona roster via `listAgents({includeProject:true})` (name/description/model/thinking/scope), active skills + defaults via the skills config layer (`computeEffective`/`computeDefaults`, `src/skills/lib/config.js:148-184`), and the resolved alias map via `getAliases()`.
- Returns `{ schemaVersion, health, personas, skills:{available,active,defaults}, modelAliases:{aliases,unresolved}, sessionStart, consolidation, spect, suggestedActions }` — every field already computed today, just joined.
- `--for <task>` reuses the load manifest and adds a relevant-lessons slice (a1 #6) so the agent loads only what matters.

Wires: `brief` builder (`src/cli.js:1780-2106`) + `listAgents` (`src/agents-lib.js:91`) + skills config (`computeEffective`) + `getAliases` (`src/models.js:58`).

### P0-2 — `agent setup` (guided bootstrap) — closes Journey 1, fixes G6

```
agent setup [--json] [--yes] [--models-file <path>]
```

Behavior:
- Runs the `init` sequence (existing handler), then a **checklist pass** that reports `{done, remaining}` instead of a warning wall: master ✓, pointers ✓, skill store ✓, identity archetype applied?, name set?, USER.md filled?, personas valid?, model aliases resolved?
- Adds `agent models suggest` (or `setup --models-file`): scans `listAgents()` for `model:` fields, collects distinct referenced aliases, and emits `MODELS.md`-style lines (`agent models set <alias> <provider/model> [--category] [--thinking]`) for the user/agent to fill once, then `setup` applies them. This converts 4 manual `models set` commands into one mapping file.
- Ends with `agent link` + `agent doctor` and a persisted `setup: {completedAt, steps}` marker in config so subsequent sessions can skip already-done steps.

Wires: `init` (`src/cli.js:190-326`), `validateAgent` (`src/agents-lib.js:318`), `setAlias`/`writeModelsMd` (`src/models.js:71,90`), `link` (`src/pointer.js:186`), `doctor` checks (`src/cli.js:1581-1775`).

### P0-3 — `agent memory` (capture→triage→consolidate→snapshot as one flow) — closes Journey 3, fixes G2/G3/G4

Split into three commands that make the existing primitives reachable:

- **`agent lessons capture <topic> [--body TEXT] [--inbox|--direct] [--session <id>] [--scope g|p]`** — writes to `lessons/.inbox/` by default (`--direct` = current `addLesson` behavior). This is the one missing writer that revives `lessons triage` and the `inbox` counts in `assess`/`brief`. Includes `sourceSession`, `repo`, `branch` in the capture frontmatter.
- **`agent lessons triage --plan`** — returns `[{index, path, suggested, scope}]` mapping each inbox item to a candidate lesson path (filename-normalized), so `triage --file <i> <topic>` becomes a review-then-apply loop instead of free invention.
- **`agent memory check`** — reads the `USER.md` `<USER_PREFS>` tag for `consolidate.prompt` (via `readTag`, `src/fields.js:72`) and returns `{action: "ask"|"auto"|"off", consolidate: {score, recommend}}`. `--apply` runs `agent consolidate` when `prompt=auto` and `recommend`, with `--dry-run` receipt. This implements the documented preference.
- **`agent consolidate --receipt`** — after apply, returns changed files + the `backups/LESSONS-*.md` path written by `ensureBackup`, and `agent backups list|diff <n>` lists/diffs those consolidation backups so history is no longer invisible (fixes G4). Optionally snapshots first via `snapshot()`.

Wires: `addLesson`/`inboxLessons`/`fileInboxItem` (`src/lessons-lib.js:174,144,221`), `assess`/`consolidate` (`src/consolidate.js:57,243`), `readTag` (`src/fields.js:72`), `snapshot` (`src/snapshot.js:55`).

### P0-4 — `agent spect new|plan|status` (spec→plan→task pipeline) — closes Journey 4, fixes G8

```
agent spect new spec <id> <title>            # scaffold from templates/spec.md, inject id
agent spect new plan <id> <spec-id> <title>  # scaffold plan.md wired to the spec
agent spect new tasks <id> <plan-id>         # scaffold tasks.md
agent spect status [--json]                  # counts + per-file open-task count + missing REQ verification
agent spect trace <spec-id> [--json]         # REQ-* → TASK-* → verification mapping check
```

Behavior:
- `spect new` copies the existing templates (`src/spect.js:9-132`) with `SPEC-<id>`/`PLAN-<id>`/`TASKS-<id>` placeholders replaced — removing the manual "copy templates/spec.md" step (`src/cli.js:1433-1435`).
- `spect trace` parses specs (REQ-xxx), tasks (`[REQ-xxx]` markers, `src/spect.js:127-131`), and plans (verification lines) and reports orphans: REQ with no TASK, TASK with no REQ, REQ with no verification. Pure read-only.
- Optional `--delegate planner` prints the handoff prompt for the seeded `planner` personality (see P1-6) seeded with the spec content, so the plan generation is one paste away.

Wires: `initSpect`/`templatePaths` (`src/spect.js:163,249`), `inspectSpect` (`src/spect.js:194`), `showAgent` (`src/agents-lib.js:136`).

### P1-5 — `agent brain` (git-backed whole-brain sync + hooks) — closes the backup story, fixes G5/G9/G12

```
agent brain init            # git init ~/.agents with .gitignore (backups/, *.state.json, secrets)
agent brain commit [msg]    # add+commit with default message from changed files (e.g. "lessons: +2")
agent brain status          # git-style: dirty files, staged updates, unsnapshotted changes
agent brain push/pull [remote]
agent brain hook <event> <cmd>   # register a hook: pre-commit | post-snapshot | session-start | lesson-added
```

Behavior:
- The whole brain (`~/.agents`, and optionally `[cwd]/.agents` + `.spect` + `~/.skill-cli` as an opt-in `brain.yml` paths list) becomes a git repo. `commit` auto-stages and uses the changed-file categories (identity/lessons/skills/models/agents) for the message.
- `hook pre-commit` runs automatically before each `agent brain commit` (e.g. `agent memory check` + `agent snapshot`), and `session-start` fires from `agent day-start`. Hooks are plain commands stored in `~/.agents/hooks.json`, executed via `spawnSync` — the CLI is its own hook engine.
- This gives remote/off-machine sync (fixes "no git-backed sync of the whole brain"), point-in-time diffs for lessons/identity, and a rollback path that includes skills (G9) when `~/.skill-cli` is in the paths list.

Wires: `snapshot`/`restore` (`src/snapshot.js`), `listStagedUpdates` (`src/seed.js:188`), config (`src/config.js`), the CLI binary itself as the hook executor.

### P1-6 — `agent agents roster|edit|delegate` (make multi-agent identity actionable) — closes Journey 6, fixes G7

```
agent agents roster [--json]     # join agents × aliases × models: name, model, resolved provider/model, thinking, scope, valid
agent agents edit <name>         # open the personality file in $EDITOR (same flow as `agent edit`)
agent agents delegate <name> [--prompt TEXT] [--output <file>]   # generate a handoff prompt
```

Behavior:
- `roster` is the joined view missing from brief (G1/G7): for each personality, resolve `model:` via `getAlias`, emit concrete provider/model/thinking + fallbacks, plus `validateAgent` summary. This is the "positive verification" the current model-alias chain lacks.
- `delegate` renders the personality's template sections ("Goal", "Requires", "Output style", "Constraints", "Handoff", `src/agents-lib.js:145-191`) into a ready-to-use delegation prompt with the caller's task text interpolated — no runtime required, works with any agent harness's own spawn/delegate mechanism.

Wires: `listAgents`/`showAgent`/`agentTemplate` (`src/agents-lib.js:91,136,145`), `getAlias` (`src/models.js:68`), the `agent edit` editor flow (`src/cli.js:620-627`).

### P2-7 — `agent restore --relink` and `agent update apply` (safe state-change composites)

- **`agent restore <name> --relink`** — after `restore` (`src/snapshot.js:107`), run `link` (global + enabled project targets) so pointer stubs match the restored master, and include the pre-restore backup path in the receipt (fixes the G5 drift). A `--diff` mode previews `restore` without writing (reuses `diffLines`, `src/seed.js:229`).
- **`agent update apply <version> [--accept <files>]`** — snapshots the brain, applies staged seed files that have no live drift (`diffLines` shows only addititons or the live file is missing), leaves conflicting files for review, and clears the applied payload (`clearStaged`, `src/seed.js:267`). Turns the manual "review & migrate" step (`src/cli.js:1344-1346`) into a guarded one-shot with rollback.

### P2-8 — Cross-subsystem convention pass

- Give `agent skill <sub> --json` real structured output (skills config/store already return objects: `listStore`, `computeEffective` — the commands just need a JSON renderer), so `day-start` can merge skill state natively.
- Unify `identity/soul apply` fallback semantics across `--json` modes (`src/cli.js:770-776`, `836-842`): one behavior, one exit code.
- Persist `sessionPolicy` (the START GATE ack) in `~/.agents/config.json` so `day-start` can surface "gate already answered this session" — bridging the gate's transcript-only state (a1/a6 protocol work) into the cross-feature manifest.

---

## Recommended implementation order

1. **P0-3 memory wiring** (capture → `.inbox`, `consolidate.prompt` honored, backup receipt) — the dead inbox and the dead preference are the cheapest, most user-visible lies in the current product.
2. **P0-1 `day-start`** — pure read-side merge of data already computed; immediately fixes G1/G10 and gives the session-start journey a single entrypoint.
3. **P0-2 `setup` + `models suggest`** — turns the broken first-run (4 unresolved aliases, unfilled name/USER.md) into one guided pass.
4. **P0-4 `spect new/trace`** — the only work-additive journey currently ends at "copy the template by hand"; scaffolding + traceability is low-risk and high-signal.
5. **P1-5 `brain` git + hooks** — closes backup/sync/rollback for all three homes and enables the automated pre-commit memory hook.
6. **P1-6 roster/edit/delegate** — makes the multi-agent identity layer actionable without inventing a runtime.
7. **P2-7/P2-8** — guarded restore/update composites and the convention pass (skills JSON, mode-consistent fallbacks, gate policy persistence).
