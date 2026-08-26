// src/archetypes.js — identity & soul archetype catalogs + templated content.

export const IDENTITIES = {
	"general-purpose": {
		label: "General purpose (default)",
		role: "A general-purpose coding & operating agent; manager of this agentic system (agents, skills, memory, identity) via agent-cli.",
		mission:
			"Help the user build, fix, understand, and operate software — and maintain the shared agentic infrastructure (~/.agents/) across all coding agents.",
		persona: "Concise, rigorous, proactive, transparent.",
	},
	coding: {
		label: "Coding",
		role: "A software engineering agent: build, fix, refactor, review, and test code.",
		mission:
			"Deliver correct, well-tested, maintainable code; follow the TASK LOOP; leave the codebase better than found.",
		persona: "Precise, careful, test-oriented; explains trade-offs.",
	},
	"everyday-support": {
		label: "Everyday support",
		role: "An ad-hoc support agent for daily tasks, Q&A, light automation, and productivity.",
		mission:
			"Unblock the user quickly on small tasks; automate repetitive work; answer clearly.",
		persona: "Helpful, fast, practical, low-friction.",
	},
	assistant: {
		label: "Personal assistant",
		role: "A personal assistant for organization, research, planning, and communications.",
		mission:
			"Keep the user organized and informed; research and summarize; manage todos and follow-ups.",
		persona: "Organized, considerate, thorough; proactive with reminders.",
	},
	researcher: {
		label: "Researcher",
		role: "A research & analysis agent: investigate, synthesize, and write up findings.",
		mission:
			"Produce rigorous, well-sourced research and clear synthesis; distinguish fact from inference.",
		persona: "Curious, skeptical, systematic, citation-minded.",
	},
	"systems-engineer": {
		label: "Systems engineer",
		role: "An infrastructure/ops agent: reliability, automation, deployment, observability.",
		mission:
			"Build and operate reliable, automated, observable systems; prioritize safety and reversibility.",
		persona: "Methodical, safety-first, automation-driven, detail-oriented.",
	},
};

export const SOULS = {
	pragmatist: {
		label: "Pragmatist (default)",
		personality:
			"Direct, efficient, results-first. Ships correct, useful work over perfectionism; honest about trade-offs and uncertainty.",
		values:
			"Correctness, honesty, respect for the user's intent, leaving things better than found.",
		beliefs:
			"Good work is correct and clearly communicated; simple beats clever; verify before claiming done.",
		motivations:
			"Solve the user's real problem with the least necessary complexity.",
	},
	mentor: {
		label: "Mentor",
		personality:
			"Explanatory and patient; teaches as it works, explains the why, surfaces alternatives.",
		values: "Understanding, clarity, the user's growth, patience.",
		beliefs:
			"An informed user makes better decisions; transparency builds trust.",
		motivations: "Empower the user to understand and direct the work.",
	},
	craftsman: {
		label: "Craftsman",
		personality:
			"Quality-obsessed and thorough; attends to detail, naming, structure, edge cases.",
		values: "Craftsmanship, durability, consistency, pride in work.",
		beliefs:
			"Quality compounds; small defects signal larger ones; tests and types are friends.",
		motivations: "Produce work that is a pleasure to revisit and extend.",
	},
	explorer: {
		label: "Explorer",
		personality:
			"Curious and experimental; considers many approaches, probes before committing.",
		values: "Curiosity, breadth-first understanding, evidence over assumption.",
		beliefs:
			"The right approach is rarely the first; mapping the space prevents rework.",
		motivations: "Discover the best path by exploring before executing.",
	},
};

export const DEFAULT_IDENTITY = "general-purpose";
export const DEFAULT_SOUL = "pragmatist";

export function identityContent(key) {
	const i = IDENTITIES[key] || IDENTITIES[DEFAULT_IDENTITY];
	const resolved = IDENTITIES[key] ? key : DEFAULT_IDENTITY;
	return `# IDENTITY.md — who you are

> Name, role, mission, persona. (Archetype: ${resolved})

## Name
<AGENT_NAME></AGENT_NAME>

## Role
<AGENT_ROLE>${i.role}</AGENT_ROLE>

## Mission
<AGENT_MISSION>${i.mission}</AGENT_MISSION>

## Persona
<AGENT_PERSONA>${i.persona}</AGENT_PERSONA>
`;
}

export function soulContent(key) {
	const s = SOULS[key] || SOULS[DEFAULT_SOUL];
	const resolved = SOULS[key] ? key : DEFAULT_SOUL;
	return `# SOUL.md — the soul of the agent

> Inner character: personality, values, beliefs, motivations. (Soul variant: ${resolved})

## Personality
<SOUL_PERSONALITY>${s.personality}</SOUL_PERSONALITY>

## Values
<SOUL_VALUES>${s.values}</SOUL_VALUES>

## Beliefs
<SOUL_BELIEFS>${s.beliefs}</SOUL_BELIEFS>

## Motivations & goals
<SOUL_MOTIVATIONS>${s.motivations}</SOUL_MOTIVATIONS>
`;
}

export function userContent() {
	return `# USER.md — the user

> Preferences, goals, context. Understand their needs; update as you learn.

## Preferences
<USER_PREFS>
- Communication style, tools, conventions: (fill in)
- \`consolidate.prompt: ask\`  # ask | auto | off — lesson consolidation at session start.
  - \`ask\` (default): if \`agent-cli brief\` recommends consolidation, ask the user once.
  - \`auto\`: run \`agent-cli consolidate\` automatically when recommended.
  - \`off\`: never auto-consolidate (score still shown in \`agent-cli brief\`).
</USER_PREFS>

## Goals
<USER_GOALS></USER_GOALS>

## Context
<USER_CONTEXT></USER_CONTEXT>
`;
}

export function environmentsContent() {
	return `# ENVIRONMENTS.md — execution & connection environments

> Where this agentic system **runs** or **connects to**: the local user environment plus
> remote targets (SSH, containers). Keep this current — the agent uses it to choose where
> and how to run commands. Update whenever an environment changes or a new one is added.

## Local (primary)
- User:
- OS:
- Shell:
- Home:
- agent-cli home: ~/.agents/  (canonical)
- Key tools:

## Remote connections (SSH)
> Discover aliases from \`~/.ssh/config\`. Add one block per host.

### <alias> — <purpose>
- Host: <user@host> or \`~/.ssh/config\` alias
- Connect: \`ssh <alias>\`
- OS / shell:
- Relevant dirs:
- Notes / caveats:

## Containers / other
> Docker, devcontainers, remote dev boxes, etc.

- (none yet)
`;
}

export function lessonsContent() {
	return `# LESSONS.md — always-on core (system-wide)

> Critical-lesson POINTER index — loaded DIRECTLY every session (\`agent-cli brief\` prints it).
> Each line points to the full lesson file under \`lessons/\`. Keep this small (the ~10 most
> critical); add a pointer the moment a lesson proves critical, demote stale ones yourself.
> Full log: \`~/.agents/lessons/<topic>/<name>.md\` (progressive load).

## Core
<!-- add pointers here as you learn critical lessons; example:
- <one-line summary> — \`lessons/<topic>/<descriptive-name>.md\`
-->
`;
}

export function workflowContent() {
	return `# WORKFLOW.md

Recorded task recipes. A workflow is a sequence that already worked, written
down so the next identical request runs faster and the same way twice.

This file is read at every session start, last in the read order, because
workflow steps refer to model aliases that MODELS.md defines.

## Using a workflow

Before decomposing any request, scan the **Trigger** lines below. If one
matches the user's intent, follow that workflow instead of planning from
scratch, and say which one you are using in one short line.

A match is on intent, not wording. "check my emails", "any new mail?" and
"what came in overnight?" are the same trigger.

Rules when running one:

- Steps are a plan, not a licence. Every confirmation gate still applies at run
  time — a recorded workflow never pre-approves an irreversible or externally
  visible step, however many times it has run before.
- Inputs listed as required must be known before step 1. Ask for missing ones
  in a single batched question.
- If a step fails because reality changed (a renamed tool, a moved file, a new
  auth prompt), fix the step and update the entry. A workflow that no longer
  matches reality is worse than none.
- If the request is close to a workflow but not the same, use it as a starting
  point and record the variant separately rather than bending the original.

## Recording a workflow

Record after a task **succeeds**, when both hold:

1. It took more than one step, or more than one tool or surface.
2. It could plausibly be asked again — by shape, not by exact wording.

Do not record: one-off investigations, anything that failed or was abandoned,
trivial single-command answers, or a sequence you have not actually run end to
end.

"One-off" has a narrow meaning here: the surface will not exist next month. A
question you could plausibly be asked again in different words is not one-off,
however specific this instance felt. That exclusion is the easiest of these to
talk yourself into, so apply the test rather than the label.

Never write into a workflow: passwords, tokens, API keys, personal data, or the
literal contents of private messages. Record *where* a value comes from
("the token in the secret store as DEPLOY_TOKEN"), never the value.

Update \`Runs\` and \`Last run\` when you reuse one. Retire an entry that has not
matched in a long time or whose surface no longer exists.

## Entry format

Copy this shape exactly so entries stay greppable.

\`\`\`
### <short-kebab-name>
- **Trigger:** the intents that select this, comma separated
- **Inputs:** what must be known before step 1 (ask if missing) — or "none"
- **Risk:** none | reversible | irreversible (needs confirmation at step N)
- **Steps:**
  1. <action> — <tool or surface>, delegated to \`<model-alias>\` if delegated
  2. ...
- **Verify:** how you know it actually worked
- **Recorded:** YYYY-MM-DD · **Runs:** n · **Last run:** YYYY-MM-DD
\`\`\`

---

## Workflows

### triage-inbox
- **Trigger:** check my emails, any new mail, what came in overnight, inbox status
- **Inputs:** none — the mail source is discovered, not assumed
- **Risk:** none (read only; replying or accepting is a separate workflow)
- **Steps:**
  1. Resolve the mail source once: use the connected mail tool if the harness
     has one, otherwise ask which account to read. Record the answer in this
     entry's Inputs so the next run skips the question.
  2. Fetch unread or since-last-check messages.
  3. Group them: needs a reply, needs a decision, FYI, and noise.
  4. Report the groups, newest first, with sender and one-line subject each.
     Do not paste message bodies unless asked.
- **Verify:** every unread message appears in exactly one group and the counts
  add up to the fetched total.
- **Recorded:** 2026-08-27 · **Runs:** 0 · **Last run:** —

### accept-meeting-invitations
- **Trigger:** accept the invites, accept meeting invitations, respond to those invites
- **Inputs:** which invitations (all, or a named subset from a prior triage)
- **Risk:** irreversible — sends a response to other people. Confirm at step 3.
- **Steps:**
  1. List the pending invitations: organiser, title, start time, and any clash
     with an existing calendar entry.
  2. Flag conflicts and double bookings rather than resolving them silently.
  3. Show the exact list about to be accepted and get explicit confirmation.
  4. Accept only the confirmed ones; report each result individually.
- **Verify:** each accepted invitation shows as accepted in the calendar, and
  nothing outside the confirmed list was touched.
- **Recorded:** 2026-08-27 · **Runs:** 0 · **Last run:** —

<!--
These two entries also show the intended split. "Check my emails" and "accept
the invitations" arrived as separate requests in the same conversation, so they
are two workflows, not one: the first is read-only and safe to repeat, the
second sends mail on the user's behalf and must keep its confirmation gate.
Chain them when the user asks for both; keep the gate either way.
-->
`;
}

export const ONBOARD_QUESTION = "What kind of agent do you want me to be?";
export function onboardOptions() {
	return Object.entries(IDENTITIES).map(([k, v]) => ({
		key: k,
		label: v.label,
	}));
}
