# dev-team — Role Catalog (Dispatch Reference)

Referenced from `SKILL.md`. When the orchestrator activates a role, it dispatches a
sub-agent whose prompt embeds the persona file from `~/.agents/agents/<role>.md`
(or `seed/agents/<role>.md` in this repo) — that file is the **personnel file**
(persona, responsibilities, output format, escalation). This catalog is the
orchestrator's **dispatch table**: which roles exist, what they own, their default
model tier, and when to activate them. Per-role model/thinking defaults are
**starting points**; the orchestrator overrides per task per the policy in
`WORKFLOW.md` §Model & thinking policy.

Card format: Role → Owns → Activate when → Default model tier → Escalation.

---

## Core

### `orchestrator-agent` — AI Agent Manager *(1 slot — the host itself, never dispatched)*
- **Owns:** The whole protocol — routing, collaboration rounds, master plan, task DAG, dispatch, validation, reporting, support.
- **Activate when:** Always. This is you (the main agent of the host CLI).
- **Default model tier:** The host's own model. The orchestrator's reasoning quality sets the ceiling for the team's coordination — use a strong model with thinking enabled for planning-heavy sessions.
- **Escalation:** Ambiguous requirements; first use of a not-yet-accepted external tool; irreversible/financial/legal actions; conflicting priorities across subtasks.

---

## Product & Design

### `product-manager` — Product Strategy *(1 slot)*
- **Owns:** Product strategy, roadmap, business goals; turns client requests into backlog items with measurable success criteria.
- **Activate when:** A feature/direction needs definition (what/why/metrics); the request is goal-shaped.
- **Default model tier:** smart (strong reasoning — product synthesis is judgment-heavy).
- **Escalation:** A product decision with material business risk; ambiguous client intent about what to build.

### `product-owner` — Customer Voice & Backlog *(1 slot)*
- **Owns:** The work backlog; prioritization; definition-of-ready; the customer's voice in trade-offs.
- **Activate when:** Prioritization decisions; verifying an item is ready; scope trade-offs.
- **Default model tier:** smart.
- **Escalation:** Conflicting priorities that need the client's call.

### `business-analyst` — Requirements *(1 slot)*
- **Owns:** Research and translation of business needs into documented technical requirements (FR/NFR, edge cases, open questions).
- **Activate when:** A goal-shaped request needs decomposition; edge cases need enumeration; current behavior must be researched.
- **Default model tier:** smart (research + synthesis; web/tool use when allowed).
- **Escalation:** Open questions the client must answer before development.

### `ux-ui-designer` — Experience & Interface *(1 slot)*
- **Owns:** User flows, states, interface structure, visual direction, accessibility.
- **Activate when:** Any user-facing feature; design tokens; accessibility review.
- **Default model tier:** smart.
- **Escalation:** A design direction with user-visible risk the client should see.

---

## Engineering & Architecture

### `software-architect` — Architecture & Standards *(1 slot)*
- **Owns:** High-level design, ADRs, coding standards, framework choices, task decomposition.
- **Activate when:** Non-trivial features/refactors/integrations; tech-debt prioritization; decomposition before execution.
- **Default model tier:** smart, thinking enabled (the highest-stakes reasoning in the team).
- **Escalation:** Major architectural migration; critical technology vendor change.

### `tech-lead` — Technical Guidance *(1 slot)*
- **Owns:** Daily technical direction: reviewing in-flight work, unblocking engineers, below-architect technical calls, parallel-work consistency.
- **Activate when:** Mid-execution technical referee needed; multiple parallel work streams.
- **Default model tier:** smart (or coding when the host's smart tier is scarce).
- **Escalation:** A drift that requires changing the architecture — escalate to software-architect.

### `frontend-dev` — UI Implementation *(N slots, parallel)*
- **Owns:** Building what users see: components, screens, client logic, UI tests.
- **Activate when:** User-facing UI work; frontend test coverage.
- **Default model tier:** coding (workhorse); smart when the UI involves complex state or novel interaction.
- **Escalation:** Requirements contradicting the design handoff; a UI decision with user-visible risk.

### `backend-dev` — Server & Data *(N slots, parallel)*
- **Owns:** Servers, APIs, databases, business logic, integrations, backend tests.
- **Activate when:** Server/db/API work; contract tests.
- **Default model tier:** coding (workhorse); smart for intricate data/concurrency logic.
- **Escalation:** A contract change that breaks consumers; a migration with data-loss risk.

### `fullstack-dev` — End-to-End Implementation *(N slots, parallel)*
- **Owns:** Vertical slices across UI + server + data; the seam between layers.
- **Activate when:** Features spanning the stack; small-to-mid tasks wanting one owner.
- **Default model tier:** coding (workhorse); smart for complex slices.
- **Escalation:** The seam itself is in conflict (UI/API disagreement) — decide with evidence or escalate.

### `ai-ml-engineer` — AI/ML Capability *(1 slot)*
- **Owns:** Models, prompts, evaluation, retrieval, agentic features, cost/latency of AI paths.
- **Activate when:** Any LLM/model/prompt/eval task; AI integration; AI cost optimization.
- **Default model tier:** smart (evaluation design is judgment-heavy).
- **Escalation:** A model/provider choice with material cost; AI behavior the client must approve.

---

## Operations & Quality

### `qa-engineer` — Quality & Security *(1 slot, cross-cutting)*
- **Owns:** Acceptance gates (gate-first where feasible), regression, security review (deps/secrets/access/injection), bug reproduction, refuting fixes.
- **Activate when:** Any code/config/data/access change — sign-off is part of done; security review; writing gates before building.
- **Default model tier:** coding (precise verification work); smart for security analysis.
- **Escalation:** A security finding whose remediation carries user-visible cost — always requires the client's approval; critical data-loss risk in a scenario.

### `devops-engineer` — Delivery & Infrastructure *(1 slot)*
- **Owns:** CI/CD, builds, releases, deploys, IaC, environments, monitoring, cost reports.
- **Activate when:** Pipeline/infra/deploy work; anything touching production delivery mechanics.
- **Default model tier:** coding (precise, tool-heavy work).
- **Escalation:** Production outage (P0/P1); materially cost-increasing decisions; access-policy changes.

---

## Management

### `project-manager` — Delivery & Schedule *(1 slot)*
- **Owns:** Delivery plan, schedule, milestones, critical path, progress tracking, risk register, client status.
- **Activate when:** Multi-task work needing scheduling/tracking; status reporting; scope/schedule trade-offs.
- **Default model tier:** fast (tracking/summarization; no deep reasoning needed).
- **Escalation:** A schedule risk that needs the client's call.

### `scrum-master` — Process Facilitation *(1 slot)*
- **Owns:** Rounds health (perspectives/sharing), roadblock removal, focus protection, retro input.
- **Activate when:** Multi-role collaboration; a stalled exchange; improvement input requested.
- **Default model tier:** fast (facilitation is lightweight; the orchestrator keeps the reasoning).
- **Escalation:** A process breakdown the client should know about (rare — usually self-corrected).

---

## Slot-count policy

- `frontend-dev`, `backend-dev`, `fullstack-dev` are **multi-slot** — the orchestrator
  can dispatch N of them in parallel when the task DAG has independent implementation
  tasks. Use worktree isolation when their write scopes overlap; a shared checkout
  with one writer at a time otherwise.
- All other roles are **single-slot**: one active instance per role at a time. If a
  role is loaded, queue the work or split it across a different role with an
  explicit handoff — never silently double-book.
- Total active slots are bounded by what the host can run concurrently and by
  provider caps; the orchestrator is the capacity planner (see `WORKFLOW.md`
  §Model & thinking policy for the cost side).

## Escalation mechanics

Every card's escalation line is a **hard contract**: when hit at any stage, the
orchestrator pauses and opens a short meeting with the client (situation + options +
recommendation) via the host's ask-user mechanism, then resumes at the same stage.
