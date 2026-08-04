# SPEC: P0 Critical Fixes — agent-cli v0.2.1

## Summary
Fix the 5 critical findings from the multi-agent project analysis.

## Acceptance Criteria

### P0-1: Skill remove path traversal (CRITICAL-2)
- [ ] `listStore()` returns safe canonical name via `sanitizeSkillName(data.name) || entry.name`
- [ ] `remove.js` and `manager.js` delete via `entry.dir`, never `entry.name`
- [ ] Regression test: malicious frontmatter `name: ../../victim` cannot delete outside STORE_DIR
- [ ] Regression test: manager interactive delete is also safe

### P0-2: Project-scope master resolution (CRITICAL-1)
- [ ] `masterContext(scope, cwd)` function created and used by `target enable/disable --project`
- [ ] `link -p` and `pull -p` use scoped master, not global
- [ ] Test: project pointer `master-abs` field points to `[cwd]/.agents/AGENTS.md`
- [ ] Test: `pull -p` writes to project master, not global

### P0-3: Concurrent config write data loss (CRITICAL-3)
- [ ] File locking or optimistic concurrency on config mutations
- [ ] Test: 6 concurrent `target enable --global` all succeed without data loss

### P0-4: Pre-restore backup missing .snapshot.json (GAP-1)
- [ ] `restore()` writes `.snapshot.json` into pre-restore backup directory
- [ ] Test: pre-restore backup can be restored via `agent restore pre-restore-<ts>`

### P0-5: Non-transactional consolidation (GAP-2)
- [ ] `consolidate()` uses backup-before-mutate or transactional write
- [ ] Test: interrupted consolidation does not lose lessons

## Verification
- `npm test` passes with all existing + new regression tests
- `npm run check` passes (syntax check all source files)
