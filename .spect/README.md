# SPECT — specification-driven development

This project uses SPECT as a living specification workflow.

## Workflow

1. Write or update a specification before implementation.
2. Express requirements as scenarios with stable IDs and testable acceptance criteria.
3. Decompose the specification into a plan and traceable tasks.
4. Implement one task at a time; keep the specification honest when reality changes.
5. Verify every acceptance criterion and record the relevant tests before declaring done.

## Task-start guidance

SPECT is optional. If the user explicitly requests specification-driven development,
run agent spect init in the project directory when it is absent. If the project already
has .spect, read this README, constitution.md, and the relevant specs, plans, and tasks,
then follow the SPECT loop below.

For ordinary tasks, do not initialize SPECT or create .spect automatically. If SPECT
would materially help, explain the option and ask the user before initializing it.

When SPECT is active, use this loop:
specify → plan → decompose → implement → verify → review → refactor → re-verify.
A failed check returns to implementation; do not declare done with an open failure.

## Layout

- `constitution.md` — project-wide principles and constraints.
- `specs/` — product, technical, and integration specifications.
- `plans/` — implementation plans and design decisions.
- `tasks/` — executable task checklists.
- `templates/` — starting templates; copy, then customize.

Read the relevant specification before changing code. Update the specification before
changing an agreed requirement. Do not treat this directory as a changelog.
