// src/api/envelope.js — shared SDK envelope helper for the Phase 6 write SDK.
//
// Every MCP write tool returns the SAME envelope shape the CLI emits for
// `--json` (docs/contract.md): `{ ok, command, apiVersion, data, error?, code?,
// updateNotice? }` with `apiVersion: "2.0.0"`. The MCP layer in src/serve.js
// wraps this in the wire-shape `{ content: [{ type: "text", text:
// JSON.stringify(envelope) }], isError: !envelope.ok }`.
//
// Why a separate helper instead of reusing src/envelope.js? src/envelope.js is
// the CLI-side serializer (strips ANSI, serializes to stdout, adds
// `updateNotice` from a pre-action hook). The SDK helper is a PURE constructor
// that does not touch the filesystem or pre-action hooks. It accepts the
// precomputed `updateNotice` object (or no updateNotice at all), so the CLI
// update path stays a CLI-only concern and the MCP layer never invents
// update-advisory fields it didn't observe.
//
// Field rules:
//   - `error`  — a SHORT, stable string ("brain_write failed: kind X not
//                allowed"). NEVER a stack trace, NEVER an absolute path
//                (A12 / A15).
//   - `code`   — optional structured failure code so callers branch on a
//                constant, not on string parsing. Canonical values used by the
//                write SDK: "INVALID_KIND", "SCOPE_INVALID", "OPERATION_BUSY",
//                "BACKUP_FAILED", "ESCAPE", "INTERNAL", "APPLY_CHANGES_REQUIRED".
//                See individual write SDK functions for the codes they emit.
//   - `updateNotice` — pass through from the preAction hook when present;
//                omitted entirely when installed == latest (matches contract.md).

export const API_VERSION = "2.0.0";

/**
 * Build a success envelope. `data` is the command-specific payload (the shape
 * the underlying CLI command emits for `--json`). `updateNotice`, when
 * supplied, is attached verbatim — the MCP layer surfaces it to the host
 * agent the same way the CLI's preAction hook surfaces it to the user's
 * terminal.
 */
export function ok(command, data, { updateNotice } = {}) {
	const out = {
		ok: true,
		command,
		apiVersion: API_VERSION,
		data: data ?? {},
	};
	if (updateNotice) out.updateNotice = updateNotice;
	return out;
}

/**
 * Build a failure envelope. `error` is a short, stable, human-readable string
 * (no stack, no absolute path, no raw fs error). `code`, when supplied, is a
 * structured failure code callers can branch on; omit it only when no stable
 * code applies (the SDK always supplies one for known failure modes).
 */
export function err(command, error, { code } = {}) {
	const out = {
		ok: false,
		command,
		apiVersion: API_VERSION,
		data: {},
		error,
	};
	if (code) out.code = code;
	return out;
}