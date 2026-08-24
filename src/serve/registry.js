/**
 * src/serve/registry.js — pure static MCP descriptor registry.
 *
 * Consumed by src/serve.js. Holds the six canonical exports that drive the
 * MCP `initialize` response and the resources/prompts/tools handlers:
 *   READ_CAPABILITIES, WRITE_CAPABILITY,
 *   RESOURCE_DESCRIPTORS, PROMPT_DESCRIPTORS,
 *   SUBSCRIBABLE, WRITE_TOOLS.
 *
 * Intentionally ZERO IMPORTS. This file is the ground truth the
 * import-boundary guard (test/import-boundaries.test.js, extended in T6.0.3)
 * protects: anything dynamic — callbacks, producers, runtime helpers —
 * belongs in src/serve.js, not here. Drift in this file is caught by the
 * manifest cross-check in test/contract.test.js (pinned canonical URI set,
 * not equality, per MASTER-PLAN §1 decision 6).
 *
 * Capability split — v0.8.0 vs v0.8.1:
 *   READ_CAPABILITIES is the v0.8.0 server's read-side surface, always sent.
 *   WRITE_CAPABILITY is the v0.8.1 opt-in: it is sent ONLY when the client
 *   offers `capabilities.experimental.agentCli.writeTools: true` during
 *   `initialize` (exact boolean; truthy strings fail closed per MASTER-PLAN
 *   §10.2 + §11 C7). Keeping these as separate constants means a v0.8.0
 *   server cannot accidentally advertise a write capability it does not
 *   ship, and a v0.8.1 server cannot silently drop the declaration.
 *
 * `brain://brief` is subscribe-only — deliberately NOT in RESOURCE_DESCRIPTORS.
 * It is delivered exclusively via `notifications/resources/updated` (stateless
 * + message-driven, see MASTER-PLAN §1 decision 5 + A18). The fixed URI
 * count is therefore 10 concrete URIs + 1 RFC 6570 URI template
 * (`brain://skills/{name}`) = 11 entries, matching the §4.1 6.1.1
 * acceptance criterion for `resources/list`. SUBSCRIBABLE still names it.
 */

/** v0.8.0 read-side MCP capabilities — always advertised. */
export const READ_CAPABILITIES = {
	tools: { listChanged: false },
	resources: { subscribe: true },
};

/** v0.8.1 MCP write capability — opt-in only; sent when the client offers the matching capability during initialize. */
export const WRITE_CAPABILITY = {
	experimental: { agentCli: { writeTools: true } },
};

/** 11 MCP resource descriptors (10 concrete URIs + 1 URI template). `brain://skills/{name}` is an RFC 6570 URI template; the `{name}` placeholder resolves at read time to an installed skill name. `brain://brief` is intentionally absent — subscribe-only, surfaced via SUBSCRIBABLE. */
export const RESOURCE_DESCRIPTORS = [
	{ uri: "brain://files/SOUL.md",         name: "Soul profile",     mimeType: "application/json", kind: "soul" },
	{ uri: "brain://files/IDENTITY.md",     name: "Identity",         mimeType: "application/json", kind: "identity" },
	{ uri: "brain://files/USER.md",         name: "User profile",     mimeType: "application/json", kind: "user" },
	{ uri: "brain://files/LESSONS.md",      name: "Lessons",          mimeType: "application/json", kind: "lessons" },
	{ uri: "brain://files/ENVIRONMENTS.md", name: "Environments",     mimeType: "application/json", kind: "environments" },
	{ uri: "brain://files/MODELS.md",       name: "Models",           mimeType: "application/json", kind: "models" },
	{ uri: "brain://skills/{name}",         name: "Skill manifest",   mimeType: "application/json", kind: "skill" },
	{ uri: "brain://targets",               name: "Enabled targets",  mimeType: "application/json", kind: "targets" },
	{ uri: "brain://lessons/inbox",         name: "Lessons inbox",    mimeType: "application/json", kind: "lessons-inbox" },
	{ uri: "brain://lessons/core",          name: "Lessons core",     mimeType: "application/json", kind: "lessons-core" },
	{ uri: "brain://session/current",       name: "Current session",  mimeType: "application/json", kind: "session" },
];

/** 3 MCP prompt descriptors surfaced via `prompts/list`. Each maps to one CLI command; `prompts/get` returns the canonical prompt text. */
export const PROMPT_DESCRIPTORS = [
	{ name: "session-start", uri: "prompt://session-start", description: "Equivalent of `agent-cli prompt` output." },
	{ name: "instructions",  uri: "prompt://instructions",  description: "Equivalent of `agent-cli instructions`." },
	{ name: "brief-plan",    uri: "prompt://brief-plan",    description: "Equivalent of `agent-cli --json brief --plan`." },
];

/** The two URIs `resources/subscribe` accepts. Subscription delivery is stateless + message-driven (no timers, no watchers — see MASTER-PLAN §1 decision 5 + A18). `brain://brief` is subscribe-only and therefore NOT in RESOURCE_DESCRIPTORS. */
export const SUBSCRIBABLE = new Set([
	"brain://brief",
	"brain://session/current",
]);

/** Authoritative v0.8.1 write-tool inventory (MASTER-PLAN §10.3): 10 tools.
 *  The 8 core tools + 2 conditional tools (`snapshot_now`, `lesson_consolidate`)
 *  whose inclusion depends on the B1 / B2 refactors landing:
 *    - `snapshot_now`     ships because src/snapshot.js was refactored under
 *                         withOperationLock + symlink-safe traversal + secret
 *                         exclusion (T6.2.4a, commit cff9869).
 *    - `lesson_consolidate` ships because src/consolidate.js was refactored
 *                         under util.writeFileSync + sanitized errors +
 *                         shared lock (T6.2.4b, commit f1bb25f).
 *  `restore` remains deferred to v0.8.2 (master-plan §10.3 C1). */
export const WRITE_TOOLS = new Set([
	"brain_write",
	"lesson_capture",
	"target_enable",
	"target_disable",
	"link",
	"unlink",
	"memory_upgrade_prepare",
	"memory_upgrade_apply",
	"snapshot_now",
	"lesson_consolidate",
]);
