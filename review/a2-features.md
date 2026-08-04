# New Features & Capabilities Review - `@tomaili/agent` (agent-cli v0.2.1)

**Lens**: New features and capabilities - what does the product look like today, and what high-value capabilities are missing or half-built?
**Scope read**: the full `src/` tree (`cli.js`, `store.js`, `config.js`, `pointer.js`, `targets.js`, `blocks.js`, `agents-lib.js`, `archetypes.js`, `identity.js`, `fields.js`, `models.js`, `lessons-lib.js`, `consolidate.js`, `snapshot.js`, `spect.js`, `seed.js`, `npm-check.js`, `detect.js`, `util.js`, `commands/target.js`, and the integrated `src/skills/**`).
**Prior art**: `review/a1-session-flow.md` (brief/session contract), `review/a4-automation.md` (SDK/MCP/protocol), `review/a6-skills.md` (skill ecosystem). Security/correctness defects in `PROJECT-ANALYSIS.md` are **not re-reported**. This report is the product-feature layer on top of both.

---

## Summary

The current feature surface is genuinely strong for a config manager:

- **Canonical master + pointer stubs**: `init`/`link`/`unlink`/`status`/`pull`/`where`/`target` (`src/cli.js:190-572`, `src/pointer.js`, `src/targets.js`). 16 agent targets, per-project scope, Cursor/Windsurf transforms.
- **Identity/soul/user memory files**: archetypes, tag-based field gaps, onboarding, `brief` load manifest (`src/agents-lib.js:27-54`, `src/fields.js`, `src/archetypes.js`, `src/identity.js`).
- **Lessons + consolidation**: occurrence-based memory, inbox/triage, promote/prune core (`src/lessons-lib.js`, `src/consolidate.js`).
- **Models aliases, SPECT scaffolding, snapshots/restore, staged seed updates, doctor, brief** (`src/models.js`, `src/spect.js`, `src/snapshot.js`, `src/seed.js`, `src/cli.js:1280-2106`).
- **Integrated skill manager** (`src/skill.js`, `src/skills/**`).

**Thesis**: This is a *single-machine, single-operator* brain. The leap from "config manager" to "agent-enablement platform" requires four things that are entirely absent today: **(1) multi-machine/team sync**, **(2) machine-local files + a secrets store** (so the shared brain can safely travel), **(3) SPECT as an executable workflow** (today it is scaffolding only), and **(4) retrieval** (search over the memory you already store). Everything below is concrete, with commands, rationale, and file anchors.

---

## HIGH priority - new capabilities

### H1. Git-backed brain sync (`agent sync` / `agent brain`) - the keystone

**Why**: `~/.agents` is a personal brain with zero portability story. Snapshots (`src/snapshot.js`) are local copies. There is no multi-machine, multi-team, or backup-to-remote story. For people who "work heavily with AI coding agents" (multiple machines, laptops + desktops, teammates sharing conventions), this is the single most valuable missing capability - and it compounds every other feature: lessons learned on machine A should be on machine B; team conventions should be shared without hand-copying files.

**Behavior**:
- `agent sync init [--remote <git-url>]` - `git init` inside `~/.agents` (or a `~/.agents/.brain` bare-repo overlay), write a default `.gitignore` (see H2/H3 for the exclusion policy), first commit.
- `agent sync push` / `agent sync pull` / `agent sync status` - with structured JSON, merge-conflict-safe (see below), and `agent sync auto on` to commit on every mutating command.
- `agent sync log` / `agent sync diff [<commit>]` / `agent sync rollback <commit>` - the versioning/diff/rollback UX that memory actually needs.
- `agent sync team add <team> [--remote ...]` - optional team overlay (H4), or just document the `remote` flow first.

**Design notes**:
- **Default exclusion policy** (the subtle part): `config.json` (per-machine target enables, npm cache - `src/config.js`), `ENVIRONMENTS.md` (machine-specific), `backups/`, `.consolidate-state.json`, and the new secrets store must be excluded by default. Pointer stubs are not stored in the brain (they live in `~/.claude`, etc.), but the master IS, so **re-link after pull**: add `agent sync pull` → auto `agent link` hook, because pointers embed absolute `master-abs:` paths (`src/pointer.js:12-36`).
- **Merge strategy**: markdown brain files are merge-friendly, but `config.json` and `LESSONS.md` core can conflict. Plan: file-level conflict detection with `agent sync status` reporting `conflict:<path>` and a `--take local|remote` resolver rather than raw git merge leaves. Start with "most recent mtime wins per file" as the safe default and surface conflicts explicitly.
- **Where it slots in**: new `src/sync.js` + `src/commands/sync.js`, wired in `src/cli.js`; `config.json` gains `sync: {remote, autoCommit, excluded, lastPull}`; post-`link`-style hooks already exist conceptually in `brief`'s suggested actions (`src/cli.js:1920-1936`).

**Priority: HIGH. This is the product-defining feature.**

### H2. Machine-local files + encrypted secrets store (`agent secret`, `agent env`)

**Why**: A shared/synced brain makes *machine-local* data a first-class concern. Two concrete pieces are missing and both are cheap to build with Node built-ins:

1. **`agent env capture`** - ENVIRONMENTS.md is seeded (`src/archetypes.js:156-187`), inventoried with gap detection (`src/fields.js:8-19`), but has **no command to fill it**. Autodetect OS/arch/shell/home + parse `~/.ssh/config` aliases (`src/archetypes.js:171-176` already tells the agent to do exactly this by hand) and write them into the Local/Remote sections. Keeps the "where do I run commands" knowledge fresh, and it is the natural counterpart to sync (capture, then exclude).
2. **`agent secret set <name> --value|-` / `agent secret get <name>` / `agent secret list` / `agent secret rm <name>` / `agent secret env`** - an AES-256-GCM store in `~/.agents/.secrets.json` (and `[cwd]/.agents/.secrets.json` for project scope) with a `0600` key file `~/.agents/.secrets.key`. Never synced, never printed by `agent files`/`brief` (redact paths and count only). `agent secret env` emits a safe env-file for CI; `brief` reports `secrets: {missing: [...]}` by name when a referenced secret is absent.

**Why**: Any real agent system accumulates tokens/keys, and today the only options are plaintext in the brain (which sync would then leak) or the user improvising. Encrypted secrets + a sync exclusion policy turn the brain into something you can put on GitHub.

**Where**: new `src/secrets.js` (uses `node:crypto` - currently only used for skill hashing, `src/skills/commands/update.js:202-223`), new `src/env-capture.js`; CLI registration in `src/cli.js`; exclusion policy in H1's sync module.

**Priority: HIGH (secrets are the enabler for H1).**

### H3. SPECT becomes an executable workflow (`agent spect task`, `agent spect report`, `agent spect validate`)

**Why**: SPECT is positioned as spec-driven development ("specify → plan → decompose → implement → verify → review", `src/spect.js:10-45`), but `spect init|status` only scaffolds directories and lists files (`src/spect.js:162-247`). The actual loop - tracking tasks, checking acceptance criteria, reporting progress - is **entirely unimplemented**. This is the most half-built high-value feature in the repo, and it is the piece that makes agent-cli a genuine development-workflow platform rather than a memory manager.

**Behavior**:
- `agent spect task list [--spec SPEC-01] [--status open|done]` - parse `tasks/*.md` checkboxes (`- [ ] TASK-001 [REQ-001] …` template, `src/spect.js:123-131`) into structured tasks with their linked REQ-IDs, spec, and plan.
- `agent spect task done <TASK-001>` / `agent spect task open <TASK-001>` - mark checkboxes by stable ID (not fragile prose).
- `agent spect validate` - cross-reference integrity: every `[REQ-XXX]` in a task exists in some spec's `REQ-XXX` acceptance criteria; every plan's `REQ → <test command>` maps to a spec REQ; flag orphan REQs (defined, never implemented) and dangling task REQs (implemented, never verified).
- `agent spect report [--spec SPEC-01] --json` - per-REQ acceptance-criteria coverage: `{req, spec, implemented: bool, verified: bool, verification, status: draft|implemented|verified|blocked}`. This is the **progress report agents can consume**; also fold the headline (`X/Y REQs verified`) into `agent brief` (currently `brief` only shows counts, `src/cli.js:1857-1869`, `src/cli.js:2073-2082`).
- `agent spect new <id> --spec <id> --plan <id>` - scaffold a TASKS file with the template, wiring spec/plan references in the header.

**Why**: turns `.spect` from a folder of templates into a closed feedback loop an agent can execute and verify, and gives `brief` a "what am I actually doing" view instead of just file counts.

**Where**: extend `src/spect.js` (it is deliberately pure/stateless - the perfect place for parsers + validators), new `src/commands/spect.js` or inline actions in `src/cli.js:1416-1452`.

**Priority: HIGH.**

### H4. Memory retrieval: `agent search` (and `agent lessons search`)

**Why**: The brain stores lessons whose filenames are the summaries (`src/cli.js:1870-1873`, `src/lessons-lib.js:109-140`), plus identity files, core pointers, and SPECT documents - but there is **no search primitive**. An agent must walk the filesystem or read filenames. `brief --for <task>` (proposed in a1) is a session-time fix; a durable, cheap retrieval command is the base layer for it.

**Behavior**:
- `agent search <query> [--kind lessons|identity|spect|all] [--project] [--limit 10] --json` - rank matches across `lessons/`, `LESSONS.md` core, `IDENTITY/SOUL/USER/ENVIRONMENTS`, and `.spect/`, returning `{path, score, excerpt, tokens, scope}`. Start with tokenized term frequency + filename scoring (no embeddings, no deps); an embedding provider can slot in behind the same contract later.
- `agent lessons search <query>` - scoped to lessons with per-file `{path, occurrences, marked, excerpt}`.

**Why**: retrieval is what turns stored memory into working memory. Cheap (pure JS), testable, and immediately useful to agents.

**Where**: new `src/search.js`; CLI `src/cli.js`; feeds the `brief --for` idea from a1 (which this report treats as its session-time companion, not a duplicate).

**Priority: HIGH.**

### H5. `agent update apply` - finish the staged-update migration path

**Why**: Seed updates are staged into `~/.agents/update-<version>/` for the agent to review and migrate (`src/seed.js:7-12`, `src/cli.js:1280-1411`), with `list`, `diff`, `stage`, `clear` - but **there is no apply**. The agent must copy files by hand. Half-built to the point of uselessness for the primary workflow it exists for.

**Behavior**: `agent update apply <version> [--file <rel>...] [--all] [--dry-run]` - copy each staged file over its live path **with a pre-copy backup** into `backups/update-<version>-<ts>/` (reuse `snapshot.js`'s copy primitives), refuse when the live file has diverged beyond the staged diff (`src/seed.js:229-264` already computes diffs), and emit a receipt `{applied, skipped, backedUp, diffStat}`. `--all` applies every file that is either new or byte-identical-to-backup; anything with local edits stays staged for human review.

**Why**: completes the only automated-upgrade story the tool has; without it, updates are permanently manual.

**Where**: extend `src/seed.js` (add `applyStaged()`), new CLI action in the `update` command (`src/cli.js:1290-1411`).

**Priority: HIGH (small, completes a broken loop).**

### H6. Snapshot/restore upgrade: file-level restore, retention, pre-mutation auto-snapshot

**Why**: `snapshot` copies the whole brain; `restore` wipes and restores everything with only a name-based selector (`src/snapshot.js:55-121`, `src/cli.js:1532-1578`). No way to restore one file, no retention (unbounded growth - flagged in a4 as F14), no diff preview before restore, no automatic safety net before destructive commands.

**Behavior**:
- `agent snapshots [--json]` gains metadata: `{name, age, files, size, source: manual|pre-mutation|scheduled}` (`.snapshot.json` already exists, `src/snapshot.js:61-64` - just surface it).
- `agent restore <name> [--file <rel>...]` - single-file restore; without `--file`, require `--yes` or print a preview `{willReplace: [paths], willDelete: [paths]}` and diff of the master.
- `agent snapshot --retain <n>` - prune to the newest N snapshots (config `snapshots.retain`).
- `agent snapshot --pre-command` mode + `snapshots.beforeMutate: true` config: automatically snapshot the brain before `consolidate`, `restore`, `update apply`, and `identity apply` (the mutating commands), giving every destructive action a rollback.
- `agent snapshot diff <a> <b> [--file rel]` - reuse `seed.diffLines` (`src/seed.js:229-264`).

**Why**: the building blocks (snapshot metadata, diffLines, timestamped dirs) all exist; this composes them into a real backup system that pairs with H1 (local snapshots are the coarse layer, git is the fine layer).

**Where**: `src/snapshot.js`, CLI actions in `src/cli.js:1532-1578`.

**Priority: HIGH.**

### H7. Agent-to-agent handoff (`agent handoff create|list|show|accept`)

**Why**: Personality templates already mandate a "Handoff" section (`src/agents-lib.js:189-190`), and the delegation model is central to the product's own instructions (`src/store.js:63-64`). But there is **no artifact** for handoffs: a delegated worker has no place to put "context, evidence, changed paths, open questions, risks" that the orchestrator can reliably find. It's a protocol with no wire format.

**Behavior**:
- `agent handoff create [--to <agent-name>] [--task ...] [--summary ...] [--files ...] [--questions ...]` - writes `~/.agents/handoffs/<ts>-<slug>.md` (or `[cwd]/.agents/handoffs/` for project scope) with structured sections and frontmatter `{from, to, task, status: open}`.
- `agent handoff list [--mine] [--status open|accepted|closed] --json` - inventory for `brief` (add `handoffs: {open: n}` to the brief payload, `src/cli.js:1938-1995`).
- `agent handoff show <id>` / `agent handoff accept <id>` (marks `status: accepted`, sets `acceptedBy/At`) / `agent handoff close <id>`.
- Pair with lessons: `agent handoff close --lesson <path>` files a learned lesson from the handoff.

**Why**: makes multi-agent delegation reproducible and observable, and turns the existing template language ("Return evidence, changed paths, and remaining risks") into a real artifact that `brief` and a supervising agent can see.

**Where**: new `src/handoff.js` (mirror `lessons-lib.js` structure, same containment/symlink discipline `src/lessons-lib.js:46-88`), CLI in `src/cli.js`, brief integration.

**Priority: HIGH for multi-agent workflows; MEDIUM if the product stays single-agent.**

### H8. Reproducible, governable skill packages (`skill.lock`, dependencies, provenance, publishing)

**Why**: The integrated skill manager has a strong local lifecycle, but its durable metadata is essentially `SKILL.md` plus a one-line `.source` file (`src/skills/lib/frontmatter.js`, `src/skills/lib/store.js`, `src/skills/commands/install.js:53-60`). Versions are displayed, but installs are not locked to an immutable commit/content hash, dependencies and conflicts cannot be expressed, and teams cannot publish or approve an exact package set. This blocks reproducible CI and serious team governance.

**Behavior**:
- `agent skill lock [--project]` - write `skill.lock` with canonical name, exact source, resolved revision/version, content hash, dependency graph, compatibility range, and approval state.
- `agent skill graph <name>` / `agent skill audit` - report `requires`, `conflicts`, missing capabilities, incompatible agent-cli versions, source drift, and unreviewed updates.
- Extend `SKILL.md` frontmatter with `requires`, `conflicts`, `capabilities`, `permissions`, `compatibility`, and optional configuration schema. Resolve dependencies before activation and explain conflicts rather than silently choosing.
- `agent skill publish [--registry <name>]` and `agent skill install <namespace/name>@<version>` - support internal or public catalogs, release notes, channels, and publisher identity.
- `agent skill vendor <name> -p` - pin an approved skill inside a repository for CI/project reproducibility while retaining the global store as a cache.
- Add a restricted execution profile for skills that ship scripts or tools: declared filesystem/network/process capabilities, explicit grants, and a no-execution default for instruction-only skills.

**Why**: Skills are the product's extension mechanism. A lockfile and package contract let individuals reproduce their setup, teams approve it, and a marketplace grow without making every install an untracked mutable dependency.

**Where**: extend `src/skills/lib/frontmatter.js` and `src/skills/lib/store.js`; add lock/dependency modules under `src/skills/lib/`; enhance `src/skills/commands/install.js` and `update.js`; replace `.source` with structured provenance while retaining backward compatibility; expose lock drift in `list`, `brief`, and `doctor`. See `review/a6-skills.md` for the deeper ecosystem review.

**Priority: HIGH.**

### H9. MCP server, hooks, watch mode, and an automation event bus

**Why**: Every capability is currently reached through a subprocess-oriented CLI. `brief --json` is a useful read endpoint, but there is no long-running API, MCP exposure, change notification, scheduler, Git-hook integration, or webhook surface. Agents and IDEs must repeatedly rediscover commands and poll state.

**Behavior**:
- `agent serve --mcp --stdio` and `agent serve --mcp --http <port>` - expose resources/tools for brief, identity inventory, personality discovery, memory search, skill metadata, SPECT next/check/progress, model resolution, doctor, snapshot planning, and handoffs.
- `agent watch` - monitor `~/.agents`, project `.agents`, `skill.config`, and `.spect`; refresh pointers/indexes and emit typed events such as `memory.changed`, `spect.blocked`, `skill.drift`, and `sync.conflict`.
- `agent hooks install --git` - install opt-in hooks for pre-commit SPECT validation, post-checkout project/profile refresh, and post-merge pointer/skill drift checks.
- `agent automation add <name> --event <event> --command <command>` plus `list`, `run`, `pause`, and `history`; add scheduled/cron triggers after the event contract is stable.
- `agent webhook add <url> --events ...` - send signed, redacted event payloads for Slack/Notion/GitHub/CI adapters rather than hard-coding every service into core.

**Why**: This is the clearest step from a file manager to a control plane. MCP makes the platform natively discoverable by coding agents; watch/hooks keep state current; events provide one stable seam for integrations and observability.

**Where**: first extract reusable command services from the large handlers in `src/cli.js`; add `src/mcp-server.js`, `src/watch.js`, and `src/automation.js`; reuse existing JSON payloads as the seed for versioned schemas; add automation health to `brief` and `doctor`. `review/a4-automation.md` contains the deeper protocol and SDK recommendations.

**Priority: HIGH, after service extraction.**

---

## MEDIUM priority - new capabilities

### M1. Composable project profiles and policy packs

**Why**: Project scope exists (`masterPaths("project")`, `projectTargets` per-root config `src/config.js:160-226`, `projectAgentsDir`, `src/cli.js:104-119`) but is a bolt-on split across global `config.json`, project `.agents/`, `.spect`, and `skill.config`. A developer opening a new repo has no guided path, and there is no single portable object that reproduces a repository's target, personality, skill, model, memory, and SPECT policy.

**Behavior**:
- `agent project detect [--json]` - fingerprint the repo: `package.json`/`pyproject.toml`/`go.mod`/`Cargo.toml`/`Gemfile`, git remote/owner/name, detected agents with project support (`src/detect.js`), and emit `{framework, git, recommended: {profile, personalities, skills, spect}}`.
- `agent profile create <name> --from-current` / `agent profile list` / `agent profile diff <name>` - store reusable global profile packages containing target selection, AGENTS fragments, allowed/default skills, model alias intent, personality set, lesson scope, and SPECT policy.
- `agent project init --profile <name>` - scaffold `[cwd]/.agents/config.yaml`, project master and override files, `skill.config`, optional `.spect`, and project pointers. Profiles may `extend` other profiles and a team policy pack; project-local values win.
- `agent project status` / `agent project doctor` - show the fully resolved profile, provenance of each setting, target/pointer health, policy drift, and differences from global/team defaults.
- `agent profile export <name>` / `agent profile import <source>` - make a project agent setup portable across repositories and machines.

**Why**: This makes per-project agent configuration first-class and reproducible rather than a set of unrelated files. It is also the bridge from personal sync to team-standard policy packs.

**Where**: new `src/project.js` and `src/profiles.js`; generalize project state in `src/config.js`; reuse skill inheritance from `src/skills/lib/config.js:145-184`, agent override precedence from `src/agents-lib.js:90-133`, and project master helpers from `src/cli.js:104-119`.

### M2. Identity/personality bundle marketplace: `agent archetype export|import`, `agent template install`

**Why**: Identity archetypes (`src/archetypes.js`) and personality templates (`src/agents-lib.js:145-191`) are baked into the package; users cannot share, version, or install new ones. a6 covers the *skill* ecosystem; identities and personalities are a second, distinct market (and the seed mechanism already ships 4 personalities, `seed/agents/`).

**Behavior**:
- `agent archetype export <name>` - package IDENTITY.md + SOUL.md + associated personalities + a manifest into `identity-<name>.json` (or a directory) for sharing.
- `agent archetype import <source>` - apply a bundle non-destructively (stage into `~/.agents/update-<bundle>/` or a `--force` apply), validating against the field schema (`src/fields.js:21-43`).
- `agent template install <owner/repo>` - reuse the `npx skills` fetch machinery (`src/skills/lib/npx.js:53-107`) to pull personality/prompt template bundles into `~/.agents/templates/` without touching the skill store.
- `agent template list` - catalog installed templates with `agents new <name> --template <tpl>`.

**Why**: turns archetypes from a hardcoded list into a living ecosystem, and reuses proven fetch/update plumbing instead of inventing new.

**Where**: extend `src/archetypes.js` + `src/seed.js` (manifest JSON + staging reuse), new `src/templates.js`, CLI actions near `agents`/`identity`.

### M3. Complete the personality lifecycle: `agents rename|remove|export|import`

**Why**: `agents` supports list/show/new/validate/path (`src/cli.js:630-734`) but **cannot rename, delete, or move a personality**. A reusable-personality library needs lifecycle management (and `validate` already exists, so the primitives are there).

**Behavior**: `agent agents rename <old> <new>` (rewrite `name:` frontmatter + move file, warn on project-override collision `src/agents-lib.js:99-120`), `agent agents remove <name> [--yes]` (delete + scrub from `LESSONS.md` pointers if referenced), `agent agents export <name> [--to path]` / `agent agents import <path> [--scope]` (validates via `validateAgent`, `src/agents-lib.js:317-357`).

**Why**: cheap, rounds out an existing surface, and enables M2 bundles to include personalities.

### M4. Model alias lint/usage: `agent models lint`, `agent models usage`

**Why**: `models` supports list/set/resolve/write (`src/models.js`, `src/cli.js:935-1008`) and `agents validate` warns on unresolved aliases per-file (`src/agents-lib.js:327-342`), but there is no aggregate view: which aliases are used by which personalities, which aliases are unused, which categories have no alias at all, which critical aliases lack fallbacks (`src/models.js:71-89` stores them but nothing checks coverage).

**Behavior**:
- `agent models lint` - across all personalities: unresolved aliases (already computed in `findUnresolvedModels`, `src/cli.js:139-154`), unused aliases, empty categories, aliases without fallbacks for categories marked critical.
- `agent models usage` - `{alias → [personalities]}` reverse index, so renaming a model doesn't silently orphan personalities.
- `agent models test <alias> [--provider-url ...]` - optional connectivity probe (a tiny echo request to the alias's provider endpoint) that reports `{reachable, latencyMs, model}`. Best-effort; never blocks. This is the seed of the "model routing intelligence" the product should grow into.

**Why**: the routing story (categories, thinking, fallbacks) is ahead of its own tooling; lint/usage make it trustworthy.

**Where**: extend `src/models.js`, CLI actions in `src/cli.js:935-1008`, reuse `findUnresolvedModels`.

### M5. Session metadata + local stats: `agent session`, `agent stats`

**Why**: The brain tracks *content* but no *activity*. There is no record of when lessons were captured, how often consolidation ran, or how the brain grew. Local-only, privacy-safe usage analytics would answer "is this working" and feed future retention decisions.

**Behavior**:
- `agent session start [--task ...]` / `agent session end [--lesson ...]` - append `~/.agents/sessions/<ts>.json` `{startedAt, endedAt, cwd, repo, branch, task, filesTouched?, lessonsCaptured[]}`. `brief` surfaces the current session.
- `agent stats [--since 30d] --json` - from session files + snapshot history + `.consolidate-state.json` (`src/consolidate.js:41-54`): commands' brain-mutation counts, lessons added/week, core growth (`consolidate` metrics already exist, `src/consolidate.js:121-142`), snapshot count/size, per-agent drift events.
- Optionally log mutating CLI invocations to `~/.agents/.usage.jsonl` (opt-in via `stats.track: true`) - never any prompt content.

**Why**: turns the product into something you can observe and tune; pairs with M4 to become the analytics story.

**Where**: new `src/session.js` + `src/stats.js`, CLI in `src/cli.js`, brief integration.

### M6. `agent doctor` memory-integrity checks

**Why**: `doctor` checks master/pointers/skills/identity-files/npm (`src/cli.js:1580-1775`) but never the memory store: orphaned core pointers (a `LESSONS.md` pointer whose `lessons/<rel>` file was deleted - consolidation prunes files but does not clean core pointers, `src/consolidate.js:262-307`), broken lesson frontmatter, bloated inbox, `LESSONS.md` core over budget.

**Behavior**: new `doctor` checks: `lesson-pointer-integrity` (every `lessons/<rel>` reference in core resolves), `lesson-store-health` (unparseable frontmatter count), `core-budget` (core tokens vs `coreBudget`, `src/consolidate.js:17-22`), `inbox-age` (stale inbox items). Each emits an `issue` with an exact remediation command, matching the existing `checks[]`/`issues[]` shape (`src/cli.js:1589-1774`).

**Why**: memory corruption is silent today; a cheap scan closes the loop.

**Where**: `src/cli.js` doctor handler + a small `src/memory-check.js` (reuse `listLessons`/`parseFM`/`readCore`).

### M7. Quick identity: `agent whoami`

**Why**: Identity is stored across IDENTITY.md/SOUL.md/USER.md with tag fields (`src/fields.js:21-43`); there is no one-line "who am I" view. Trivial and high-signal for onboarding and for the agent's own self-orientation.

**Behavior**: `agent whoami [--json]` - name/role/mission/persona + soul variant + user prefs digest + `ENVIRONMENTS.md` local block + unresolved identity gaps (reuse `computeOnboarding`, `src/agents-lib.js:366-379`). A human one-liner and an agent-orientation object in one.

**Where**: CLI `src/cli.js` near `files`/`brief`; reuses existing readers.

---

## LOW priority - new capabilities

### L1. `agent export <target|format>` - per-tool migration bundles
`agent pull` adopts one native file into the master (`src/cli.js:1228-1256`); there is no reverse: exporting the master + personalities as a self-contained per-agent file (e.g. inline all personality files into a single CLAUDE.md for a tool that doesn't do pointers). Useful for tools not in `TARGETS` yet (`src/targets.js:29-170` is the extension point).

### L2. `agent lessons dedupe` / `agent lessons archive`
Consolidation is occurrence-based (`src/consolidate.js:243-307`) and cannot see that two lessons are the same topic under different filenames. `dedupe --plan` scores near-duplicate paths/headers (e.g. "git-rebase" vs "rebase-git"), proposes merges; `archive <path>` moves a lesson to `lessons/.archive/` instead of deleting. Medium value but low urgency once search (H4) exists.

### L3. `agent identity diff` - global vs project override awareness
`brief` emits global+project file pairs (`src/cli.js:1824-1847`) but never shows *what differs*. A `--diff` flag on `identity list`/`files` showing which fields the project overrides would prevent identity drift confusion.

### L4. Interactive onboarding wizard (`agent onboard wizard`)
`onboard suggest` emits one question + options (`src/identity.js:54-61`, `src/cli.js:911-933`). A TTY wizard (name → identity → soul → user prefs → env capture) using the already-bundled `@inquirer/prompts` would smooth first-run. Non-interactive `--json` stays the default for agents.

### L5. `agent brief` git/project context
Add `{git: {branch, remote, dirty, root}}` to `brief` (`src/cli.js:1938-1995`) via one `git status --porcelain`-style call. Cheap, and agents constantly need to know the repo state.

---

## Half-built features worth completing (consolidated table)

| Feature | Today | Gap | Completion path |
|---|---|---|---|
| SPECT | `init`/`status` only (`src/spect.js:162-247`) | No task tracking, validation, acceptance-criteria coverage, progress reporting | H3 |
| Seed updates | `list`/`diff`/`stage`/`clear` (`src/cli.js:1280-1411`) | No `apply`; migration is manual | H5 |
| Snapshot/restore | whole-brain copy + name restore (`src/snapshot.js:55-121`) | No file-level restore, no retention, no diff preview, no pre-mutation safety net | H6 |
| ENVIRONMENTS.md | seeded + gap-detected (`src/fields.js:8-19`) | No capture command; filled by hand | H2 |
| Models | aliases + fallbacks stored (`src/models.js:71-89`) | No lint/usage/test aggregate; routing intent untooled | M4 |
| Personalities | list/show/new/validate/path (`src/cli.js:630-734`) | No rename/remove/export/import | M3 |
| Lessons | add/show/inbox/triage/consolidate (`src/lessons-lib.js`) | No search, edit, archive, dedupe | H4, L2 |
| Doctor | master/pointers/skills/identity/npm (`src/cli.js:1580-1775`) | No memory-store integrity checks | M6 |
| Onboarding | one-question `onboard suggest` (`src/identity.js:54-61`) | No guided fill, no env capture, no wizard | L4 |
| Identity archetypes | hardcoded catalog (`src/archetypes.js`) | No export/import/marketplace | M2 |
| Brief | rich snapshot (`src/cli.js:1780-2106`) | No task-aware retrieval (`--for`), no session, no project context | H4, M5, L5 (a1 covers the contract layer) |
| Skills | full local lifecycle (`src/skills/**`) | No exact lockfile, dependency/conflict graph, immutable provenance, project vendoring, publishing contract, or restricted execution profile | H8; deeper detail in `review/a6-skills.md` |

---

## Recommended implementation order

1. **H1 + H2 together** (sync + secrets + machine-local exclusions) - the platform-defining pair; everything else benefits from a brain you can move and a place to put tokens.
2. **H3 SPECT execution** - highest *workflow* value, completely self-contained in `src/spect.js`.
3. **H4 search** - unlocks retrieval for everything stored; pure-JS, low risk.
4. **H5 + H6** - complete the two underdeveloped loops (update migration, backup/restore) with mostly existing primitives.
5. **H8 skill governance** - add lockfiles, dependency/provenance contracts, and project vendoring before growing a marketplace.
6. **M1 project profiles + H7 handoffs** - make configuration and active work portable at repository/session boundaries.
7. **H9 automation/MCP** - after extracting reusable services from `src/cli.js`, expose the platform as a control plane.
8. **Remaining M/L tier** - personality lifecycle, model lint, sessions/stats, doctor memory checks, and polish.

Dependencies: H1's exclusion policy needs H2's secrets path; H4's search index should exclude the same machine-local paths; M2/M3 bundles should be syncable by default (they're content, not config). The SDK-first refactor recommended in `review/a4-automation.md` is a prerequisite for cleanly implementing the higher-level surfaces (handoff, session, stats) without growing the `src/cli.js` monolith further.

---

## Bottom line

The product already owns the single-machine brain (memory, identity, pointers, skills). The missing features are the ones that make a brain *portable* (sync, secrets, machine-local files), *executable* (SPECT tasks/coverage, update apply, handoff artifacts), and *retrievable* (search). Those three moves - portability, executability, retrieval - are what turn a config manager into an agent-enablement platform, and every one of them is buildable on top of primitives that already exist in this codebase.
