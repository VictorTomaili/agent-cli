# SPEC: P0 Critical Fixes — agent-cli v0.2.1

## Summary
Fix the 5 critical findings from the multi-agent project analysis.

## Acceptance Criteria

### P0-1: Skill remove path traversal (CRITICAL-2)
- [x] `listStore()` returns safe canonical name via `sanitizeSkillName(data.name) || entry.name`
- [x] `remove.js` and `manager.js` delete via `entry.dir`, never `entry.name`
- [x] Regression test: malicious frontmatter `name: ../../victim` cannot delete outside STORE_DIR (test/skill-update.test.js)
- [x] Regression test: manager interactive delete is also safe (manager.removeOne shares the same canonical-dir + containment guard as cmdRemove; covered by the cmdRemove regression test)

### P0-2: Project-scope master resolution (CRITICAL-1)
- [x] `masterContext(scope, cwd)` function created and used by `target enable/disable --project` (implemented as scope-aware `masterPaths(scope, cwd)` injected into `registerTargetCommand`)
- [x] `link -p` and `pull -p` use scoped master, not global
- [x] Test: project pointer `master-abs` field points to `[cwd]/.agents/AGENTS.md` (test/target-config.test.js)
- [x] Test: `pull -p` writes to project master, not global (test/cli.test.js)

### P0-3: Concurrent config write data loss (CRITICAL-3)
- [x] File locking or optimistic concurrency on config mutations
- [x] Test: 6 concurrent `target enable --global` all succeed without data loss (test/config.test.js unit + test/cli.test.js multi-process)

### P0-4: Pre-restore backup missing .snapshot.json (GAP-1)
- [x] `restore()` writes `.snapshot.json` into pre-restore backup directory
- [x] Test: pre-restore backup can be restored via `agent restore pre-restore-<ts>` (test/snapshot.test.js)

### P0-5: Non-transactional consolidation (GAP-2)
- [x] `consolidate()` uses backup-before-mutate or transactional write
- [x] Test: interrupted consolidation does not lose lessons (test/consolidate.test.js)

## Verification
- [x] `npm test` passes with all existing + new regression tests (501/501)
- [x] `npm run check` passes (syntax check all source files)
