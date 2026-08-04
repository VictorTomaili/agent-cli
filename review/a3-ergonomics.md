# Ergonomics & Usability Review: `agent` CLI (`@tomaili/agent` v0.2.1)

**Lens**: command-line ergonomics, discoverability, usability.
**Scope**: `src/cli.js` (commander program, 2127 lines), `src/commands/target.js`, `src/skills/**` commands, plus live probes of a fresh `init` in a temp home.

---

## Summary

The tool has strong bones: idempotent, JSON-everywhere, non-interactive-by-default, honest "never clobber" semantics, and genuinely good prose output in `doctor`, `brief`, and the skill-cli help. The single-source-of-truth mental model (~/.agents master + identity/memory files) is coherent and `brief` renders it well.

But the command surface is where it breaks down. **26 top-level commands with positional pseudo-subcommands, three different `init`s, two different scope defaults for the same `-g/-p` flags, and a help system that errors on basic invocation** add up to a high onboarding barrier for exactly the tool whose job is to reduce configuration friction. The most damaging findings are UX-level, not security: `agent` (bare) exits non-zero with a red `✗` on stderr, `agent help skill` fails, `agent skill --help` hides the real skill surface, and `init` human output tells you almost nothing about what it created.

Verified live (fresh `AGENT_CLI_HOME`):

| Probe | Result |
|---|---|
| `agent` (bare) | help printed, **exit non-zero**, stderr `✗ (outputHelp)` |
| `agent help` | help printed, exit 0, stderr `✗ (outputHelp)` |
| `agent help skill` | 4-line stub, **exit 1**, stderr `✗ (outputHelp)` |
| `agent skill --help` | commander stub; rich skill help only via `agent skill help` |
| `agent link --target bogus` | `✓ 0 linked, 0 up-to-date`, exit 0 |
| `agent --json badcmd` | JSON on stdout **and** plain-text `error:` leak on stderr |
| `agent link -g -p` | runs **both** scopes; `agent target -g -p` runs **only** project |
| `agent where -p` | targets are project paths but `master:` still reports global `~/.agents/AGENTS.md` |
| `agent edit models --print-path` | `Unknown kind: models` (no edit path for MODELS.md) |
| `agent brief` after fresh `init` | 0 targets enabled → **no suggestion to enable one**; gap hint cites `identity/soul/user set` which cannot fill `environments` fields |

---

## Findings by lens

### 1. Naming consistency and verb patterns

- **E1. Redundant command name** — `agent agents [action]` (`cli.js:631`) manages "personalities" whose description field is `description`, while the master template and seeds call them "sub-agents" (`store.js:62`, `seed/agents/*.md`). `agent agents` reads awkwardly; "personalities" vs "sub-agents" are never reconciled. Recommend renaming to `agent personas` with `agents` as an alias.
- **E2. Four different verb families, same shape** — sub-actions are positional args, not commander subcommands: `agents` uses `list/show/new/validate/path` (`cli.js:636-733`), `identity`/`soul` use `list/apply/set` (`cli.js:745-810, 821-867`), `user` uses `apply/set` (`cli.js:880-908`), `models` uses `list/set/resolve/write` (`cli.js:948-1007`), `lessons` uses `list/add/show/inbox/triage` (`cli.js:1061-1169`), `update` uses `list/diff/stage/clear` (`cli.js:1294-1410`). "apply" means *write an archetype* for `identity apply`, but *write the template* for `user apply` (`cli.js:765-795` vs `884-896`). "path" is a noun action on `agents` (`cli.js:681`) while `where` and `edit --print-path` provide the same capability elsewhere.
- **E3. Three different `init` commands** — `agent init` (bootstrap master, `cli.js:190`), `agent spect init` (`cli.js:1424`), and `agent skill init` (passthrough to skill-cli project config, `skills/cli.js:76`, `skills/commands/init.js:12`). Same verb, three unrelated meanings; a user who ran `agent init` will not guess `agent skill init` creates a `skill.config`.
- **E4. Hidden aliases** — `target` accepts undocumented `on|off` (`target.js:28`), skill accepts `ls|status|def|undef|info|rm|uninstall|browse|ui|add|defaults` (`skills/cli.js:63-100`). Some aliases appear in the skill HELP, some (`defaults` → `cmdActive`) only in code. `skill add` ≠ `agent lessons add` (same verb, different domain).
- **E5. `onboard` is a one-action command with a positional** — `agent onboard [action]` where only `suggest` exists (`cli.js:912-933`); it could simply be `agent onboard`.

### 2. Flag consistency

- **E6. Opposite scope defaults in one binary** — every `agent` command defaults to **global** and uses `-p` to opt into project (`link` `cli.js:351-360`, `edit` `cli.js:584`, `agents` `cli.js:672`, `lessons` `cli.js:1044`), but every skill command defaults to **project** and uses `-g` for global (`skills/commands/enable.js:6-7`, HELP text `skills/cli.js:33-35`). `agent target enable claude` = global; `agent skill enable foo` = project. The two halves of the same binary invert the flag's default.
- **E7. `-g -p` combined is inconsistent** — `agent link -g -p` pushes **both** scopes and deploys twice (`cli.js:357-360`); `agent target -g -p` silently lets `opts.project` win (`target.js:37`). Same flags, different multi-scope semantics.
- **E8. `--force` is overloaded four ways** — `link --force` overwrites **native content** (destructive, `cli.js:354`), `user --force` replaces an existing USER.md (`cli.js:876`), `update/doctor --force` refresh an npm cache (`cli.js:1285, 1585`), skill `remove -f/--force` skips confirmation (`skills/commands/remove.js:44`). A habit of passing `--force` for "just do it" is destructive in one command and harmless in another. The destructive meanings should be renamed (e.g. `link --overwrite`, `user --replace`) or at minimum flagged in help.
- **E9. `--file` is two different types** — `lessons triage --file <n>` is an **inbox index number** (`cli.js:1046-1047`), `update diff --file <rel>` is a **staged file path** (`cli.js:1287-1288`).
- **E10. `edit -p` vs `--print-path`** — `-p` means project scope (`cli.js:584`), `--print-path` means print the path (`cli.js:582`). `agent edit -p` does something a new user would not guess from the flag.
- **E11. Bare option declarations** — `target`, `link`, `unlink`, `pull`, `where` declare `-g, --global` / `-p, --project` with no description (`target.js:25-26`, `cli.js:351-352, 394-395, 1231-1232, 1261-1262`); `agent target --help` renders the flags with blank meaning.

### 3. Discoverability and help

- **E12. Bare `agent` is an error** — running `agent` with no args prints full help, writes `✗ (outputHelp)` to stderr, and exits non-zero (`cli.js:2108-2123`: the bare-run path throws a commander code the handler treats as an error). The first command a user types "fails". Same leak for `agent help` and `agent help <cmd>`; `agent help skill` additionally exits 1.
- **E13. The skill surface is hidden behind `--help`** — `agent skill --help` shows a 4-line commander stub ("Usage: agent skill [options] [args...]") with no subcommand list; commander intercepts `--help` at any position, so `agent skill list --help` shows the same stub instead of list help. The rich, well-grouped skill-cli help is only reachable as `agent skill help` (positional). The natural path hides the real surface (`cli.js:1458-1460` + `skills/cli.js:59-107`).
- **E14. Top-level help order** — 26 commands ordered `target, init, link, unlink, status, ...`: neither alphabetical nor onboarding-ordered. `target enable|disable` is the first line a new user sees; `init` (the actual entry point) is second, `doctor`/`brief` near the bottom.
- **E15. Per-action help is a wall of description text** — because actions are positionals, `--help` shows one long description plus every option in one flat list with no grouping: `models` (`cli.js:937-939`), `update` (`cli.js:1282-1284`), `lessons` (`cli.js:1041-1043`), `identity` (`cli.js:739`) each stuff 3-4 actions + 2-3 flags into the description. `agent lessons --help` lists `--file/--delete/--clear` with no indication they belong to `triage`/`inbox` specifically.
- **E16. `brief`/`doctor` teach well but miss the biggest step** — `doctor` issues carry exact fix commands (`cli.js:1597-1759`). `brief`'s `suggested` list (`cli.js:1920-1936`) covers init/link/consolidate/update/skills/models but has **no suggestion to enable a target** when `cfg.global` is empty — after a fresh `init` with 0 targets enabled, `brief` suggests only 4 model-set commands and never mentions `agent targets`/`agent target enable <id> -g`.
- **E17. `brief`'s gap hint is unactionable for environments** — the info-gap warning says "fill via agent identity/soul/user set <field> <value>" (`cli.js:2006, 2013`) but the reported gaps include `ENV_LOCAL_USER/OS/SHELL/HOME`, which live in ENVIRONMENTS.md and have **no `set` command** (there is no `agent environments` command at all). `agent edit environments` is the only path and is never suggested.
- **E18. `config.json` is undiscoverable** — `agent files` (`cli.js:1010-1037`) inventories AGENTS.md/SOUL.md/IDENTITY.md/USER.md/LESSONS.md/ENVIRONMENTS.md/MODELS.md/agents/ but not `config.json`, `backups/`, `update-*/`, or `.skill-cli/`. `agent where` shows only targets. No command prints the config path; `target enable` failures (e.g. corrupt config, `target.js:41`) reference it only implicitly.
- **E19. `status` default ≈ `--all` for new setups, and summary doesn't reconcile** — the visible filter keeps any target whose state ≠ `pointer` (`cli.js:456-464`), so right after `init` all 16 targets show even without `--all`. The summary counts only global-state buckets ("0 pointer · 6 absent · 0 stale · 0 native", `cli.js:482-496, 537-542`), leaving the 10 no-global rows visible on screen but absent from the count. `status` has no legend explaining `●`/`○`/`on`/`off` (unlike skill list, `skills/commands/list.js:34-35`).
- **E20. `where -p` reports the global master** — `emit({ command: "where", scope, master: MASTER_FILE, ... })` (`cli.js:1270`) hardcodes the global master even in project scope, while the target rows are project paths. Mixed scopes in one report.
- **E21. `link --target bogus` is a silent success** — `selectedTargets` filters unknown ids (`cli.js:156-162`), so `agent link --target bogus` prints `✓ 0 linked, 0 up-to-date` and exits 0. (Correctness aspect is covered elsewhere; ergonomics: the success message actively misleads.)

### 4. Mental model of `~/.agents`

- **E22. The layout is coherent; the master doesn't teach it** — `~/.agents` = AGENTS.md + IDENTITY/SOUL/USER/LESSONS/ENVIRONMENTS + MODELS.md + agents/ + config.json + backups/ + update-*. `brief` renders this well ("Load at session start (global → project override)"). But the seeded master (`store.js:54-85`) never mentions any of the other files — the file that is supposed to orchestrate the brain doesn't link to it. A user reading the master alone learns nothing about IDENTITY.md or MODELS.md.
- **E23. Vocabulary overlap** — "personalities" (`agents` cmd), "identity archetypes" (`identity`), "soul variants" (`soul`), "user", "lessons", "environments" plus two scopes (global/project) = seven "who the agent is" dimensions. `brief`'s "(proj)" suffix and `agent files`' scope-aware listing help, but the top-level help gives no one-line map of the file set (only `files` says "unified identity/memory file inventory").
- **E24. Three overlapping health commands** — `status` (pointer health), `doctor` (deep checks), `brief` (session state) all recompute master/pointer/skill state. Nothing tells the user when to prefer which (`brief` for agents, `doctor` for humans, `status` for quick glance is only inferable).

### 5. Onboarding curve

- **E25. `init` human output is nearly silent** — after a fresh init the user sees only: `✓ Master ready ... Pointers: 0 linked, 0 global targets enabled. Next: run agent brief ...` (`cli.js:305-325`). No mention of the 5 identity files created, MODELS.md, 4 seeded personalities, the skill store, or that 16 targets exist. The full inventory is JSON-only (`cli.js:252-303`). A user cannot tell what happened or why "0 linked" is OK.
- **E26. No guided entry point** — nothing anywhere says "run `agent init` first"; the only pointer is `doctor`'s issue text when the master is missing. `agent` bare shows a wall of commands.
- **E27. First-run `brief` is noisy** — 7 gray "(missing)" project-scope rows (normal, since project scope is optional) plus 4 unresolved-model warnings and an info-gap block compete for attention; a first-run user sees more warnings than guidance.
- **E28. No-op `--yes`** — `init --yes` is documented as a no-op ("agent-cli never prompts", `cli.js:196-199`). Surface noise.

### 6. Missing convenience commands

- **E29. No shell completion** — no `completion` command, no `--generate-completion`, nothing in package.json `bin` for shells. For a dotfile tool with 26 commands + nested action verbs, tab completion is the single highest-ROI convenience missing.
- **E30. No `agent version` subcommand** (only `-v/--version` flag; `agent version` → "unknown command", exits non-zero).
- **E31. No config introspection** — see E18: no `agent config` to print/validate the effective config.
- **E32. No `edit models` kind** — `agent edit models --print-path` → `Unknown kind: models. Use: agents|soul|identity|user|lessons|environments` (`cli.js:580-596`); MODELS.md is only reachable via `models set/write`. Asymmetric with the other five memory files (the test `cli.test.js:607` documents this as intentional — but from the user's seat, `edit` advertises 6 of 7 brain files).
- **E33. No one-shot upgrade** — `update` provides list/diff/stage/clear but no composed `upgrade` that applies staged seeds + re-links; migration is deliberately agent-mediated (a design choice), but a human has no single "take me to the latest" path.

### 7. Human-readable output quality

- **E34. Strong points** — colors (`c`/`log`, `util.js:23-35`), `✓/✗/!` glyphs, tilde-shortened paths (`pretty`, `util.js:80-87`), truncation in skill list (`skills/commands/list.js:31`), per-line next-step hints in `doctor`/`brief`/`skill` HELP, and skill HELP's grouping + TTY-only annotations (`skills/cli.js:19-57`). `brief`'s load manifest with scope precedence is genuinely useful.
- **E35. Errors**
  - JSON mode leaks plain text: `agent --json badcmd` writes `error: unknown command 'badcmd'` to stderr **and** the JSON envelope to stdout; the JSON `error` string itself carries commander's `error:` prefix (`"error": "error: unknown command 'badcmd'"`). AI/CI consumers that merge streams get non-JSON.
  - `doctor`'s column pad (`cli.js:1765-1767`) breaks for `file-exists:environments` (22 chars > padEnd 20).
  - `agent files`/`brief` rows misalign once kind labels exceed pad widths (e.g. `environments (proj)`).
  - `skill list` header reads `skill list — project: (global)` (`skills/commands/list.js:13`) — "project:" showing "(global)" is confusing.
  - `agent agents show` dumps raw file content with no header/path context (`cli.js:654-666`); the user can't tell which file they're viewing.
  - Skill HELP leaks an internal test hint: `Test (no real ~ touched): SKILL_CLI_HOME=/tmp/sktest skill init -g` (`skills/cli.js:52`).
  - `agent targets` human mode omits the `docs` URLs that JSON carries (`cli.js:552-571`) — no path to the official docs for a given agent.

---

## Prioritized ergonomics improvements

### P0 — fix before next release (first-run and help correctness)

1. **Bare `agent`, `agent help`, `agent help <cmd>`: print help, exit 0, no stderr leak.** In the catch handler (`cli.js:2108-2123`), treat `commander.help`, `commander.helpDisplayed`, and the bare-run path as success (exit 0, silent). Add a test asserting empty stderr + exit 0 for `agent`, `agent help`, `agent help <cmd>`, `agent --help`.
2. **Make `agent skill --help` and `agent help skill` surface the real skill surface.** Easiest: in the `skill` command, intercept `args` containing `--help`/`-h`/`help` and delegate to the skill CLI's rich HELP (exit 0). Registering real commander subcommands for `list/active/show/cat/install/enable/disable/update/remove` (with descriptions) is the deeper fix — it also enables `agent skill list --help`.
3. **`init` human output must summarize the work.** Print created identity files, MODELS.md, seeded personalities, skill store, and detected targets (the JSON `result.steps` is already computed, `cli.js:252-303`); when 0 targets are enabled, add `Next: agent targets` / `agent target enable <id> -g`.

### P1 — high-impact consistency fixes

4. **Reconcile scope defaults.** Either make skill's `-g` mirror agent's global-default (project opt-in via a flag), or state the default explicitly in every help line ("default: global" / "default: project"). At minimum document the flip in the top-level `skill` description.
5. **Make `-g`/`-p` mutually exclusive everywhere** (`link`/`unlink` should error on `-g -p`, matching `target` — or `target` should also run both). One rule per flag pair.
6. **Disambiguate destructive `--force`.** Rename `link --force` → `--overwrite` and `user --force` → `--replace` (keep `--force` as alias with a "destructive" tag in help), leaving `--force` for cache-refresh/skip-prompt meanings.
7. **Rename `--file` on `lessons triage`** → `--index` (number) to disambiguate from `update diff --file` (path).
8. **`brief` suggestions must include target onboarding** — when `cfg.global` is empty, suggest `agent targets` and `agent target enable <id> -g`; and fix the gap hint to mention `agent edit environments` for environment fields (E17).
9. **`link --target <unknown>` must error** listing known ids (or at least warn + exit non-zero) instead of `✓ 0 linked`.
10. **`where -p` should report the project master** (`masterPaths(scope)` instead of `MASTER_FILE`, `cli.js:1270`).

### P2 — discoverability and output quality

11. **Per-command help with action groups.** Since actions are positionals, append an "Actions" block to `--help` output for `agents/identity/soul/user/models/lessons/update/spect` listing each action + its flags (e.g. `apply <id> [--soul <v>]`). This converts the description-wall (E15) into actionable help.
12. **Reorder top-level help** — `init` first, then a "View state" group (`status/doctor/brief/files/targets/where`), then mutation groups; or add a `Quick start: agent init` banner at the top of the help text.
13. **`status` fixes** — add a legend for `●/○/on/off`; make the summary count reconcile with displayed rows (include or explicitly exclude no-global targets).
14. **Silence JSON-mode stderr** — suppress commander's own error emission before throwing (`program.configureOutput({ writeErr })` or `exitOverride` + `error()`), and strip the `error:` prefix from JSON error strings.
15. **`agent config` command** — print `config.json` path + effective global/project settings (JSON + human), satisfying E18/E31; also surface `config.corrupt` (see prior analysis).
16. **Add `models` to `agent edit` kinds** (open MODELS.md; a "managed" file so write-through is safe) — closes the edit asymmetry (E32).

### P3 — polish

17. `agent version` subcommand; `agent targets` human mode shows `docs` URLs; `agent agents show` prints a header (`# name — path`); `doctor` column padding; fix `skill list` "project: (global)" wording; drop the `SKILL_CLI_HOME=/tmp/sktest` test hint from user-facing skill HELP; rename `agents` → `personas` (alias `agents`); remove `onboard`'s useless `[action]` positional.

---

## New convenience capabilities / commands

1. **`agent` (bare) → guided quick start (TTY) / minimal primer (non-TTY).** If `~/.agents` is uninitialized, print a 6-line primer: `agent init`, `agent brief`, `agent doctor`, `agent target enable <id> -g`, `agent edit`. Exit 0 either way. Replaces the current help-wall + stderr error.
2. **`agent doctor --fix`** — apply the auto-fixable items from the existing issues list (`agent init` when master missing, `agent link` for stale pointers, `agent skill setup` when unavailable), skipping anything destructive; re-run checks and show a before/after delta. `doctor` already computes every needed command string (`cli.js:1597-1759`); this is mostly plumbing.
3. **`agent completion bash|zsh|fish|powershell`** — commander ships the machinery (`program.configureOutput` + a generated script or a static completion file); also register a `complete` command so `agent <TAB>` works across the 26 commands and the positional action verbs (`list|show|new|validate|path`, etc.).
4. **`agent config`** — print `config.json` path + effective config (E18); `agent config edit` opens it; `--json` for agents.
5. **`agent environments set <field> <value>`** — completes the `set` family so every memory file (IDENTITY/SOUL/USER/ENVIRONMENTS) has a `set` verb; `brief`'s gap hints then become executable as written.
6. **`agent edit models`** — add the `models` kind to `edit` (P2.16).
7. **`agent scaffold` (interactive, TTY-only; JSON for agents)** — one walkthrough: `init` → checkbox to enable targets (grouped by "installed/available") → identity quick-set (name/role) → `brief`. This is the missing guided onboarding (E26) and can reuse `computeOnboarding`/`onboardSuggest` (`cli.js:1816-1823`, `identity.js`).
8. **`agent upgrade`** — compose `update list` → `update diff` review → `update clear` + `link` + `skill refresh` into one non-destructive "take me to latest" command (human-confirmed migration stays the default; `--yes`/JSON for agents).
9. **`agent brief --oneline`** — a one-line status for shell prompts/CI (`✓ 2/3 pointers · 0 drift · skill 0.2.1 · 1 update`); cheap to derive from the existing `out` object (`cli.js:1938-1995`).
10. **`agent link --dry-run`** — preview which targets would link/block/overwrite without writing; complements `doctor` and makes `--overwrite` (P1.6) safer to reason about.

---

*Methodology note: findings are from static reading of `src/cli.js`, `src/commands/target.js`, `src/skills/**`, `src/store.js`, `src/agents-lib.js`, `src/util.js`, `src/skill.js`, `test/cli.test.js` plus live CLI probes against a fresh `AGENT_CLI_HOME`. Security/correctness issues already in PROJECT-ANALYSIS.md (e.g. HIGH-2, M7, M8, M10, GAP-12/13) are referenced only where the ergonomics angle adds new information and are not re-reported.*
