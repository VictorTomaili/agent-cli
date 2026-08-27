// src/commands/mcp-cmds.js — `agent-cli mcp …`: use the MCP servers already
// configured in Claude Code, pi, or a project's .mcp.json, from the shell.
//
// Injected deps: { emit, log, c, isJson, EXIT }. Deliberately no `fail` — see
// failWith() below.
//
// The command set is deliberately small:
//
//   servers            what is configured, and whether agent-cli may run it
//   enable / disable   the approval step (see src/mcp/store.js for why)
//   tools              what an enabled server exposes; also warms the cache
//   call               invoke one tool
//
// ARGUMENTS ARE NEVER FREE POSITIONALS. `mcp call search --query hi` cannot
// work: commander parses `--query hi` as an option of `call`, not as data, and
// an unknown option either errors or — with a trailing variadic — is silently
// consumed into the option set and never reaches the tool. Verified directly:
// `mcp [rest...]` with `--name bob` yields rest=["my_tool"], opts={name:"bob"},
// so the tool would receive ZERO arguments while the user watched themselves
// type two. Every argument therefore goes through an explicit carrier:
// --arg k=v, --args-json, --args-file, or --args-stdin.

import fs from "node:fs";
import { readFileNoFollow } from "../util.js";
import { ERROR_KIND } from "../mcp/protocol.js";
import { McpError, withSession, listTools, callTool } from "../mcp/client.js";
import { discoverAll, resolveRef } from "../mcp/discover.js";
import {
	cleanRemote,
	cleanRemoteDeep,
	describeSecretRefs,
	safeUrl,
} from "../mcp/redact.js";
import {
	TRUST,
	cacheIsCold,
	cacheTools,
	disable as storeDisable,
	enable as storeEnable,
	readStore,
	refKey,
	serversForTool,
	trustOf,
} from "../mcp/store.js";

const SUBCOMMANDS = new Set(["servers", "tools", "call", "enable", "disable"]);

/**
 * Let `agent-cli mcp <tool> --arg k=v` mean `agent-cli mcp call <tool> …`.
 *
 * The shorthand is what the CLI is FOR — an agent reaching for one tool should
 * not have to know that `call` exists. It is done here, on argv, rather than by
 * giving the `mcp` command a variadic positional: a variadic would reintroduce
 * exactly the option-swallowing described above, whereas rewriting argv leaves
 * `call`'s own parsing strict and unchanged.
 */
export function expandMcpShorthand(argv) {
	// Anchored to the TOP-LEVEL command, not scanned for anywhere. `mcp` is this
	// project's own vocabulary, so it turns up inside ordinary free text — an
	// unanchored scan rewrote `agent-cli run refactor mcp client` into "refactor
	// mcp call client" and dispatched that altered prompt to a coding agent,
	// silently and with exit 0.
	//
	// Expects a full process.argv (execPath, script, then the command). Leading
	// global flags are skipped; every top-level option in cli.js is boolean, so
	// skipping "-"-prefixed tokens cannot skip an option's VALUE. Adding a
	// value-taking global option there would break that assumption — see the
	// note at the program.option() block.
	let i = 2;
	while (i < argv.length && argv[i].startsWith("-")) i++;
	if (argv[i] !== "mcp") return argv;
	const next = argv[i + 1];
	if (!next || next.startsWith("-") || SUBCOMMANDS.has(next)) return argv;
	return [...argv.slice(0, i + 1), "call", ...argv.slice(i + 1)];
}

/** `--arg k=v` repeated. Split on the FIRST `=` only, so a value may contain
 *  one; everything is a string, and `--args-json` is the way to send a number,
 *  a boolean, or any nested shape. */
function collectArg(pair, acc) {
	const eq = String(pair).indexOf("=");
	if (eq < 1)
		throw new McpError(
			ERROR_KIND.VALIDATION,
			`--arg expects key=value, got ${pair}`,
		);
	acc[String(pair).slice(0, eq)] = String(pair).slice(eq + 1);
	return acc;
}

function readStdin() {
	try {
		return fs.readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

/** Assemble tool arguments from exactly one structured source plus any --arg
 *  pairs, which override. More than one structured source is a usage error
 *  rather than a merge: a silent precedence rule is how a caller ends up
 *  sending arguments they did not write. */
function buildArgs(opts) {
	const structured = ["argsJson", "argsFile", "argsStdin"].filter((k) => opts[k]);
	if (structured.length > 1)
		throw new McpError(
			ERROR_KIND.VALIDATION,
			`pass only one of --args-json, --args-file, --args-stdin (got ${structured.length})`,
		);

	let base = {};
	let raw = null;
	if (opts.argsJson) raw = opts.argsJson;
	else if (opts.argsFile) raw = readFileNoFollow(opts.argsFile, { maxBytes: 4 * 1024 * 1024 });
	else if (opts.argsStdin) raw = readStdin();

	if (raw != null && String(raw).trim()) {
		try {
			base = JSON.parse(raw);
		} catch (err) {
			throw new McpError(
				ERROR_KIND.VALIDATION,
				`arguments were not valid JSON: ${err.message}`,
			);
		}
		if (!base || typeof base !== "object" || Array.isArray(base))
			throw new McpError(
				ERROR_KIND.VALIDATION,
				"tool arguments must be a JSON object",
			);
	}
	return { ...base, ...(opts.arg || {}) };
}

/** Flatten an MCP tool result into text for a terminal. Every string here came
 *  from a remote server, so it is redacted and control-stripped on the way out
 *  — including into the JSON envelope, which an agent reads as context. */
function renderContent(content, secretValues = []) {
	const parts = [];
	for (const item of content || []) {
		if (item?.type === "text") parts.push(cleanRemote(item.text, secretValues));
		else if (item?.type === "resource" && item.resource?.text)
			parts.push(cleanRemote(item.resource.text, secretValues));
		else if (item?.type)
			parts.push(`[${cleanRemote(item.type, secretValues)} content omitted]`);
	}
	return parts.join("\n");
}

/**
 * Turn any thrown error into the CLI's failure contract, so `errorKind` is
 * always present and always one of the known categories.
 *
 * This sets `process.exitCode` and returns rather than calling cli.js's
 * `fail()`, which exits immediately. Every command here is async, and on
 * Windows a pipe is written asynchronously — `process.exit()` from an async
 * action can tear the process down with the error envelope still queued, so the
 * caller reads a truncated payload or nothing at all. Returning lets Node exit
 * on its own once stdout has drained, with the same exit code.
 */
function failWith({ emit, log, isJson, EXIT }, command, err, extra = {}) {
	const kind = err instanceof McpError ? err.kind : ERROR_KIND.TRANSPORT;
	const detail = err instanceof McpError ? err.detail : null;
	const message = err?.message || String(err);
	emit({
		command,
		ok: false,
		error: message,
		errorKind: kind,
		...(detail ? { detail } : {}),
		...extra,
	});
	if (!isJson()) log.error(message);
	process.exitCode = EXIT.ERROR;
}

/** Refuse to run a server that is not approved at its current fingerprint. */
function requireTrust(def) {
	const t = trustOf(def);
	if (t.state === TRUST.ENABLED) return;
	if (t.state === TRUST.CHANGED)
		throw new McpError(
			ERROR_KIND.POLICY,
			`${refKey(def)} changed since it was enabled (approved ${t.approved}, now ${t.current}) — review it with \`agent-cli mcp servers\`, then re-run \`agent-cli mcp enable ${refKey(def)}\``,
		);
	throw new McpError(
		ERROR_KIND.POLICY,
		`${refKey(def)} is not enabled — run \`agent-cli mcp enable ${refKey(def)}\` to let agent-cli run it`,
	);
}

function sessionOpts(opts) {
	const out = {};
	if (opts.timeout) out.timeoutMs = Math.max(1000, Number(opts.timeout) * 1000);
	if (opts.allowInsecureLoopback) out.allowInsecureLoopback = true;
	return out;
}

/** Register the `mcp` command group. */
export function registerMcpCommands(program, { emit, log, c, isJson, EXIT }) {
	const ctx = { emit, log, isJson, EXIT };
	const mcp = program
		.command("mcp")
		.description(
			"Use the MCP servers already configured in Claude Code, pi, or .mcp.json. `agent-cli mcp <tool> --arg k=v` is shorthand for `mcp call`.",
		);

	// --- servers -------------------------------------------------------------
	mcp
		.command("servers")
		.description("List every configured MCP server and whether agent-cli may run it.")
		.action(() => {
			const { servers, skipped, paths } = discoverAll();
			const store = readStore();
			const rows = servers.map((def) => ({
				ref: refKey(def),
				name: def.name,
				source: def.source,
				scope: def.scope,
				transport: def.transport,
				// safeUrl, not def.url. A hosted server's credential usually lives IN
				// the URL — userinfo, a query param, or a token-shaped path segment
				// (`…/api/mcp/s/<token>/mcp`) — and this is the row an unattended
				// agent is most likely to print straight into its own context.
				target:
					def.transport === "http"
						? safeUrl(def.url)
						: [def.command, ...(def.args || [])].join(" "),
				unpinned: def.unpinned === true,
				fingerprint: def.fingerprint,
				trust: trustOf(def, store).state,
				// Key names and a state only — never a value, never a prefix.
				// def carries env, headers AND url: reporting `secrets: []` while
				// printing a URL-borne token was exactly the bug this closes.
				secrets: describeSecretRefs(def),
			}));
			emit({
				command: "mcp servers",
				sources: paths,
				servers: rows,
				skipped,
				enabledCount: rows.filter((r) => r.trust === TRUST.ENABLED).length,
			});
			if (isJson()) return;

			if (!rows.length) {
				log.warn("No MCP servers configured.");
				log.dim(`looked in ${Object.values(paths).join(", ")}`);
				return;
			}
			for (const r of rows) {
				const mark =
					r.trust === TRUST.ENABLED
						? c.green("●")
						: r.trust === TRUST.CHANGED
							? c.yellow("!")
							: c.gray("○");
				log.raw(`${mark} ${c.bold(r.ref)} ${c.gray(`(${r.transport})`)}`);
				log.dim(r.target);
				const notes = [];
				if (r.unpinned) notes.push("unpinned package runner");
				if (r.secrets.length) notes.push(`${r.secrets.length} credential field(s) in the harness config`);
				if (r.trust === TRUST.CHANGED) notes.push("definition changed since enable");
				if (notes.length) log.dim(notes.join(" · "));
			}
			for (const s of skipped) log.warn(`${s.count} ${s.source} server(s) skipped — ${s.skipped}`);
			log.raw("");
			log.dim("● enabled  ○ not enabled  ! changed — `agent-cli mcp enable <ref>`");
		});

	// --- enable / disable ----------------------------------------------------
	mcp
		.command("enable")
		.argument("<ref>", "server reference, e.g. pi:web-search-prime")
		.description("Let agent-cli run this server. Records its current definition.")
		.action((ref) => {
			try {
				const { servers } = discoverAll();
				const def = resolveRef(ref, servers);
				storeEnable(def, { at: new Date().toISOString() });
				emit({
					command: "mcp enable",
					ref: refKey(def),
					fingerprint: def.fingerprint,
					transport: def.transport,
					unpinned: def.unpinned === true,
				});
				if (isJson()) return;
				log.success(`enabled ${refKey(def)} at ${def.fingerprint}`);
				if (def.unpinned)
					log.warn(
						`${def.command} resolves the package at run time — what executes can change without this definition changing.`,
					);
			} catch (err) {
				failWith(ctx, "mcp enable", err);
			}
		});

	mcp
		.command("disable")
		.argument("<ref>", "server reference, e.g. pi:web-search-prime")
		.description("Withdraw approval. The harness config is left untouched.")
		.action((ref) => {
			const key = ref.includes(":") ? ref : null;
			let target = key;
			if (!target) {
				try {
					target = refKey(resolveRef(ref, discoverAll().servers));
				} catch (err) {
					failWith(ctx, "mcp disable", err);
					return;
				}
			}
			const existed = storeDisable(target);
			emit({ command: "mcp disable", ref: target, removed: existed });
			if (isJson()) return;
			if (existed) log.success(`disabled ${target}`);
			else log.info(`${target} was not enabled — nothing to do`);
		});

	// --- tools ---------------------------------------------------------------
	mcp
		.command("tools")
		.argument("[ref]", "one server; omit to list every enabled server")
		.option("--timeout <seconds>", "per-request budget", "60")
		.option("--allow-insecure-loopback", "permit plain http to localhost")
		.description("List the tools an enabled server exposes, and cache their names.")
		.action(async (ref, opts) => {
			try {
				const { servers } = discoverAll();
				const store = readStore();
				const targets = ref
					? [resolveRef(ref, servers)]
					: servers.filter((d) => trustOf(d, store).state === TRUST.ENABLED);

				if (!targets.length) {
					emit({ command: "mcp tools", servers: [], tools: [] });
					if (!isJson())
						log.warn("No enabled MCP servers — `agent-cli mcp servers` shows what is configured.");
					return;
				}

				const results = [];
				for (const def of targets) {
					requireTrust(def);
					// Carry the session's credential list out with the tools: a server
					// can echo its own key back in a tool NAME or DESCRIPTION, and
					// those go straight into the envelope an agent reads as context.
					const { tools, secretValues } = await withSession(
						def,
						async (session, o) => ({
							tools: await listTools(session, o),
							secretValues: session.secretValues,
						}),
						sessionOpts(opts),
					);
					cacheTools(def, tools.map((t) => t.name), { at: new Date().toISOString() });
					results.push({
						ref: refKey(def),
						tools: tools.map((t) => ({
							name: cleanRemote(String(t.name), secretValues),
							description: cleanRemote(
								String(t.description || ""),
								secretValues,
							).slice(0, 400),
						})),
					});
				}

				emit({
					command: "mcp tools",
					servers: results.map((r) => r.ref),
					tools: results.flatMap((r) => r.tools.map((t) => ({ ...t, ref: r.ref }))),
				});
				if (isJson()) return;
				for (const r of results) {
					log.raw(c.bold(r.ref));
					for (const t of r.tools)
						log.raw(`  ${c.cyan(t.name.padEnd(28))} ${c.gray(t.description.split("\n")[0].slice(0, 90))}`);
					if (!r.tools.length) log.dim("  (no tools)");
				}
			} catch (err) {
				failWith(ctx, "mcp tools", err);
			}
		});

	// --- call ----------------------------------------------------------------
	mcp
		.command("call")
		.argument("<tool>", "tool name, optionally qualified as <server>/<tool>")
		.option("--arg <key=value>", "one argument; repeatable", collectArg, {})
		.option("--args-json <json>", "all arguments as a JSON object")
		.option("--args-file <path>", "all arguments from a JSON file")
		.option("--args-stdin", "all arguments as JSON on stdin")
		.option("--server <ref>", "force a specific server")
		.option("--timeout <seconds>", "per-request budget", "60")
		.option("--allow-insecure-loopback", "permit plain http to localhost")
		.description("Invoke one MCP tool. Arguments go through --arg / --args-*, never as bare words.")
		.action(async (tool, opts) => {
			try {
				const slash = tool.indexOf("/");
				const serverRef = opts.server || (slash > 0 ? tool.slice(0, slash) : null);
				const toolName = slash > 0 ? tool.slice(slash + 1) : tool;
				const args = buildArgs(opts);

				const { servers } = discoverAll();
				const store = readStore();
				let def;
				if (serverRef) {
					def = resolveRef(serverRef, servers);
				} else {
					// Unqualified: the cache says which enabled server owns this name.
					const enabled = servers.filter(
						(d) => trustOf(d, store).state === TRUST.ENABLED,
					);
					const hits = serversForTool(toolName, enabled);
					if (hits.length === 1) def = hits[0];
					else if (hits.length > 1)
						throw new McpError(
							ERROR_KIND.RESOLUTION,
							`${toolName} is exposed by ${hits.map(refKey).join(" and ")} — qualify it as \`<server>/${toolName}\``,
						);
					else {
						// A changed definition invalidates its cached tool names, so
						// the symptom of a fingerprint mismatch is an empty lookup.
						// Reporting that as "no such tool" would bury the one thing
						// the user needs to know: the server's definition moved after
						// they approved it.
						const changed = servers.filter(
							(d) => trustOf(d, store).state === TRUST.CHANGED,
						);
						if (changed.length)
							throw new McpError(
								ERROR_KIND.POLICY,
								`${changed.map(refKey).join(", ")} changed since being enabled, so ${toolName} cannot be resolved — review with \`agent-cli mcp servers\`, then re-enable`,
							);
						throw new McpError(
							ERROR_KIND.RESOLUTION,
							cacheIsCold()
								? `no cached tool named ${toolName} — run \`agent-cli mcp tools\` once to learn what each enabled server exposes`
								: `no enabled server exposes ${toolName} — \`agent-cli mcp tools\` refreshes the list`,
						);
					}
				}
				requireTrust(def);

				// The server's own credentials come back out with the result. MCP
				// servers commonly report an auth failure as a tool RESULT with
				// isError rather than as a protocol error, and that text routinely
				// quotes the rejected credential — so this is the highest-volume
				// path by which a key gets echoed into an agent's context.
				const { result, secretValues } = await withSession(
					def,
					async (session, o) => ({
						result: await callTool(session, toolName, args, o),
						secretValues: session.secretValues,
					}),
					sessionOpts(opts),
				);

				const text = renderContent(result?.content, secretValues);
				const isError = result?.isError === true;
				emit({
					command: "mcp call",
					ok: !isError,
					...(isError ? { error: `tool ${toolName} reported failure`, errorKind: ERROR_KIND.TOOL } : {}),
					ref: refKey(def),
					tool: toolName,
					isError,
					content: text,
					// Server-authored JSON that lands in an envelope an agent reads as
					// context — it gets the same treatment as the text content, not a
					// pass because it happens to be structured.
					...(result?.structuredContent
						? {
								structuredContent: cleanRemoteDeep(
									result.structuredContent,
									secretValues,
								),
							}
						: {}),
				});
				if (!isJson()) {
					if (isError) log.error(`${toolName} reported failure`);
					if (text) log.raw(text);
				}
				// A tool that ran and reported failure is a real answer, not a
				// broken connection — but it must not exit 0, or a script cannot
				// tell success from failure.
				if (isError) process.exitCode = EXIT.ERROR;
			} catch (err) {
				failWith(ctx, "mcp call", err, { tool });
			}
		});
}
