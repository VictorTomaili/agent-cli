# Skill Ecosystem & Extensibility Review: `@tomaili/agent` skill manager

**Lens**: skill lifecycle UX, START GATE usability, third-party authoring/publishing, integration with identity/lessons/brief, and skill discovery.
**Scope**: `src/skill.js`, `src/skills/**` (lib + 13 commands), the injected `AGENTS_BLOCK`, and the wiring in `src/cli.js` / `src/blocks.js` / `src/store.js`.
**Method**: static reading of every skill command + lib module, the gate injection path, tests (`skill.test.js`, `skill-install.test.js`, `skill-update.test.js`, `skill-ux.test.js`, `skills-config.test.js`), and the adjacent session-flow review (`review/a1-session-flow.md`). Runtime execution was attempted but Node startup on this box exceeds 60s, so all findings are static (they are all text-level, so static evidence is sufficient).

This report intentionally does not repeat the security/correctness findings already catalogued in `PROJECT-ANALYSIS.md` (traversal, concurrency, supply chain, JSON wrapping, silent catches, frontmatter type gaps). Where a finding here touches one of those, it is cited as prior art and the focus is the UX/ecosystem consequence.

---

## Summary

The skill subsystem is a clean, well-tested mechanical core: a global store (`~/.skill-cli/store`), an activation model (project allow/deny + global default), an idempotent gate block injected into the master AGENTS.md, a working interactive manager, and a provenance-based update (`update.js` hashes content, install records `.source`). The mechanics are solid; the ecosystem layer is absent.

Three structural gaps dominate:

1. **The START GATE is a prose contract, not a protocol.** The gate lives as ~900 words of imperative prose in `AGENTS_BLOCK` (`src/skills/lib/agents-md.js:13-69`), re-printed in the `active` command's stdout (`src/skills/commands/defaults.js:19-57`). Classification into correctness/quality vs cost/speed/style is the model's judgment from free-text descriptions, with "when unsure → PROPOSE" (`agents-md.js:57-59`). With no `axis` field, no params schema, no validation at install, and no persisted policy, a real agent either stalls the session asking about every ambiguous skill or is forced into the forbidden-skip patterns the block tries to outlaw. There is no machine-readable gate, no ack/remember primitive, and no resume state.
2. **Third-party authoring is undocumented and unvalidated.** A skill is a `SKILL.md` with 4 consumed frontmatter keys (`name`, `description`, `version`, `triggers`) — nothing else. There is no `skill new` scaffold, no validate command, no publish path (distribution is entirely delegated to the external `npx skills` / skills.sh ecosystem), no dependency or tool manifest, no sandbox, and no authoring docs in the repo (there is no README at all, per `PROJECT-ANALYSIS.md` L4/GAP-14). A publisher cannot test that their description satisfies the gate, because the gate's requirements exist only in text the agent (not the author) sees.
3. **Discovery is a thin wrapper over one external command.** `searchSkills` shells out to `npx -y skills find <query>` (`src/skills/lib/skills-find.js:38-50`); there is no local search, no recommendations, no result descriptions, no caching, no offline mode, and the result parser is brittle regex over the upstream's exact output shape (`skills-find.js:12-26`).

The lifecycle vocabulary is also confusing: `enable -g` and `default` are the same operation with two names; `disable -g` and `undefault` likewise; `skill defaults` (plural) is an alias for the *active* catalog (`cli.js:93`) while `skill default <name>` mutates; and the gate adds a sixth state ("loaded") on top of installed / passive / active / enabled / default / triggered.

---

## Skill-ecosystem usability findings

### 1. Lifecycle UX: overlapping verbs for the same state

**`enable -g` == `default`, `disable -g` == `undefault`.** Both mutate the same `config.yaml defaults` list:
- `enable -g`: `src/skills/commands/enable.js:17-23` pushes into `cfg.defaults`.
- `default`: `src/skills/commands/defaults.js:64-83` pushes into `cfg.defaults` (and prints the same "active + auto-load" message).
- `disable -g`: `disable.js:9-16` filters `cfg.defaults`.
- `undefault`: `defaults.js:86-99` filters `cfg.defaults`.

Two command pairs, one state machine. The help screen (cli.js:32-40) presents "Activation" and "Defaults (active + auto-load)" as separate concepts, so the duplication is not obvious.

**`skill defaults` (plural) is an alias for `active`/`status`** (`cli.js:93`), i.e. it lists the *active* catalog, not the skills marked default. A user who types `skill defaults` expecting to see their default skills gets the active list; a user who types `skill default foo` sets a global default. Natural-language collision, zero affordance.

**Six distinct states, three of them user-facing with overlapping names.** Installed (passive) → enabled (project allow) → default (global, active + auto-load) → active (effective in cwd) → triggered (keyword resolved) → loaded (cat-ed this session, `agents-md.js:58-60`). `list` renders three glyphs (`● ○ ★`) plus a source column and triggers (`list.js:22-36`); the legend helps, but the *behavioral* difference between "default" and "enabled" — one is global, one is per-project — is the kind of distinction a new user discovers by accident (e.g. `skill enable -g` on one machine, then `skill disable` in a project silently adds a `deny` entry, `disable.js:23-26`).

**`default` is the gate's verb but not the help's primary verb.** `AGENTS_BLOCK` tells agents to use `agent skill default <name>` (`agents-md.js:24`), while the help's "Acquire skills → Activation" section points at `enable [-g]`. Same state, two idioms.

**Post-install friction.** `installSource` ends with "Skills are passive until enabled. Activate with: `skill enable <name>` or `-g`" (`install.js:77`). For a tool whose entire purpose is skills, the happy path is three steps (install → enable → [default]) and the only interactive shortcut (no-arg `install`) is gated on TTY (`cli.js:78-82`). No install-time prompt offering "enable in this project / make default / leave passive".

### 2. START GATE: usable in a human transcript, fragile as an agent protocol

**The instruction burden on the agent is very high.** `AGENTS_BLOCK` (`agents-md.js:13-69`) is ~800-1,000 words; the gate section alone bans six phrasings ("FORBIDDEN"), lists five "NOT asking" clarifications, and adds a second rule for parameters (`agents-md.js:50-55`). `cmdActive` then re-emits a condensed copy of the same policy in its stdout (`defaults.js:43-57`). Two copies of the same policy that can drift, and the agent re-reads it every session start. Instruction size is not the core problem, but it signals that the policy is being enforced by prose rather than by structure.

**Classification is delegated to the model with no schema.** The axis decision — correctness/quality vs cost/speed/style — comes from reading the description (`agents-md.js:31-39`, `defaults.js:40`). Findings:

- **Empty/missing descriptions break the gate.** `active` prints the description only when present (`defaults.js:40`); a skill with no description yields a bare name, and the fallback rule "When unsure → PROPOSE" (`agents-md.js:57-59`) forces the agent to ask "Enable X? It <one-line benefit>" with no benefit text. An installed-but-underspecified skill therefore produces a mandatory, unanswerable question on *every* session start — a genuine stuck-loop source. Nothing validates description presence at install (`store.js:27` silently skips unparseable skills on list; `install.js:40-45` never checks required fields).
- **Multi-axis descriptions ("improves quality and speed") always route to PROPOSE**, interrupting the user even when the skill is clearly relevant. There is no `axis:` frontmatter field to make this deterministic.
- **Per-message re-classification tax.** "on EVERY later message, re-run this classification" (`agents-md.js:62-64`) means message 50 of a session pays the same classification cost as message 1, for every active skill, with no CLI state to say which skills were already cat-ed ("Load each skill only ONCE per session" is a model-memory promise, not a CLI fact).
- **No session/project/CI policy.** There is no way to pre-answer "always ask only about cost", "never load style skills in CI", or "remember this choice". A spawned sub-agent or an autonomous run that hits a PROPOSE gate must stop and produce a user question. `a1-session-flow.md` (items 5, START GATE pain points 3-4) already flags the missing machine-readable gate and policy; the ecosystem-side fix is the `axis`/`params` schema (below) so classification stops depending on prose.
- **`--json` is silently ignored by skill subcommands.** The parent CLI wraps skill stdout in a JSON envelope (`cli.js:1509-1522`) only in parent JSON mode, but `active/show/list` accept and ignore unknown args (e.g. `defaults.js:12` takes no args), so an agent asking for structured data gets an ANSI text blob inside a JSON string. There is no structured gate output anywhere.

**One-question gate realism.** The proposed flow (ask all in one message, END turn, wait) is coherent in a chat transcript with a human. It is not coherent for (a) autonomous/headless runs, (b) spawned swarm agents, (c) sessions where the user's first message is a directive that cannot legally be started ("user has a clear request" is banned), or (d) trivial first messages ("hi") with a non-empty active set. The gate gives the agent no way to distinguish "user is at the keyboard" from "user is a CI pipeline".

### 3. Authoring / publishing / versioning / distribution: no ecosystem layer

**Format is 4 keys and nothing else.** `frontmatter.js` parses `name`, `description`, `version`, `triggers` (via `getTriggers`, `frontmatter.js:22-28`); `store.js:18-21` consumes those four. The skills.sh / vercel-labs standard this claims fidelity to (`frontmatter.js:3`) carries more (e.g. allowed-tools, license, metadata, id) — none consumed or validated here (grep for `allowed-tools|license|metadata|dependencies|requires|sandbox` in `src/skills/**` matches only the help text "metadata" at `cli.js:43`).

**No authoring tooling.** `skill init` creates the store/config or a project `skill.config` (`init.js:12-57`) — it does not scaffold a skill. There is no `skill new`, no template, no lint, no local preview, no way to author-test a description against the gate's requirements. The gate's author-facing requirements (one-line benefit, axis statement, activation options — `agents-md.js:31-55`) are documented nowhere an author can read them.

**No validation command.** `skill doctor` does not exist; `listStore` silently drops broken skills (`store.js:27`); `parseSkillMd` swallows malformed YAML (`frontmatter.js:11`); frontmatter type errors (name as number, description as object) are pre-reported (`PROJECT-ANALYSIS.md` GAP-6). A CI pipeline publishing a skill has no `skill validate --json` to gate on.

**Publishing = "go use skills.sh".** The CLI can install from `owner/repo | owner/repo@skill | github/gitlab URL | git URL | local path | npm package` (help, `cli.js:51`), but every source is handed to `npx -y skills add --copy --agent claude-code` (`npx.js:40-48`). There is no publish command, no version bump, no registry upload, no attestation. The "npm package" source format is whatever the external `skills` CLI supports, not something this code implements.

**Versioning is decorative.** `version` is display-only (`list.js:30`, `show.js:11`); update decisions use a content hash (`update.js:128,166`), not semver. There is no version pin (`owner/repo@skill` pins the *skill*, not a version), no lockfile, no changelog, and `skill update` reports "content changed" with no diff (the swap is staged/backed up at `update.js:132-162`, but the user never sees what changed). `skill remove` cleans config but nothing tracks which other projects hold dangling `allow` entries (`remove.js:38-42` acknowledges them as harmless).

**Dependencies, tools, sandbox: none.** A skill body is arbitrary text loaded into context; the store dir can contain helper files (fixtures carry `helper.js`, `skill-install.test.js:38`), but there is no manifest declaring what a skill needs or what tools it may invoke, no allowed-tools enforcement (the upstream ecosystem has this concept), and no read-only sandbox or trust boundary beyond "don't copy into agent dirs". For a system that tells the agent to treat skill bodies as instructions to *apply* (`agents-md.js:67`), that is a significant trust gap for the ecosystem story.

### 4. Integration with identity / lessons / brief

- **brief ignores skills.** `brief` collects `skillVersion()` (`cli.js:1789`) and a skill availability line, but the session load manifest (`cli.js:1824-1869`) contains identity, models, SPECT, and lessons — never active skills. The gate ritual and the brief plan are two separate session-start mechanisms that don't reference each other.
- **No identity tie.** `identity.js` manages archetypes/souls/sections; nothing lets a skill declare "requires identity archetype X" or lets an archetype pull a skill.
- **No lessons tie.** Skills can't capture lessons, lessons can't recommend skills, and `skill update` has no memory of which skills were modified so a "lessons about this skill" entry could be kept fresh.
- **No executable/tool-wrapper story.** `cat` dumps text (`cat.js:5-13`), `trigger` dumps text (`trigger.js:49-66`). There is no `skill run`, no bundled-script convention, no argv/parameter binding to a skill's declared params. Skills are prompt templates only — fine as a v1, but "reusable workflow packages" and "tool wrappers" are not expressible today.
- **The gate reaches only 4 of 8+ agents.** `AGENT_GLOBALS` (`paths.js:17-24`) covers claude, codex, gemini, pi; Cursor is explicitly "adapter later", and qwen/windsurf/cline/copilot from `TARGETS` (`targets.js:29-80`) get nothing. The package markets cross-agent support, but the gate silently doesn't exist for half the target agents.
- **Dead injection path.** `injectToAllAgents` / `injectToAgentGlobal` (`agents-md.js:79-101`) write the block into per-agent global files but have zero call sites in `src/`; the live path is `ensureBlocks` → master (`blocks.js:48-52`, `store.js:92-117`). The dead code encodes a competing design (per-agent injection) that, if ever wired, would duplicate the block that pointers already redirect to. Single-sourcing the gate text (one constant shared by master injection, `active` output, and any future per-agent adapter) would prevent drift.

### 5. Finding skills: one thin external wrapper

- **Remote only.** `searchSkills` execs `npx -y skills find <query>` with a 60s timeout and a strict query charset (`skills-find.js:32-57`). No local store search, no `--installed` filter, no fuzzy match on installed names (`cat foo` requires exact case-insensitive name, `store.js:51-60`).
- **Thin results.** The parser extracts `owner/repo@skill`, installs count, and a URL (`skills-find.js:12-26`); no description, version, license, recency, or author. Users pick a skill by installs count alone. The parser is also brittle: a format change upstream (spacing, ANSI variant, new column) silently yields zero results because non-matching lines are dropped (`skills-find.js:14`).
- **No recommendations or onboarding.** No curated starter set, no "suggest for task", no installs/relevance signal of this tool's own, no offline cache, and every search hits the network even when the query would match installed skills.
- **TTY gating is correct but coarse.** Non-TTY `install` with no source errors out (`cli.js:78-89`) instead of falling back to `search` non-interactively (top-N results), which would let agents discover skills too.

---

## Prioritized NEW capabilities (concrete behaviors)

### Phase 1 — make the START GATE a protocol (do these first; they unblock everything else)

1. **Frontmatter schema: `axis` and `params`.** Support `axis: correctness|quality|cost|speed|style` (repeatable) and `params:` (a map `name → {type, options[], default, question}`). `skill active` prints the axis and params machine-readably; the gate block changes from "classify from the description" to "read the declared axis". Skills with no `axis` are classified `unknown` and handled by policy (capability 4), never by unanswerable prose. Add `params` binding so "ask the user to choose options in the same proposal" (`agents-md.js:50-55`) has a concrete shape.

2. **Machine-readable gate: `skill gate` + `skill gate ack`.** Add JSON output to the skill CLI (a `--json` flag honored by every command, not ignored as today):
   - `skill gate --json` → `{state, proposals:[{name, axis, benefit, params, requiresUser, defaultPolicy}], next}`. Empty active set → `{state:"none"}` so agents proceed without a ritual.
   - `skill gate ack --enable X --params '{"level":"strict"}' --scope session|project|global --remember` persists answers. Human transcript mode stays as-is; autonomous agents get a one-turn protocol. This supersedes/coexists with the `a1-session-flow.md` proposal (item 5) and adds the persistence layer it lacks.

3. **Persisted gate policy + resume.** Store acknowledged proposals in `~/.skill-cli/policy.yaml` (or project `skill.config`), keyed by skill name + param selection. `skill gate status` reports pending vs answered. An interrupted session resumes without re-asking; a `--policy session|project|ci` flag lets CI pre-answer ("never load style skills", "ask only for cost"). This eliminates the repeat-ask loop and the "must end turn" stall for headless runs.

4. **Gate fast paths.** (a) Zero active skills → `skill gate` returns `none`, gate text says "skip". (b) Skills with missing/invalid descriptions are flagged at install (capability 8) and by `skill gate` as `unclassified`, so the model never asks "enable X? It …" with an empty benefit. (c) Replace "on EVERY later message, re-run classification" with "re-run only when the task changes domain or new skills activate" — cut the per-message tax and the instruction's FORBIDDEN list to a 3-line rule.

5. **Single-source the gate text.** One constant (e.g. `src/skills/lib/gate-policy.js`) feeds the master injection (`agents-md.js`), `cmdActive` output, and `skill gate` help, so the prose and the protocol can't drift. Delete the dead `injectToAllAgents` path or wire it deliberately per-agent with dedupe against pointers.

### Phase 2 — authoring & packaging (the ecosystem layer)

6. **`skill new <name> [--cwd]` scaffold.** Generates `SKILL.md` with a filled template (name, description, version, axis, params, triggers), a `README.md`, a `test/` dir with a smoke test, and a `skill validate` hook in the flow. `skill init`/`skill init -g` stay about the CLI; scaffolding moves to `skill new`.

7. **`skill validate <path|name> --json` (and run at install).** Checks: required `name`/`description`; safe name (reuse `sanitizeSkillName`); `axis` values in the allowed set; `params` schema shape; description ≤ N chars and contains a one-line benefit sentence; triggers normalized; version semver-or-warn. Install rejects or warns (`--strict`) on failure instead of silently accepting (`store.js:27` silent skip today). Expose as CI-exit-code lint.

8. **`skill package` + `skill publish` (or documented skills.sh bridge).** `skill package` builds a distributable dir (SKILL.md + assets + `skill.yaml` manifest) and prints the `owner/repo@skill` source string; `skill publish` shells to the upstream publish command with provenance (commit/ref) so `update` can show diffs. At minimum, document the exact publish path and gate the README on it.

9. **Manifest & dependency handling.** `skill.yaml` (or extended frontmatter) declares `dependencies:` (skill sources or names to auto-install), `tools:`/`allowed-tools:` (displayed by `skill show` and enforced by the gate's `requiresUser`), and `sandbox: read-only|tools` hint. Install resolves transitive deps with a cycle check and records them in the lockfile.

10. **Real versioning + update UX.** Semver-aware `version`; `skill pin owner/repo@<version>`; a store lockfile `~/.skill-cli/lock.json` (`{name, version, source, sha256, installedAt}`); `skill update --dry-run` prints a per-file diff summary before applying; `skill update` writes a receipt (`before/after version, files changed`). This turns today's silent hash-swap (`update.js:128-166`) into an inspectable operation.

### Phase 3 — discovery & trust

11. **Local search + richer remote results.** `skill search <q>` searches the installed store first (name/description/triggers), then falls back to the network with results cached for N hours and an `--offline` mode. Parse description/version/license when upstream provides them; fail loudly (not zero results) when the upstream format changes.

12. **Recommendations + starter catalog.** `skill suggest --task <text>` ranks installed + catalog skills by keyword overlap and returns one-line reasons. `agent init` / `skill install --starter` offers a curated "first skills" set so an empty store doesn't dead-end new users at "Store empty. First: skill install <source>" (`list.js:18`).

13. **Provenance/trust display.** `skill show` prints source, version, installed-at, hash, license (if declared), and a first-install warning for unknown `owner/repo` ("skill runs as instructions on every session — verify the source"). `skill cat` adds `<!-- source: owner/repo@skill vX -->` provenance (today only `<!-- skill: name -->`, `cat.js:10`).

### Phase 4 — integration & surface cleanup

14. **Wire skills into `brief`.** `brief` gains `skills.active` (name + axis + one-line description + estimated tokens) in `sessionStart.load` and a `gate.state` field, so the session plan and the gate agree. `brief --gate` returns pending proposals.

15. **Per-agent adapter for the gate.** Implement the Cursor `.mdc` (`targets.js:72-80` transform exists; `paths.js` needs a cursor entry) and add qwen/windsurf/cline/copilot entries, so the gate actually reaches the marketed agent set. Use capability 5's single-sourced text.

16. **Executable skills.** `skill run <name> -- <args>` executes a bundled `SKILL.tool.js` in a temp cwd with a declared tool allowlist and prints structured output — the "tool wrapper" primitive. Until then, document the contract explicitly ("skills are text; `cat`/`trigger` load, nothing executes") so expectations are honest.

17. **Lifecycle UX cleanup.** Merge `enable -g`/`default` and `disable -g`/`undefault` into one canonical verb each (keep the other as an alias); change `skill defaults` (plural) to list default-marked skills instead of aliasing `active`; add a TTY prompt at end of `install` ("enable here / make default / leave passive") instead of the passive wall (`install.js:77`).

18. **Skill ↔ lessons loop.** `skill capture <name>` appends a lesson file about a skill (scope, version, trigger); `skill update` bumps the captured lesson's `lastSeen`; `brief` surfaces "skill X changed since your lesson about it".

---

## Suggested implementation order

1. Capabilities 1-5 (gate protocol + schema + policy + single-source text): smallest change, largest agent-usability gain, and it makes the existing gate text honest.
2. Capabilities 6-7 (scaffold + validate): the minimum a third-party author needs to participate; also kills the unanswerable-description loop at the source.
3. Capabilities 8-10 (package/publish, manifest, versioning/update UX): turns skills into distributable artifacts with trust boundaries.
4. Capabilities 11-13 (search, recommendations, provenance): makes discovery safe and useful.
5. Capabilities 14-18 (brief wiring, agent coverage, executable skills, UX cleanup, lessons loop): cross-subsystem payoffs.

Everything in Phase 1 is a behavior change to existing commands; nothing requires new infrastructure. Phases 2-3 are the difference between "a good manager for skills.sh" and "a skill ecosystem".
