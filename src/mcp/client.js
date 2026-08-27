// src/mcp/client.js — agent-cli as an MCP CLIENT.
//
// agent-cli already speaks MCP as a SERVER (src/serve.js). This is the other
// direction: connecting to the servers a user has configured in Claude Code, pi
// or elsewhere, and calling their tools from the command line. Both sides share
// the wire constants and framing in ./protocol.js, so they cannot drift.
//
// Hand-rolled rather than taking the MCP SDK, matching serve.js. The surface we
// need is small (initialize, tools/list, tools/call) and the dependency-free
// build is worth more than the abstraction.
//
// SECURITY POSTURE — every item here came out of the threat model, and the
// reasoning is recorded because each looks like an over-reaction until it does
// not:
//
//   Environment allowlist. A stdio server is spawned with a MINIMAL env plus
//   only the keys its own definition names. Spreading process.env hands every
//   adopted server every credential in the session — ANTHROPIC_API_KEY,
//   GITHUB_TOKEN, AWS_*, anything the user exported.
//
//   Tree kill. `npx -y <pkg>` is node running npx-cli.js which spawns the real
//   server as a GRANDCHILD. Killing the direct child leaves that grandchild
//   holding the terminal. On win32 kill() cannot reach a process tree, so we
//   shell out to taskkill /T.
//
//   Signal handlers, not process.on("exit"). An "exit" handler does NOT fire on
//   SIGINT unless a SIGINT listener is registered — which is exactly the moment
//   a user aborts a slow cold start, and exactly when an orphan is created.
//
//   No redirect following. A server URL comes from a config file. Node's fetch
//   follows up to 20 redirects by default and would carry the Authorization
//   header along, so a redirect to an attacker host exfiltrates the credential.
//
//   Host policy. https is required except on loopback, and link-local /
//   metadata / private-range literals are refused outright: a URL pointing at
//   169.254.169.254 turns this client into an SSRF primitive.

import { spawn, spawnSync } from "node:child_process";
import {
	PROTOCOL_VERSION,
	CLIENT_INFO,
	ERROR_KIND,
	createDecoder,
	encode,
	notification,
	request,
} from "./protocol.js";
import { redactSecrets } from "./redact.js";

/** Overall default budget for one connect+call cycle. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** A cold `npx -y` install can legitimately take a while; the handshake alone
 *  gets its own shorter budget so a hung server fails with a useful message
 *  instead of consuming the whole allowance in silence. */
export const DEFAULT_HANDSHAKE_MS = 20_000;
/** Cap on a single response payload. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** An error carrying the machine-readable kind callers branch on. */
export class McpError extends Error {
	constructor(kind, message, detail = null) {
		super(message);
		this.name = "McpError";
		this.kind = kind;
		this.detail = detail;
	}
}

// --- environment ------------------------------------------------------------

// The only parent variables a spawned server inherits. PATH is required to find
// the binary at all; the rest are what a Node or Python process needs to start
// and locate a temp dir. Everything else is withheld by default.
const ENV_ALLOWLIST = [
	"PATH",
	"Path",
	"PATHEXT",
	"HOME",
	"USERPROFILE",
	"SystemRoot",
	"SystemDrive",
	"windir",
	"COMSPEC",
	"TEMP",
	"TMP",
	"TMPDIR",
	"APPDATA",
	"LOCALAPPDATA",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"NODE_OPTIONS",
];

/**
 * Build the child environment: allowlisted parent vars plus this server's own
 * declared keys. Never a spread of process.env.
 */
export function buildChildEnv(serverEnv = {}, parent = process.env) {
	const env = Object.create(null);
	for (const key of ENV_ALLOWLIST) {
		if (parent[key] !== undefined) env[key] = parent[key];
	}
	for (const [k, v] of Object.entries(serverEnv || {})) {
		if (v !== undefined && v !== null) env[k] = String(v);
	}
	return env;
}

// --- URL policy -------------------------------------------------------------

// Address prefixes that must never be reachable through a config-supplied URL.
// Cloud metadata endpoints are the headline case: a single GET against
// 169.254.169.254 can return instance credentials.
//
// Matched against the whole hostname rather than against parsed IP literals, so
// it also refuses a DNS name whose first label is bare digits (10.example.com).
// That over-block is deliberate. Putting an SSRF control behind a second
// "is this an IP literal" parser means every form that parser misses becomes a
// live path to 169.254.169.254, and the URL parser accepts more forms than are
// obvious (`https://2130706433/` and `https://0x7f.1/` both normalize to
// 127.0.0.1). Blunt and fail-closed beats clever and exhaustive here.
const BLOCKED_HOST_RE =
	/^(?:169\.254\.|127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[::\]$|\[?fd[0-9a-f]{2}:|\[?fe80:)/i;

// IPv6 can carry an IPv4 address inside it, and the URL parser rewrites the
// dotted form to hex — `[::ffff:169.254.169.254]` becomes `[::ffff:a9fe:a9fe]`,
// which none of the IPv4 prefixes above can see. That is a real bypass of the
// metadata block, so every embedded form is expanded back to a dotted quad and
// tested as well. `::ffff:` is the IPv4-mapped form; `64:ff9b::` is the
// well-known NAT64 prefix, which reaches the same address through a translator.
const V4_IN_V6_RE = /^\[(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i;

/**
 * Every spelling of a host that the denylist should be tested against.
 *
 * This only ever ADDS candidates. A gap in the expansion below can therefore
 * only fail to block something the current regex already missed — it can never
 * un-block an address, which is the failure mode that matters.
 */
function hostCandidates(host) {
	const candidates = [host];
	const m = V4_IN_V6_RE.exec(host);
	if (m) {
		const hi = Number.parseInt(m[1], 16);
		const lo = Number.parseInt(m[2], 16);
		candidates.push(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
	}
	return candidates;
}

const LOOPBACK_RE = /^(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;

/**
 * Validate a server URL before any request is made.
 * `allowInsecureLoopback` permits plain http, but ONLY to a loopback host.
 */
export function assertUrlAllowed(rawUrl, { allowInsecureLoopback = false } = {}) {
	let u;
	try {
		u = new URL(String(rawUrl));
	} catch {
		throw new McpError(ERROR_KIND.VALIDATION, `not a valid URL: ${rawUrl}`);
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") {
		throw new McpError(
			ERROR_KIND.POLICY,
			`refusing ${u.protocol} — only http(s) MCP endpoints are supported`,
		);
	}
	const host = u.hostname;
	const loopback = LOOPBACK_RE.test(host);
	if (u.protocol === "http:" && !(loopback && allowInsecureLoopback)) {
		throw new McpError(
			ERROR_KIND.POLICY,
			loopback
				? `refusing plain http to ${host} — pass --allow-insecure-loopback to permit it`
				: `refusing plain http to ${host} — credentials would cross the network in the clear`,
		);
	}
	// Loopback is blocked by the range test too, so exempt it once it has
	// cleared the scheme check above.
	if (!loopback && hostCandidates(host).some((h) => BLOCKED_HOST_RE.test(h))) {
		throw new McpError(
			ERROR_KIND.POLICY,
			`refusing ${host} — link-local, metadata and private-range addresses are not reachable through a config-supplied URL`,
		);
	}
	return u;
}

// --- child process cleanup --------------------------------------------------

const liveChildren = new Set();
let signalsBound = false;

/** Kill a process tree. `child.kill()` reaches only the direct child, and on
 *  win32 it cannot reach a tree at all. */
function killTree(child) {
	if (!child || child.exitCode !== null || child.signalCode) return;
	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
			});
			return;
		} catch {
			/* fall through to kill() */
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		/* already gone */
	}
}

/** Bind SIGINT/SIGTERM once, so Ctrl-C during a slow cold start cannot orphan a
 *  server. process.on("exit") is NOT enough: it does not fire on a signal
 *  unless a listener for that signal is registered. */
function bindSignals() {
	if (signalsBound) return;
	signalsBound = true;
	const cleanup = () => {
		for (const c of liveChildren) killTree(c);
		liveChildren.clear();
	};
	process.on("exit", cleanup);
	for (const sig of ["SIGINT", "SIGTERM"]) {
		process.on(sig, () => {
			cleanup();
			// Re-raise with the default disposition so the exit code is honest.
			process.exit(sig === "SIGINT" ? 130 : 143);
		});
	}
}

// --- sessions ---------------------------------------------------------------

/**
 * One connected MCP server. Both transports expose the same three methods, so
 * callers never branch on transport.
 */
class Session {
	constructor({ name, secretValues = [] }) {
		this.name = name;
		this.secretValues = secretValues;
		this.serverInfo = null;
		this.protocolVersion = null;
		/** Non-JSON output a server printed before/among its protocol messages.
		 *  Kept for diagnostics; redacted before it can ever be surfaced. */
		this.noise = [];
		this.stderr = "";
	}
	/** Redact anything derived from the server before it escapes this object. */
	clean(text) {
		return redactSecrets(text, this.secretValues);
	}
}

class StdioSession extends Session {
	constructor(opts) {
		super(opts);
		this.child = null;
		this.decoder = createDecoder();
		this.pending = new Map();
		this.closed = false;
	}

	async open({ command, args = [], cwd, env, handshakeMs }) {
		bindSignals();
		const child = spawn(command, args, {
			cwd: cwd || undefined,
			env: buildChildEnv(env),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			// Never through a shell: the command and args come from a config
			// file, and a shell would make every metacharacter in them live.
			shell: false,
		});
		this.child = child;
		liveChildren.add(child);

		child.on("error", (err) => this.#failAll(
			new McpError(
				ERROR_KIND.TRANSPORT,
				`could not start ${command}: ${err.code === "ENOENT" ? "command not found" : err.message}`,
			),
		));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => this.#onData(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			// Ring-buffered: a chatty server must not grow this without bound.
			this.stderr = (this.stderr + chunk).slice(-8192);
		});
		child.on("exit", (code, signal) => {
			liveChildren.delete(child);
			this.#failAll(
				new McpError(
					ERROR_KIND.TRANSPORT,
					`server exited (${signal ? `signal ${signal}` : `code ${code}`})`,
					this.diagnostics(),
				),
			);
		});

		await this.#handshake(handshakeMs);
	}

	#onData(chunk) {
		const { messages, noise, overflow } = this.decoder.push(chunk);
		for (const line of noise) this.noise.push(line.slice(0, 400));
		if (overflow) {
			this.#failAll(
				new McpError(ERROR_KIND.PROTOCOL, "server sent an unterminated line"),
			);
			return;
		}
		for (const msg of messages) {
			if (msg.id == null) continue; // server notification — nothing awaits it
			const waiter = this.pending.get(msg.id);
			if (!waiter) continue;
			this.pending.delete(msg.id);
			if (msg.error) {
				waiter.reject(
					new McpError(
						ERROR_KIND.PROTOCOL,
						this.clean(msg.error.message || "server returned an error"),
						msg.error.data == null ? null : this.clean(JSON.stringify(msg.error.data)),
					),
				);
			} else {
				waiter.resolve(msg.result);
			}
		}
	}

	#failAll(err) {
		for (const [, waiter] of this.pending) waiter.reject(err);
		this.pending.clear();
	}

	async #handshake(handshakeMs) {
		const result = await this.send(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: CLIENT_INFO,
			},
			handshakeMs,
		);
		this.protocolVersion = result?.protocolVersion ?? null;
		this.serverInfo = result?.serverInfo ?? null;
		this.#write(notification("notifications/initialized"));
	}

	#write(msg) {
		if (this.closed || !this.child?.stdin?.writable) return;
		this.child.stdin.write(encode(msg));
	}

	send(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
		const msg = request(method, params);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(msg.id);
				reject(
					new McpError(
						ERROR_KIND.TIMEOUT,
						`${method} timed out after ${timeoutMs}ms`,
						this.diagnostics(),
					),
				);
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(msg.id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.#write(msg);
		});
	}

	/**
	 * Everything we know about why a call failed. A timeout that reports only
	 * "timed out" is unactionable — the reason is almost always in the stderr
	 * or the non-JSON stdout the server produced first.
	 */
	diagnostics() {
		const d = {};
		if (this.stderr.trim()) d.stderr = this.clean(this.stderr.trim()).slice(-2000);
		if (this.noise.length) d.stdout = this.noise.slice(-10).map((l) => this.clean(l));
		return Object.keys(d).length ? d : null;
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		this.#failAll(new McpError(ERROR_KIND.TRANSPORT, "session closed"));
		try {
			this.child?.stdin?.end();
		} catch {
			/* already gone */
		}
		if (this.child) {
			killTree(this.child);
			liveChildren.delete(this.child);
		}
	}
}

class HttpSession extends Session {
	constructor(opts) {
		super(opts);
		this.url = null;
		this.headers = {};
		this.maxBytes = DEFAULT_MAX_BYTES;
	}

	async open({ url, headers = {}, allowInsecureLoopback, handshakeMs, maxBytes }) {
		this.url = assertUrlAllowed(url, { allowInsecureLoopback });
		this.headers = headers || {};
		if (maxBytes) this.maxBytes = maxBytes;
		const result = await this.send(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: CLIENT_INFO,
			},
			handshakeMs,
		);
		this.protocolVersion = result?.protocolVersion ?? null;
		this.serverInfo = result?.serverInfo ?? null;
	}

	async send(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
		const msg = request(method, params);
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		timer.unref?.();
		let res;
		try {
			// lgtm[js/file-access-to-http] — the config-sourced url and headers ARE
			// the destination and its own credential, going to the party that issued
			// it; redirect:"manual" and assertUrlAllowed bound where they can go, and
			// fingerprint() covers both so an edited config revokes trust instead of
			// redirecting it.
			res = await fetch(this.url, {
				method: "POST",
				// Refused outright rather than followed: the Authorization header
				// would otherwise travel to whatever host the redirect names.
				redirect: "manual",
				signal: ac.signal,
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					...this.headers,
				},
				body: JSON.stringify(msg),
			});
		} catch (err) {
			clearTimeout(timer);
			if (err?.name === "AbortError")
				throw new McpError(
					ERROR_KIND.TIMEOUT,
					`${method} timed out after ${timeoutMs}ms`,
				);
			throw new McpError(
				ERROR_KIND.TRANSPORT,
				this.clean(`request failed: ${err?.message || err}`),
			);
		}

		if (res.status >= 300 && res.status < 400) {
			clearTimeout(timer);
			throw new McpError(
				ERROR_KIND.POLICY,
				`server redirected (${res.status}) — refusing to follow, credentials would travel to the new host`,
			);
		}

		// The timer stays armed across the body read. Clearing it at the end of
		// the fetch would leave the abort signal dead for the whole download, and
		// a server that drips one byte per second then holds the CLI open
		// indefinitely — the byte cap below does not bound TIME, only size.
		let body;
		try {
			body = await this.#readCapped(res);
		} catch (err) {
			if (err?.name === "AbortError")
				throw new McpError(
					ERROR_KIND.TIMEOUT,
					`${method} timed out after ${timeoutMs}ms`,
				);
			throw new McpError(
				ERROR_KIND.TRANSPORT,
				this.clean(`reading response failed: ${err?.message || err}`),
			);
		} finally {
			clearTimeout(timer);
		}

		if (!res.ok) {
			throw new McpError(
				ERROR_KIND.TRANSPORT,
				`HTTP ${res.status}${res.status === 401 || res.status === 403 ? " — the stored credential was rejected" : ""}`,
				this.clean(body).slice(0, 2000) || null,
			);
		}
		const payload = this.#parse(body);
		if (payload?.error) {
			throw new McpError(
				ERROR_KIND.PROTOCOL,
				this.clean(payload.error.message || "server returned an error"),
			);
		}
		return payload?.result;
	}

	/**
	 * Read the body, stopping at `maxBytes` of ACTUAL bytes.
	 *
	 * `res.text()` would materialize the whole response first and let the cap
	 * trim a string that is already resident — measured at 426MB of RSS for a
	 * 400MB body under a 1KB cap, and undici decompresses gzip transparently, so
	 * ~300KB on the wire is enough to reach it. Reading incrementally gives the
	 * HTTP transport the same bounded-buffer guarantee protocol.js already gives
	 * stdio, and the reader is CANCELLED rather than drained so a hostile server
	 * does not keep streaming into a socket nobody is reading.
	 */
	async #readCapped(res) {
		if (!res.body) return "";
		const reader = res.body.getReader();
		const chunks = [];
		let total = 0;
		try {
			while (total < this.maxBytes) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				chunks.push(value);
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		return Buffer.concat(chunks).subarray(0, this.maxBytes).toString("utf8");
	}

	/** Accepts a plain JSON body or an SSE stream carrying `data:` frames,
	 *  which is what the streamable-HTTP transport emits. */
	#parse(body) {
		const trimmed = String(body).trim();
		if (!trimmed) return null;
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				return JSON.parse(trimmed);
			} catch {
				throw new McpError(ERROR_KIND.PROTOCOL, "response was not valid JSON");
			}
		}
		for (const line of trimmed.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (!data || data === "[DONE]") continue;
			try {
				return JSON.parse(data);
			} catch {
				/* keep scanning — a stream can carry comments and keepalives */
			}
		}
		throw new McpError(ERROR_KIND.PROTOCOL, "no JSON-RPC payload in response");
	}

	close() {
		/* stateless */
	}
}

/**
 * Connect to one server definition and run `fn` against the session, closing it
 * afterwards no matter what. Callers never manage a session by hand, so a throw
 * in rendering cannot orphan a child.
 */
export async function withSession(def, fn, opts = {}) {
	const {
		timeoutMs = DEFAULT_TIMEOUT_MS,
		handshakeMs = DEFAULT_HANDSHAKE_MS,
		allowInsecureLoopback = false,
		maxBytes = DEFAULT_MAX_BYTES,
	} = opts;
	const secretValues = [
		...Object.values(def.env || {}),
		...Object.values(def.headers || {}),
	]
		.filter(Boolean)
		.map(String);

	const session =
		def.transport === "http"
			? new HttpSession({ name: def.name, secretValues })
			: new StdioSession({ name: def.name, secretValues });

	try {
		if (def.transport === "http") {
			await session.open({
				url: def.url,
				headers: def.headers,
				allowInsecureLoopback,
				handshakeMs,
				maxBytes,
			});
		} else {
			await session.open({
				command: def.command,
				args: def.args,
				cwd: def.cwd,
				env: def.env,
				handshakeMs,
			});
		}
		return await fn(session, { timeoutMs });
	} finally {
		session.close();
	}
}

/** `tools/list` with pagination followed to the end. */
export async function listTools(session, { timeoutMs } = {}) {
	const tools = [];
	let cursor;
	do {
		const res = await session.send(
			"tools/list",
			cursor ? { cursor } : undefined,
			timeoutMs,
		);
		for (const t of res?.tools || []) tools.push(t);
		cursor = res?.nextCursor;
	} while (cursor);
	return tools;
}

/** `tools/call`. A tool that reports failure is a SUCCESSFUL round trip and is
 *  returned, not thrown — the caller distinguishes it via `isError`. */
export async function callTool(session, name, args, { timeoutMs } = {}) {
	return session.send(
		"tools/call",
		{ name, arguments: args ?? {} },
		timeoutMs,
	);
}
