// Single source of truth for the skill START GATE policy.
// Both the AGENTS.md bootstrap block (agents-md.js) and the `skill active`
// command output (commands/defaults.js, commands/skill-cmds.js) render from
// these strings — edit here only, so the injected instructions and the CLI hint
// can never drift.
//
// Tone note: this text is deliberately plain. An earlier version shouted in
// capitals and forbade a long list of rationalisations, which read as a rule
// fighting the harness rather than one the harness could follow. The gate now
// states the rule once and names its degraded mode, so a harness that forbids
// blocking still produces a visible proposal instead of silently losing it.
//
// The wait-or-proceed decision deliberately lives in AGENTS.md ("Asking versus
// proceeding") rather than here. Stating it in both places produced two
// different answers to the same question inside one file.

// The classification rule shared by both renderings.
export const CLASSIFY_RULE =
  'Classify each skill above by the axis it moves, then act:\n' +
  '  - moves correctness or quality → load it now with the cat/read command.\n' +
  '  - moves cost, speed, or response style → propose it. The user makes that trade-off, not you.\n' +
  '  - moves none of these → skip it.'

// Short hint printed by `skill active` at the end of the catalog.
export const GATE_DECIDE_HINT = `→ Decide for each skill above, in this reply:
    LOAD    moves correctness or quality → run ${'`agent-cli skill cat <name>`'} now.
    PROPOSE moves cost, style, or speed → ask "enable <name>?" for all of them in
            one batch. The trade-off is the user's call: every reply has a cost, a
            length and a style, so "not relevant here" is not a reason to skip one.
            Listing a skill or noting it is available is not proposing.
    PARAMS  if a proposed skill's description lists activation options (level,
            language, mode, format, strictness), ask the user to choose them in
            the same batch instead of picking for them.
    SKIP    moves none of these.
  Ask in the one pre-flight round your instructions already define; do not open a
  second one. If your harness forbids blocking on a question, name the skills you
  would have proposed and continue without them — never enable or drop one
  silently. A skill the user already declined this session stays declined.`

// Full policy rendered into AGENTS.md (used by the agent at session start).
export const GATE_POLICY_TEXT = `START GATE: on the first user message of a session, run \`agent-cli skill active\`
before you start the task. It lists each active skill's name and full description
(never the body), and prints this rule back to you. Classify each skill and act:

- Moves correctness or quality → load it now: \`agent-cli skill cat <name>\`.
- Moves cost, speed, or response style → propose it. Ask "Enable <name>? It
  <one-line benefit>." and apply it only on yes.
- Moves none of these → skip it.

When you cannot tell which axis a skill moves, propose it.

Proposing means asking a yes/no question and using the answer. Listing a skill,
noting that it is available, or putting it in a table is not proposing. "Not
relevant to this task" is not a reason to skip a trade-off skill: every reply has
a cost, a length and a style, so the axis always moves. Surfacing the trade-off is
your job; deciding it is the user's.

Fold these proposals into the single pre-flight question round defined above under
"Asking versus proceeding" — one round of questions, not two. That section decides
when you wait for an answer and when you proceed on a stated assumption; it
governs here too, and this gate adds no separate waiting rule. If a proposed
skill's description lists activation options (a level, language, mode, format, or
strictness), ask the user to choose them in that same round rather than picking
for them.

If your harness forbids blocking on a question before doing the work, do not
resolve the conflict by enabling or skipping silently. Name the skills you would
have proposed, say you are proceeding without them, and do the task. The user can
enable one on the next turn.

Loaded is not listed: a skill counts as loaded only once you have \`cat\`-ed it
this session. Active or ★ means available, not applied. Load each skill at most
once per session (\`agent-cli skill trigger <keyword>\` resolves a keyword to a
skill).

A decision, once made, stays made. Never re-propose a skill the user declined
this session. Re-run this classification only when the active skill list changes
or the task moves to a new surface, not on every message.

Triggers: if your harness expands \`/X\` itself and hands you the skill body, use
what it gave you and do not shell out. Only when a \`/X\` reaches you unexpanded,
run \`agent-cli skill trigger X\`.
- Single match → apply the output directly.
- Multiple matches → show the candidate list; load the right one with \`agent-cli skill cat <name>\`.
`
