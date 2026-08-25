## What this changes

<!-- What was wrong or missing, and what this does about it. -->

## Why

<!-- Link the issue if there is one: Closes #123 -->

## How it was verified

<!-- The commands you ran, and what they said. -->

```
npm run check && npm test
```

## Checklist

- [ ] `npm run check && npm test` passes locally
- [ ] New behaviour has tests; a bug fix has a regression test that failed before
- [ ] No new cross-layer import (`test/import-boundaries.test.js` still passes)
- [ ] Paths built with `path.join`; anything input-driven stays contained
- [ ] `--json` output changes are additive, or `apiVersion` is bumped
- [ ] Docs updated if a command, flag, or contract changed
