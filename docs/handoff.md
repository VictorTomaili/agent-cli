# Code Review Remediation Handoff

Repository: `@tomaili/agent`

Review baseline: commit `1c869ce`

Current remediation commits:

- `1cfae10` — validates staged-update versions before `update clear` can remove a directory.
- `b944d84` — contains `lessons show` and lesson creation against traversal, absolute paths, Windows separators, and symlink escapes.

The worktree was clean after both commits. The full test suite currently passes 237 tests.

## Remediation rules

- Fix one finding at a time.
- Read every target file before editing it.
- Add a regression test for every security or behavior fix.
- Run `npm test`, `npm run build`, `npm run lint`, and targeted diagnostics before every commit.
- Keep review/remediation agents read-only unless explicitly delegated an implementation step.
- Preserve existing user files and reject malformed or unsafe state rather than silently repairing it.

## Findings and implementation order

### 1. Staged-update deletion traversal — FIXED

Files: `src/seed.js`, `test/seed.test.js`

`clearStaged()` previously interpolated the user-supplied version directly into a filesystem path. Traversal could make recursive removal escape the staging directory. It now validates the complete `update-<version>` name against the staged-update grammar and has a regression test proving an outside file remains untouched.

### 2. Lesson disclosure traversal — FIXED

Files: `src/cli.js`, `src/lessons-lib.js`, `test/cli.test.js`, `test/lessons-lib.test.js`

`lessons show` previously joined an untrusted name directly to the lessons root. Access now goes through `resolveLessonFile()`, which rejects traversal, absolute paths, Windows separators, and symlink/reparse-point escapes. Tests cover CLI disclosure attempts and library-level path cases.

### 3. Pointer ownership spoofing — TODO: high priority

Files: `src/pointer.js`, `test/pointer.test.js`

Current ownership detection treats any file containing `<!-- agent-cli-pointer -->` as an agent-cli pointer. A native file containing that text can be overwritten or deleted. Empty native files are also vulnerable where truthiness is used to detect existence.

Required fix:

- Define and validate an exact generated-pointer format, including marker/header and expected target/scope metadata.
- Treat `existing !== null` as existence, including empty files.
- Reject malformed pointers as native content.
- Add tests for marker-containing native files, empty files, malformed pointers, symlinks, link, classify, and unlink.

### 4. Seed staging symlink/junction escape — TODO: high priority

Files: `src/seed.js`, `test/seed.test.js`

`stageSeeds()` can write through a pre-existing `update-<version>` symlink or Windows junction. Reject symlink/reparse-point staging directories, verify realpath containment, and add Windows-compatible junction tests where supported.

### 5. Corrupt model configuration replacement — TODO: high priority

Files: `src/models.js`, `src/config.js`, `test/models.test.js`, `test/config.test.js`

`models set` has its own permissive loader and can replace malformed configuration with a new partial configuration. Route model mutations through the central corruption-aware loader. Preserve the original bytes and return an actionable failure for syntactically or semantically invalid configuration. Add tests for malformed JSON, root arrays, null fields, and partial valid configuration.

### 6. Nested configuration schema validation — TODO: high priority

Files: `src/config.js`, `src/skills/lib/config.js`, related tests

Valid JSON/YAML with wrong field types currently reaches code that assumes arrays and objects, causing crashes or silently ineffective mutations. Validate and normalize nested fields at load boundaries; classify invalid shapes as corrupt and refuse mutations. Cover `global`, `project`, `allow`, `deny`, defaults, and aliases.

### 7. Integrated skill-update path traversal — TODO: high priority

Files: `src/skills/lib/store.js`, `src/skills/commands/update.js`, skill integration tests

Skill frontmatter `name` is used as a filesystem path during update, despite `sanitizeSkillName()` existing. Use the trusted installed directory identity for filesystem operations, or validate names before every path join. Add an isolated fixture test proving a name such as `../../victim` cannot modify anything outside the skill store.

### 8. Consolidation backup and pointer preservation — TODO: high priority

Files: `src/consolidate.js`, `test/consolidate.test.js`

Two issues require separate regression tests:

- Backup directory creation is not awaited before synchronous copying, so a successful consolidation may have no backup.
- `readCore()` recognizes only one pointer prose format while consolidation writes pointers based on lesson first lines. Repeated consolidation can erase existing pointers.

Make backup creation synchronous or await it and fail visibly if backup creation fails. Parse pointers by their canonical `lessons/<relative-path>` reference rather than prose formatting.

### 9. Target scope and transactional state — TODO: high priority

Files: `src/config.js`, `src/commands/target.js`, `src/cli.js`, target/config tests

Fix the state model and operation ordering:

- Project target enablement is currently stored globally and affects unrelated projects.
- Enabling a single project target can convert `project: null` (all project targets) into a one-item allowlist.
- Unsupported target scopes can be persisted.
- Configuration is saved before pointer deployment succeeds.
- Blocked or skipped linking can still return success.
- Unknown target IDs can silently produce an empty successful result.

Define explicit project-local or project-root-keyed state, validate target scope before mutation, deploy before persisting (or model pending state), propagate blocked/skipped failures, and reject unknown IDs. Add cross-project and blocked-native-content integration tests.

### 10. Target-specific rendering — TODO: high priority

Files: `src/targets.js`, `src/pointer.js`, `test/targets.test.js`, `test/pointer.test.js`

`adaptContent()` and target transforms are declared but not used by pointer generation. Cursor output therefore misses required frontmatter, and legacy target metadata is unused. Introduce one per-target renderer/ownership contract used for writing, classifying, stale detection, unlinking, and legacy aliases. Test generated output for every transformed target.

### 11. Skill command UX and inheritance — TODO: medium/high priority

Files: `src/skills/lib/agents-md.js`, `src/cli.js`, `src/skills/commands/disable.js`, skill tests

Generated instructions invoke a standalone `skill` command although only the `agent` binary is packaged. Either package the binary intentionally or generate `agent skill ...` instructions. Ensure `--no-skill` suppresses skill-block injection, not only store setup. When disabling a globally defaulted skill in a project, add it to project `deny` so inheritance is actually overridden.

### 12. JSON and CLI UX contract — TODO: medium/high priority

Files: `src/cli.js`, skill passthrough, CLI tests

Normalize these behaviors:

- Commander parse errors should honor `--json`.
- Skill passthrough should either emit a JSON envelope or explicitly reject JSON mode.
- `edit --print-path --json` must emit exactly one JSON value.
- `target enable` must report blocked/unsupported operations as failures.
- `doctor` must include missing enabled pointers in its issue list.
- `edit --print-path` should not create a file unless requested.
- Editor process failures must return nonzero.
- Help must not advertise unsupported `edit models` behavior.
- Invalid identity/soul keys should be rejected or explicitly report the resolved fallback.
- Avoid destructive default `USER.md` replacement without confirmation/force.

### 13. Agent-experience scope and lifecycle — TODO: medium/high priority

Files: `src/cli.js`, `src/pointer.js`, `src/agents-lib.js`, `src/seed.js`, `src/lessons-lib.js`, AX tests

Fix the inconsistencies surfaced by the AX review:

- Project pointers and `edit agents --project` should resolve the project master, not the global master.
- `update stage` before `init` must not suppress default personality installation.
- `agents validate` should return a machine-actionable failure for invalid or missing personalities.
- Project personalities should override global personalities in list/validate output without duplicates.
- `brief` should include project lessons/core according to an explicit precedence model.
- Surface unresolved model aliases in `brief`/`doctor` with actionable setup guidance.
- Keep `MODELS.md` synchronized with model alias configuration.
- Reduce noisy default status output or make the distinction between absent and unhealthy targets explicit.

### 14. Quality and coverage hardening — TODO: final pass

Files: `src/skills/`, `src/cli.js`, tests, package scripts

The integrated skill manager is largely covered only through its adapter. Add isolated command-level integration coverage for install, update, malformed frontmatter, source failures, rollback, and path safety. Consider extracting CLI handlers from the 1,800-line `src/cli.js`. Replace syntax-only `build`/`lint` checks with actual lint/static analysis where compatible with the project.

## Verification target

Before declaring the remediation complete:

```text
npm test
npm run build
npm run lint
```

Also run targeted diagnostics on every changed source/test file, inspect `git diff --check`, confirm no secrets or `.env` files are staged, and confirm `git status --short` is empty after the final atomic commit.
