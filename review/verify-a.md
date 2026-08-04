# Verification Report — AGENT-EXPERIENCE-REVIEW.md (Tier 1 + Tier 2, plus high-impact Tier 3 anchors)

Method: every file/line anchor in the report was opened and read; behavioral claims (exit codes, JSON payloads, ANSI leaks) were re-run live against `node src/cli.js` with a temp `AGENT_CLI_HOME`. No source files were modified.

## Tier 1 — Product-defining capabilities

| Claim (short) | Anchor | Verdict | Evidence |
|---|---|---|---|
| `brief` `suggestedActions` are free-form shell strings, no IDs/priority/safety/deps | `src/cli.js:1920-1936` | CONFIRMED | `const suggested = []` then `.push("agent onboard suggest")`, `agent pull ${id} && agent link ${id}`, `npm i -g ...@latest` etc. Plain string array. |
| Pointers embed absolute `master-abs:` paths | `src/pointer.js:12-36` | CONFIRMED | `pointerLines()` emits `<!-- master-abs: ${masterAbs} -->` / `master-tilde` (lines 19-20); parser validates them (80-81). |
| ENVIRONMENTS.md is seeded template with no fill command; agent told to fill by hand | `src/archetypes.js:156-187` | CONFIRMED | `environmentsContent()` is a static template with empty `User:/OS:/Shell:` fields and prose "Keep this current — the agent uses it… Update whenever…". No `env capture`/filler exists anywhere in src. |
| SPECT "claims spec-driven development" but only scaffolds dirs and lists files | `src/spect.js:10-45` | CONFIRMED | 10-45 is the README template describing the specify→verify workflow. File exports only `initSpect` (scaffold) and `inspectSpect` (list); no task parse/validate/report. |
| `tasks/*.md` checkbox format `- [ ] TASK-001 [REQ-001] …` exists | `src/spect.js:123-131` | CONFIRMED | tasks.md template at 123-131 is exactly `- [ ] TASK-001 [REQ-001] <task>`. (No parser exists yet — claim is a proposal anchored on the template; format is correct.) |
| SPECT has only `init|status` | `src/cli.js:1414-1452` | CONFIRMED | Handler dispatches only `init`/`status`; else `fail("Unknown action: … Use init|status")` (1451). |
| `brief` runs npm update check and mutates config | `src/cli.js:1793-1795` | CONFIRMED | `ensureUpdateCheck(cfg,…)` then `if (upd.refreshed) await saveConfig(cfg)` — a read command writes config + hits network. |
| `package.json` `main`/`exports` point at the bin, nothing callable as a function | `package.json` | CONFIRMED | `main: ./src/cli.js`, `exports: {".":"./src/cli.js","./targets":"./src/targets.js"}`, `bin: {agent: ./src/cli.js}`. No API module. |
| START GATE reaches only 4 of 8+ agents (`AGENT_GLOBALS`) | `src/skills/lib/paths.js:17-24` | CONFIRMED | `AGENT_GLOBALS` = claude, codex, gemini, pi (4 entries). Main `TARGETS` catalog exposes 16 targets (`agent where` lists 16), so the "4 of 8+" claim understates the gap. |
| `injectToAllAgents`/`injectToAgentGlobal` are dead code | `src/skills/lib/agents-md.js:79-101` | CONFIRMED | Both exported at 79-101; only `injectBlock` is imported elsewhere (by `blocks.js`). Grep across src shows zero call sites for either injectTo* function. |
| `consolidate.prompt` string exists only in USER.md template, no code reads it | `src/archetypes.js:142-145` | CONFIRMED | `\`consolidate.prompt: ask\` …` block at 142-145 inside `userContent()`. Grep across entire src tree: single match (archetypes.js:142). No reader. |
| Consolidation pre-run core backup writes `~/.agents/backups/LESSONS-*.md` | `src/consolidate.js:207-224` | CONFIRMED | `ensureBackup()` copies core to `BACKUP_DIR_GLOBAL = ~/.agents/backups` with `LESSONS-<ts>.md` name (line 11, 217-223). |
| `snapshot()` excludes `backups/` | `src/snapshot.js:59` | CONFIRMED | `copyDir(BRAIN, dst, new Set(["backups"]))` — backups subtree (incl. consolidation backups) never copied; `restore` only reads `backups/snapshots/*`, so LESSONS backups are unrestorable. |
| Nothing writes `lessons/.inbox`; inbox code is read-only | `src/lessons-lib.js:143-168` | CONFIRMED | `inboxLessons()` doc comment says "from the optional pi extension"; only `readdir` reads. Grep for `.inbox` in src: reads only (consolidate.js:65, lessons-lib.js:90/155/255), zero writes. |
| Handoff template section exists, no wire format | `src/agents-lib.js:189-190` | CONFIRMED | Lines 189-190 are `## Handoff` + `<what it returns to the delegating agent>` placeholder. |
| `identity apply` clobbers a set `<AGENT_NAME>` (archetype emits it empty) | `src/archetypes.js:99-100` | CONFIRMED | `identityContent()` always emits `<AGENT_NAME></AGENT_NAME>`; `applyIdentity()` (identity.js:28-35) overwrites the whole file with it. |
| Skill store lives in `~/.skill-cli` | `src/skill.js:17-19` | CONFIRMED | `SKILL_HOME = ~/.skill-cli`, `SKILL_STORE`, `SKILL_CONFIG` at 17-19. |
| Bare `agent` exits non-zero with `✗ (outputHelp)` | `src/cli.js:2108-2123` | CONFIRMED | Live run: exit status 1; full help text AND `✗ (outputHelp)` (ANSI red) all on **stderr**, stdout empty. |
| Catch handler whitelists `commander.helpDisplayed`/`commander.version` but not `commander.help` | `src/cli.js:2111-2114` | CONFIRMED | Whitelist is exactly those two codes (2112). Bare invocation throws `commander.help` (commander lib 1253 → `_exit(1,'commander.help','(outputHelp)')`), falls through to `log.error` + exit 1. |
| `agent help` and `agent help <cmd>` also exit 1 | (behavioral) | CONFIRMED | Live: `agent help` and `agent help status` both exit 1 with `✗ (outputHelp)` on stderr; `agent --help` exits 0 cleanly. |
| `where -p` reports the global master, not project master | `src/cli.js:1270` | CONFIRMED | Line 1270 emits `master: MASTER_FILE` (global `~/.agents/AGENTS.md`) regardless of scope; live `where -p --json` returned the temp global home path. `masterPaths(scope)` exists (113-118) and is used by link/unlink but not `where`. |
| ANSI leaks into JSON payloads | `src/commands/target.js:32`, `src/cli.js:93-98`, `1509-1523` | CONFIRMED | `fail()` prints message verbatim in JSON (93-98); target.js:32 error string embeds `c.cyan("agent targets")`. Live `agent skill list --json`: `output` string contains `\u001b[1m…\u001b[22m…\u001b[90m`. |
| `identity/soul apply <unknown> --json` write fallback default; human mode refuses | `src/cli.js:770-794`, `831-851` | CONFIRMED | Both: `if (!known && !JSON_MODE) fail(…)` then proceed to `applyIdentity/applySoul` in JSON mode (fallback general-purpose / pragmatist). |
| `consolidate` on empty install exits 1 with `{ok:false, reason:"no lessons dir"}` | `src/cli.js:1207-1219` + `src/consolidate.js:253` | CONFIRMED | Live: status 1, JSON `{command, ok:false, reason:"no lessons dir"}`. consolidate.js:253 returns that object when lessons dir absent. |
| `brief`/`doctor`/`update list` mutate `config.json` via npm check | `src/cli.js:1312, 1734, 1795` | CONFIRMED | All three: `if (upd.refreshed) await saveConfig(cfg)` after `ensureUpdateCheck`. |
| `skillVersion()` pays a Node subprocess | `src/skill.js:104-116` | CONFIRMED | `skillVersion()` calls `runSkill(["--version"])` → `spawnSync(process.execPath, [SUBMODULE_CLI,…])`. |
| `agent skill <sub> --json` wraps ANSI text as escaped string, subcommands ignore `--json` | `src/cli.js:1509-1522` | CONFIRMED | Passthrough branch wraps `r.stdout`/`r.stderr` raw into envelope (live: ANSI `\u001b[1m` inside `output`); skill subcommands are plain `console.log` and never parse `--json`. |

## Tier 2 — High-value capabilities

| Claim (short) | Anchor | Verdict | Evidence |
|---|---|---|---|
| `inbox`/`triage` counts always 0 from in-tool usage | (grep) | CONFIRMED | `assess()` counts `.inbox` files (consolidate.js:65,103); `brief` inboxCount derives from it (cli.js:1883). No writer exists anywhere in src, so in-tool counts stay 0. |
| `skill defaults` (plural) aliases the active catalog, not default-marked skills | `src/skills/commands/defaults.js` | CONFIRMED | File header: "`skill active` (aliases: `status`, legacy `defaults`)". Live `agent skill defaults` prints `skill active — active skills…`. |
| `enable -g` ≡ `default`, `disable -g` ≡ `undefault` (same `defaults` list) | `src/skills/commands/enable.js:17-23`, `disable.js:9-17` | CONFIRMED | Both branches mutate `cfg.defaults` in global config.yaml exactly as `cmdDefault`/`cmdUndefault` do. |
| `link -g -p` runs both scopes; `target -g -p` lets `--project` win | `src/cli.js:357-360`, `src/commands/target.js:37` | CONFIRMED | link pushes both "global" and "project" into `scopes`; target uses `opts.project ? "project" : "global"`. |
| `link --target <unknown>` silently succeeds (no error) | (behavioral) | CONFIRMED | Live `agent link -t bogus --json`: exit 0, `results: []`. Human mode would print `0 linked, 0 up-to-date`. |
| `models resolve <missing> --json` exits 0 with `resolved:null`; `agents show <missing>` exits 1 | (behavioral) | CONFIRMED | Live: resolve → status 0, `{"resolved": null}`; agents show → status 1 `✗ No agent named 'missing-xyz'` (both human and `--json`). |
| `agent edit models` → "Unknown kind: models" | (behavioral) | CONFIRMED | Live: `{"ok":false,"error":"Unknown kind: models. Use: agents|soul|identity|user|lessons|environments"}`. |
| `agent skill --help` shows a stub, rich help only via `skill help` | (behavioral) | PARTIALLY CONFIRMED | Substance holds (live: `--help` = 7-line commander stub; `skill help` = full skill-cli help), but "4-line stub" is imprecise — it is 7 lines. |
| `init` human output is nearly silent | (behavioral) | PARTIALLY CONFIRMED | Live `agent init` prints 3 lines (master ready, pointers, next) — no summary of created identity files/MODELS.md/personalities/skill store/targets. "Nearly silent" is fair; not a hard fact. |
| Inverted scope defaults: root=global (`-p`=project), skill=project (`-g`=global) | `src/cli.js:360,1264`, `src/skills/commands/enable.js:6,24-29` | CONFIRMED | Root: `scopes.length===0 → push("global")`; `opts.project ? "project":"global"`. Skill: `-g/--global` opt-in to global, default writes project `skill.config`. |
| `doctor` never checks project skill config | (grep) | CONFIRMED | Zero references to `skill.config`/`PROJECT_CONFIG` in `src/cli.js` or doctor checks. |
| `lessons triage --file <i>` uses a numeric index (vs `update diff --file` path) | `src/cli.js:1127` | CONFIRMED | Triage usage string: `agent lessons triage --file <i> <topic/name>` (index). |
| `update` has no `apply` (list|diff|stage|clear only) | `src/cli.js:1410` | CONFIRMED | Fail message: "Use list|diff|stage|clear <version>". |
| No top-level search primitive | (grep/help) | CONFIRMED | No `search` command in `agent` help output or cli.js; only the skill CLI has a `skill search`. |

## Summary

- Anchored claims checked: **39** (Tier 1 + Tier 2 + Tier 3 anchor-bearing items in the requested sections).
- CONFIRMED: **37**; PARTIALLY CONFIRMED: **2** (`skill --help` stub line count; `init` output wording); WRONG: **0**; UNVERIFIED: **0**.
- Minor imprecision (not a verdict change): "4-line stub" is actually 7 lines; "8+ marketed agents" is stronger than reality (16 targets vs 4 gated).

No claim required a correction to a different anchor. The report's anchors all exist and support the stated claims; the highest-impact claims (bare `agent`/`agent help` exit 1 with stderr `✗ (outputHelp)`, JSON ANSI leaks, `consolidate` empty-install exit 1, `where -p` global-master bug, dead `injectTo*` code, `consolidate.prompt` never read, `.inbox` never written) were verified live and are accurate.
