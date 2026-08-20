// Single source of truth for the skill START GATE policy.
// Both the AGENTS.md bootstrap block (agents-md.js) and the `skill active`
// command output (commands/defaults.js) render from these strings — edit here
// only, so the injected instructions and the CLI hint can never drift.

// The classification rule shared by both renderings.
export const CLASSIFY_RULE =
  'For EACH skill above, classify which axis it moves and ACT — no discretion, no third option:\n' +
  '  - moves CORRECTNESS or QUALITY → LOAD it now: run the cat/read command on it.\n' +
  '  - moves COST, SPEED, or response STYLE → PROPOSE it: these are TRADE-OFFS the USER decides, never you.\n' +
  '  - moves none of the above → SKIP it.'

// Short hint printed by `skill active` at the end of the catalog.
export const GATE_DECIDE_HINT = `→ For EACH skill above, decide in your reply:
    LOAD    moves CORRECTNESS/QUALITY → run ${'`skill cat <name>`'} now.
    PROPOSE moves COST, STYLE, or SPEED → ASK "enable <name>?" about ALL of them,
            then END YOUR TURN and WAIT. That turn contains ONLY the questions — NO exploration,
            NO tool calls, NO task work. Do NOT start the task until they answer. The wait is
            the POINT — a trade-off is the USER's decision; it moves an axis on EVERY
            reply, so NEVER skip and NEVER say "not relevant here".
            Mentioning / noting / "available" is NOT asking.
    PARAMS  if a proposed skill lists activation options (level / language / mode /
            format / strictness), ask the user to choose them in the SAME proposal — do not pick
            for them. Gate stays up until enable decision + parameters are both given.
    SKIP    moves NONE of the above.
  ⚠ Breaking the gate: starting the task / exploring before the user answers,
    "would delay it", "user has a clear request", "I will just do the task",
    "not relevant here". → ASK first, then END your turn.`

// Full policy rendered into AGENTS.md (used by the agent at session start).
export const GATE_POLICY_TEXT = `START GATE (mandatory): On the FIRST user message of a session, your VERY FIRST
action — BEFORE ANYTHING ELSE (before thinking, before any tool call) — MUST be to
run \`agent-cli skill active\`. It lists each ACTIVE skill's name + FULL description (never the
body). Read it, then for EACH skill classify which axis it moves and ACT — there is
no discretion and no third option:
- moves CORRECTNESS or QUALITY → load it now: \`agent-cli skill cat <name>\`.
- moves COST, SPEED, or response STYLE → PROPOSE it. These are TRADE-OFFS — the
  USER decides them, NEVER you. Even if you are SURE one would hurt THIS task, you
  still ASK: "Enable <name>? It <one-line benefit>." (apply only on yes). They move
  an axis on EVERY task by definition (every reply has a token cost, a length, a
  style, a speed), so the thoughts "not relevant to this task", "not needed here",
  "the user didn't request it", and "skip unless needed" are FORBIDDEN — each one
  is you STEALING the user's decision. Deciding a trade-off is not your role;
  surfacing it is. A line in a table is NOT proposing — you must actually ask.
  PROPOSE IS A GATE: ASK "Enable <name>?" (ask about ALL such skills in ONE message),
  then END YOUR TURN and WAIT — do nothing else that turn. The proposal turn contains
  ONLY the questions (enable + any parameters): NO exploration, NO tool calls, NO
  reading files, NO starting the task. Do NOT begin the actual task until the user
  answers (yes → apply it, no → proceed without). The one-turn wait is the POINT —
  the user chooses the trade-off BEFORE you start — so "asking would delay the task",
  "the user has a clear request", "I'll just do the task first", "I'll mention it and
  proceed", and "I'll start exploring while I wait" are FORBIDDEN: each is you
  deciding for the user. Mentioning / noting / "available" is NOT asking — you must
  ASK a yes/no question and then END your turn.
  PARAMETERS (2nd rule): if the skill's description lists activation options to pick
  from — e.g. a level, a language, a mode, a format, or a strictness — you MUST ask
  the user to choose them in the SAME proposal (do NOT pick for them), and the gate
  stays up until they give BOTH the enable decision AND the parameters. Genericize
  — never assume a particular skill; read its description to see which options (if
  any) it exposes, and ask for those.
- moves none of the above → skip.
When unsure if a skill moves an axis → PROPOSE (ask). LOADED ≠ LISTED: a skill is
loaded only if you \`cat\`-ed it this session — listing it, its ★, or its \`active\`
status is NOT loading; active/★ means AVAILABLE, not APPLIED.
PRIORITIES: correctness > quality > cost (cheap) > speed — never trade correctness
or quality for speed or cost.
Discovery: on EVERY later message, re-run this classification; load newly-relevant
correctness/quality skills, PROPOSE newly-relevant cost/style/speed ones. Load each
skill only ONCE per session (\`agent-cli skill trigger <keyword>\` resolves a keyword).

Triggers: when the user types \`/X\`, run \`agent-cli skill trigger X\`.
- Single match → apply the output directly.
- Multiple matches → show the candidate list; load the right one with \`agent-cli skill cat <name>\`.
`
