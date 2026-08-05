// src/envelope.js — the single JSON envelope for agent-cli machine output.
// Every `--json` payload is `{ ok, command, apiVersion, data }` (+ optional
// `error`). This is the versioned protocol contract; see docs/contract.md.

export const API_VERSION = "2.0.0";

/** Exit-code contract (docs/contract.md). */
export const EXIT = {
	OK: 0, // success / intentional no-op
	ERROR: 1, // error, usage, or failure
	WORK: 2, // actionable work available (`brief --check`, `doctor`)
	PARTIAL: 3, // partially applied
};

const ANSI_RE =
	/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/** Remove ANSI escape sequences (SGR/CSI) — JSON output must be plain text. */
export function stripAnsi(s) {
	return String(s ?? "").replace(ANSI_RE, "");
}

/** Recursively strip ANSI from every string in a JSON-able payload. */
export function stripAnsiDeep(v) {
	if (typeof v === "string") return stripAnsi(v);
	if (Array.isArray(v)) return v.map(stripAnsiDeep);
	if (v && typeof v === "object") {
		const out = {};
		for (const k of Object.keys(v)) out[k] = stripAnsiDeep(v[k]);
		return out;
	}
	return v;
}

/**
 * Build the envelope. `data` is the command-specific payload; `error` (when
 * present) is a human-readable failure message carried at the top level and
 * drives `ok:false`.
 */
export function envelope({ command, data = {}, error } = {}) {
	const out = { ok: !error, command, apiVersion: API_VERSION, data };
	if (error != null) out.error = error;
	return out;
}

/** Serialize an envelope for stdout; strips ANSI and honors compact mode. */
export function serializeEnvelope(env, { compact = false } = {}) {
	return JSON.stringify(stripAnsiDeep(env), null, compact ? 0 : 2);
}
