// src/mcp/redact.js - keep server-derived text and secret values out of
// anything agent-cli prints, caches, or returns in an envelope.
//
// Two separate jobs, both required by the security review of the MCP client:
//
//   redactSecrets()  - a spawned server's stderr, an HTTP error body, or a
//                      thrown error can echo back the credential it was handed.
//                      Every string that came from a server passes through here
//                      before it can reach stdout, a cache file, or an envelope.
//
//   sanitizeRemote() - tool names, descriptions and RESULTS are third-party
//                      text rendered into a terminal and fed into an agent's
//                      context. Strip control sequences that can rewrite the
//                      display, and cap the length.

/** Replacement shown in place of a redacted value. */
export const REDACTED = "[redacted]";

// Credential-shaped text, independent of whether we know the value. This is the
// net for secrets that reach us from a server's own output rather than from our
// own config, so it cannot rely on a known-values list.
const PATTERNS = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
	/\b(?:sk|pk|rk|api|key|token|secret)[-_][A-Za-z0-9_-]{16,}\b/gi,
	/\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
];

/**
 * Redact known secret values plus anything credential-shaped.
 *
 * `values` are the concrete secrets resolved for THIS invocation. They are
 * matched literally, which is the only reliable way to catch a key that a
 * server echoed back in a shape the patterns above do not recognise.
 */
export function redactSecrets(text, values = []) {
	if (text == null) return text;
	let out = String(text);
	// Longest first: a short value that is a prefix of a longer one must not
	// partially mask it and leave the tail readable.
	for (const v of [...values]
		.filter(Boolean)
		.map(String)
		.sort((a, b) => b.length - a.length)) {
		// Below this length a "secret" is not distinguishable from ordinary prose,
		// and blanket-replacing it would mangle the message we are trying to show.
		if (v.length < 8) continue;
		out = out.split(v).join(REDACTED);
	}
	for (const re of PATTERNS) out = out.replace(re, REDACTED);
	return out;
}

/**
 * Strip terminal control sequences from third-party text and cap its length.
 *
 * ANSI alone is not enough. BEL, backspace and carriage return let a server
 * rewrite what the user has already seen, which is a display-integrity problem
 * in a tool whose entire job is showing you what a remote server said.
 *
 * Escapes are written as \xNN rather than as literal bytes: control characters
 * in a source file are invisible in review, get mangled by editors, and make
 * tools classify the file as binary.
 */
export function sanitizeRemote(text, { maxBytes = 64 * 1024 } = {}) {
	if (text == null) return text;
	let out = String(text)
		// OSC: ESC ] ... terminated by BEL or ESC backslash
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		// CSI: ESC [ ... final byte
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		// remaining two-byte escape sequences
		.replace(/\x1b[@-Z\\-_]/g, "")
		// C0 except tab and newline, then DEL and the C1 range
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
	if (Buffer.byteLength(out, "utf8") > maxBytes) {
		out = Buffer.from(out, "utf8").subarray(0, maxBytes).toString("utf8");
		out += `\n... truncated at ${maxBytes} bytes`;
	}
	return out;
}

/** Both passes, in the order that matters: redact first, then sanitize. */
export function cleanRemote(text, values = [], opts) {
	return sanitizeRemote(redactSecrets(text, values), opts);
}

/**
 * cleanRemote over every string in a JSON-able structure, keys included.
 *
 * A tool's `structuredContent` is server-authored JSON that goes straight into
 * an envelope an agent reads as context. Cleaning only the `content` array would
 * leave that path unfiltered, so anything server-derived that reaches an
 * envelope goes through here instead.
 *
 * `maxDepth` bounds recursion: the payload is third-party, and a deeply nested
 * object would otherwise be able to exhaust the stack.
 */
export function cleanRemoteDeep(value, values = [], { maxDepth = 32, ...opts } = {}) {
	if (maxDepth < 0) return null;
	if (typeof value === "string") return cleanRemote(value, values, opts);
	if (Array.isArray(value))
		return value.map((v) => cleanRemoteDeep(v, values, { maxDepth: maxDepth - 1, ...opts }));
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
			out[cleanRemote(k, values, opts)] = cleanRemoteDeep(v, values, {
				maxDepth: maxDepth - 1,
				...opts,
			});
		}
		return out;
	}
	return value;
}

/**
 * Describe secret-bearing config fields WITHOUT their values.
 *
 * Envelopes report env/headers as key names plus a state, never a value and
 * never a prefix - a "first four characters" preview is still a leak, and these
 * harness files hold live API keys.
 */
/**
 * A path segment long and opaque enough to be a token rather than a route.
 *
 * Hosted remote MCP servers routinely carry the credential IN THE PATH
 * (`…/api/mcp/s/<token>/mcp`), where it looks like an ordinary segment. There is
 * no syntax that distinguishes the two, so this is a heuristic: 16+ characters
 * of token alphabet with no vowel-ish structure to it. It over-masks a long
 * route segment now and then, which is the right direction to be wrong in — the
 * cost is a slightly less readable path, not a published credential.
 */
const TOKENISH_SEGMENT_RE = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Credential values carried by a URL: userinfo, every query value, and any
 * token-shaped path segment.
 *
 * These belong in the same redaction list as env and header values. Without
 * them, a server that echoes its own URL back in a tool result — an extremely
 * common way for MCP servers to report an auth failure — republishes the
 * credential through output an agent reads as context.
 */
export function urlSecretValues(url) {
	if (!url) return [];
	let u;
	try {
		u = new URL(String(url));
	} catch {
		return [];
	}
	const out = [];
	if (u.password) out.push(u.password);
	if (u.username) out.push(u.username);
	for (const v of u.searchParams.values()) if (v) out.push(v);
	for (const seg of u.pathname.split("/"))
		if (TOKENISH_SEGMENT_RE.test(seg)) out.push(seg);
	return out;
}

/**
 * Render a server URL safely for display: origin + path, userinfo dropped,
 * query values and token-shaped path segments masked.
 *
 * `mcp servers` is the vetting command an unattended agent is most likely to
 * run and dump into its context, so the whole point of the row is to be safe to
 * look at. Returns a marker rather than the input when parsing fails — an
 * unparseable URL is exactly the case where echoing it back is least safe.
 */
export function safeUrl(url) {
	if (!url) return "";
	let u;
	try {
		u = new URL(String(url));
	} catch {
		return "[unparseable url]";
	}
	const path = u.pathname
		.split("/")
		.map((seg) => (TOKENISH_SEGMENT_RE.test(seg) ? REDACTED : seg))
		.join("/");
	const query = [...u.searchParams.keys()]
		.map((k) => `${k}=${REDACTED}`)
		.join("&");
	return `${u.origin}${path}${query ? `?${query}` : ""}`;
}

export function describeSecretRefs({ env = {}, headers = {}, url = null } = {}) {
	const refs = [];
	for (const [k, v] of Object.entries(env || {}))
		refs.push({ field: `env.${k}`, state: classifyRef(v) });
	for (const [k, v] of Object.entries(headers || {}))
		refs.push({ field: `headers.${k}`, state: classifyRef(v) });
	// A URL-borne credential is a credential. Reporting `secrets: []` next to a
	// printed token was the bug this closes.
	if (url) {
		let u = null;
		try {
			u = new URL(String(url));
		} catch {
			/* unparseable — nothing to enumerate */
		}
		if (u) {
			if (u.username || u.password)
				refs.push({ field: "url.userinfo", state: "literal-in-harness" });
			for (const [k, v] of u.searchParams)
				refs.push({ field: `url.${k}`, state: classifyRef(v) });
			for (const seg of u.pathname.split("/"))
				if (TOKENISH_SEGMENT_RE.test(seg))
					refs.push({ field: "url.path-segment", state: "literal-in-harness" });
		}
	}
	return refs;
}

/**
 * "literal-in-harness" means the harness config holds the credential in
 * plaintext. On a typical machine that is the state of EVERY secret field, and
 * it is why adoption defaults to disabled: agent-cli will not start executing a
 * server with a credential the user never explicitly handed it.
 */
function classifyRef(value) {
	const s = String(value ?? "");
	if (!s) return "unresolved";
	return "literal-in-harness";
}
