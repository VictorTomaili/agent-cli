// src/commands/delegation.js — handoff + agents, extracted from cli.js (HIGH-3).
// Injected deps: { emit, fail, log, c, pretty, EXIT, isJson, listAgents,
//   showAgent, scaffoldAgent, validateAgent, GLOBAL_AGENTS_DIR,
//   projectAgentsDir, readFile, spawnSync, path, parseEditorCommand,
//   cmdShimSpawnSync, resolveContained }.

/** Register the handoff + agents commands. */
export function registerDelegationCommands(
	program,
	{
		emit,
		fail,
		log,
		c,
		pretty,
		EXIT,
		isJson,
		listAgents,
		showAgent,
		scaffoldAgent,
		validateAgent,
		GLOBAL_AGENTS_DIR,
		projectAgentsDir,
		readFile,
		spawnSync,
		path,
		parseEditorCommand,
		cmdShimSpawnSync,
		resolveContained,
	},
) {
	// agent-cli handoff / whoami — delegation artifacts + identity summary
	// ---------------------------------------------------------------------------
	program
		.command("handoff <action> [id]")
		.description(
			"Delegation artifacts: create --to <name> --task <text> | list | show <id> | accept <id> | close <id> [--lesson <topic>] — tracked, stateful handoffs (unlike `agents delegate`'s one-shot prompt).",
		)
		.option("--to <name>", "(create) target agent")
		.option("--task <text>", "(create) task text")
		.option("--context <text>", "(create) context")
		.option("--lesson <topic>", "(close) file a lesson on close")
		.action(async (action, id, opts) => {
			const h = await import("../handoff.js");
			if (action === "create") {
				const r = await h.createHandoff({
					to: opts.to,
					task: opts.task,
					context: opts.context,
					cwd: process.cwd(),
				});
				emit({ command: "handoff", action, ...r });
				if (!isJson()) {
					if (!r.ok) {
						log.error(r.reason);
						process.exit(EXIT.ERROR);
					}
					log.success(`Handoff ${r.id} → ${r.to}: ${pretty(r.file)}`);
				}
				if (!r.ok) process.exit(EXIT.ERROR);
				return;
			}
			if (action === "list") {
				const list = await h.listHandoffs();
				emit({ command: "handoff", action, count: list.length, handoffs: list });
				if (!isJson()) {
					if (!list.length) log.info("No handoffs.");
					for (const x of list)
						log.raw(
							`  ${c.bold(x.id.padEnd(20))} ${x.status.padEnd(9)} → ${x.to} ${c.gray(x.task)}`,
						);
				}
				return;
			}
			if (action === "show") {
				if (!id) fail("Usage: agent-cli handoff show <id>");
				const r = await h.showHandoff(id);
				emit({ command: "handoff", action, ...r });
				if (!isJson()) {
					if (!r.ok) {
						log.error(r.reason);
						process.exit(EXIT.ERROR);
					}
					process.stdout.write(r.content + "\n");
				}
				if (!r.ok) process.exit(EXIT.ERROR);
				return;
			}
			if (action === "accept" || action === "close") {
				if (!id) fail(`Usage: agent-cli handoff ${action} <id>`);
				const r =
					action === "accept"
						? await h.acceptHandoff(id)
						: await h.closeHandoff(id, {
								lesson: opts.lesson,
								cwd: process.cwd(),
							});
				emit({ command: "handoff", action, ...r });
				if (!isJson()) {
					if (!r.ok) {
						log.error(r.reason);
						process.exit(EXIT.ERROR);
					}
					log.success(`${id} → ${r.status}`);
					if (r.lesson?.file) log.dim(`Lesson: ${pretty(r.lesson.file)}`);
				}
				if (!r.ok) process.exit(EXIT.ERROR);
				return;
			}
			fail(`Unknown handoff action: ${action}. Use create|list|show|accept|close`);
		});

	/**
	 * A personality name must resolve to ONE filename segment.
	 *
	 * `resolveContained` is not sufficient on its own here: it is purely lexical,
	 * so `shared/CLAUDE` stays "inside" the agents dir on paper while a symlink
	 * pre-planted at `.agents/agents/shared` sends the write wherever it points.
	 * A checked-out repo controls that directory, and git materializes symlinks
	 * on checkout (a Windows junction needs no elevation). Same rule
	 * `scaffoldAgent` (agents-lib.js) already applies to a user-supplied name.
	 *
	 * Callers must ALSO write through util's atomic writer — this check cannot
	 * see a symlink planted at the final destination itself.
	 */
	function unsafeAgentSegment(raw) {
		const s = String(raw ?? "");
		return (
			!s || /[\\/]/.test(s) || s === "." || s === ".." || path.isAbsolute(s)
		);
	}

	// agent-cli edit / pull / where
	// ---------------------------------------------------------------------------
	program
		.command("agents [action] [name] [rest...]")
		.description(
			"Manage reusable sub-agent personalities: list | show | new | validate | path | roster | edit | rename | remove | export | import | delegate (prompt-only — use `handoff` for tracked delegation)",
		)
		.option("-p, --project", "project-local scope (for new)")
		.option("--name <name>", "(import) override the personality name")
		.option("--task <text>", "(delegate) task text for the delegation prompt")
		.action(async (action, name, rest, opts) => {
			action = action || "list";
			const cwd = process.cwd();
			if (action === "list") {
				const list = await listAgents({ includeProject: true, cwd });
				emit({ command: "agents", action, count: list.length, agents: list });
				if (!isJson()) {
					if (!list.length)
						log.warn(
							"No personalities yet — create one: agent-cli agents new <name>",
						);
					for (const a of list)
						log.raw(
							`${a.scope === "project" ? c.cyan("[proj]") : c.gray("[glob]")} ${c.bold(a.name.padEnd(16))} ${a.description}`,
						);
				}
				return;
			}
			if (action === "show") {
				if (!name) {
					fail("Usage: agent-cli agents show <name>");
				}
				const a = await showAgent(name, { cwd });
				if (!a) {
					fail(`No agent named '${name}'`);
				}
				const fsp = (await import("node:fs/promises")).default;
				const content = await fsp.readFile(a.path, "utf8");
				if (isJson()) emit({ command: "agents", action, agent: a, content });
				else process.stdout.write(content);
				return;
			}
			if (action === "new") {
				if (!name) {
					fail("Usage: agent-cli agents new <name>");
				}
				const r = await scaffoldAgent(name, {
					scope: opts.project ? "project" : "global",
					cwd,
				});
				emit({ command: "agents", action, name, ...r });
				if (!isJson())
					log.success(`${r.created ? "Created" : "Exists"}: ${pretty(r.path)}`);
				return;
			}
			if (action === "path") {
				const out = {
					global: GLOBAL_AGENTS_DIR,
					project: projectAgentsDir(cwd),
				};
				emit({ command: "agents", action, ...out });
				if (!isJson()) {
					log.kv("global", pretty(out.global));
					log.kv("project", pretty(out.project));
				}
				return;
			}
			if (action === "validate") {
				const list = await listAgents({ includeProject: true, cwd });
				let targets;
				let missing = null;
				if (name) {
					targets = list.filter((a) => a.name === name);
					if (!targets.length) {
						missing = name;
						targets = [];
					}
				} else {
					targets = list;
				}
				const results = [];
				for (const a of targets) results.push(await validateAgent(a.path));
				const valid = results.length > 0 && results.every((r) => r.valid);
				const out = {
					command: "agents",
					action: "validate",
					valid,
					count: results.length,
					results,
				};
				if (missing) out.missing = missing;
				emit(out);
				if (!isJson()) {
					if (missing) log.error(`No agent named '${missing}'`);
					for (const r of results) {
						const issueText = r.issues.length
							? c.gray(r.issues.join("; "))
							: c.green("ok");
						const warningText = r.warnings?.length
							? c.yellow(" — " + r.warnings.join("; "))
							: "";
						log.raw(
							`  ${r.valid ? c.green("✓") : c.red("✗")} ${c.bold(r.name)} ${issueText}${warningText}`,
						);
					}
				}
				// Machine-actionable failure: invalid or missing personalities exit non-zero.
				if (!valid) process.exit(1);
				return;
			}
			if (action === "roster") {
				const agentsList = await listAgents({ includeProject: true, cwd });
				const modelsMod = await import("../models.js");
				const aliases = modelsMod.getAliases();
				const rows = agentsList.map((a) => ({
					...a,
					resolvedModel: a.model ? (aliases[a.model]?.model ?? null) : null,
					aliasResolved: a.model ? Boolean(aliases[a.model]) : true,
				}));
				emit({
					command: "agents",
					action: "roster",
					count: rows.length,
					agents: rows,
				});
				if (!isJson())
					for (const r of rows)
						log.raw(
							`  ${c.bold(r.name.padEnd(16))} ${r.model ?? c.gray("—")} → ${r.resolvedModel ?? c.yellow("UNRESOLVED")} ${c.gray("(" + r.scope + ")")}`,
						);
				return;
			}
			if (action === "edit") {
				if (!name) fail("Usage: agent-cli agents edit <name>");
				const a = await showAgent(name, { cwd });
				if (!a) fail(`No agent named '${name}'`);
				emit({ command: "agents", action: "edit", name, path: a.path });
				// L1: never hand the editor string OR the repo-controlled agent path
				// to a shell. `a.path` is a *.md filename read straight from the
				// project agents dir, so a checked-out repo controls it; with
				// shell:true a name like `x&calc&.md` / `$(…)` would execute. Parse
				// $VISUAL/$EDITOR into argv (quote-aware) and spawn directly — same
				// hardening as `edit` (src/commands/edit.js).
				const rawEditor =
					process.env.VISUAL ||
					process.env.EDITOR ||
					(process.platform === "win32" ? "notepad" : "vi");
				const editorArgs = parseEditorCommand(rawEditor);
				if (!editorArgs)
					fail(
						`Cannot parse $VISUAL/$EDITOR (${JSON.stringify(rawEditor)}) — fix the variable (balanced quotes) or unset it.`,
					);
				let r = spawnSync(editorArgs[0], [...editorArgs.slice(1), a.path], {
					stdio: "inherit",
				});
				if (
					process.platform === "win32" &&
					r.error &&
					(r.error.code === "ENOENT" || r.error.code === "EINVAL")
				) {
					// Windows .cmd/.bat shims can't be CreateProcess'd directly — try
					// the guarded cmd.exe fallback (null when args carry metacharacters).
					const viaCmd = cmdShimSpawnSync(spawnSync, editorArgs, a.path);
					if (viaCmd) r = viaCmd;
				}
				if (r.error || r.status !== 0)
					process.exit(r.status != null ? r.status : 1);
				return;
			}
			if (action === "rename") {
				const [newName] = rest || [];
				if (!name || !newName) fail("Usage: agent-cli agents rename <old> <new>");
				const a = await showAgent(name, { cwd });
				if (!a) fail(`No agent named '${name}'`);
				const content = await readFile(a.path);
				const updated = content.replace(/^name:\s*.*$/m, `name: ${newName}`);
				const fspMod = await import("node:fs/promises");
				// Same write sink as `agents import` above, and it was unguarded:
				// `agents rename x ../../../.claude/CLAUDE` wrote outside the agents
				// dir and removed the original. newName is operator-typed rather than
				// repo-controlled, but the containment rule is the same either way.
				const agentsDir = path.dirname(a.path);
				const unsafeNew = `Refusing rename: unsafe agent name ${JSON.stringify(newName)} — a name must be a single filename segment (no path separators, no '..').`;
				if (unsafeAgentSegment(newName)) fail(unsafeNew);
				const newPath = resolveContained(agentsDir, `${newName}.md`);
				if (!newPath) fail(unsafeNew);
				const { writeFile: writeFileAtomic } = await import("../util.js");
				await writeFileAtomic(newPath, updated);
				if (newPath !== a.path) await fspMod.rm(a.path, { force: true });
				emit({
					command: "agents",
					action: "rename",
					from: name,
					to: newName,
					path: newPath,
				});
				if (!isJson())
					log.success(`Renamed '${name}' → '${newName}' (${pretty(newPath)})`);
				return;
			}
			if (action === "remove") {
				if (!name) fail("Usage: agent-cli agents remove <name>");
				const a = await showAgent(name, { cwd });
				if (!a) fail(`No agent named '${name}'`);
				const fspMod = await import("node:fs/promises");
				await fspMod.rm(a.path, { force: true });
				emit({ command: "agents", action: "remove", name, path: a.path });
				if (!isJson()) log.success(`Removed ${pretty(a.path)}`);
				return;
			}
			if (action === "export") {
				if (!name) fail("Usage: agent-cli agents export <name>");
				const a = await showAgent(name, { cwd });
				if (!a) fail(`No agent named '${name}'`);
				const fspMod = await import("node:fs/promises");
				const content = await fspMod.readFile(a.path, "utf8");
				if (isJson())
					emit({
						command: "agents",
						action: "export",
						name,
						path: a.path,
						content,
					});
				else process.stdout.write(content);
				return;
			}
			if (action === "import") {
				if (!name) fail("Usage: agent-cli agents import <path.md> [--name <new>]");
				const fspMod = await import("node:fs/promises");
				const content = await fspMod.readFile(name, "utf8");
				let finalName = opts.name || name;
				const m = /^name:\s*(\S+)/m.exec(content);
				if (m && !opts.name) finalName = m[1];
				const targetDir = projectAgentsDir(cwd);
				// The destination name comes from the UNTRUSTED imported file's own
				// frontmatter, so it must be a single filename segment: `\S+` matches
				// `/`, `\` and `..`, and a lexical containment check alone would still
				// accept `shared/CLAUDE` and follow a symlink planted at
				// `.agents/agents/shared`.
				const unsafeName = `Refusing import: unsafe agent name ${JSON.stringify(finalName)} — a name must be a single filename segment (no path separators, no '..').`;
				if (unsafeAgentSegment(finalName)) fail(unsafeName);
				const target = resolveContained(targetDir, `${finalName}.md`);
				if (!target) fail(unsafeName);
				const { ensureDir, writeFile: writeFileAtomic } = await import(
					"../util.js"
				);
				await ensureDir(targetDir);
				// Symlink-safe: a raw fsp.writeFile follows a symlink planted at the
				// destination itself (`name: notes` onto a symlinked notes.md — no
				// separators needed) and writes straight through it. The atomic
				// writer renames OVER the link, replacing it.
				await writeFileAtomic(target, content);
				emit({
					command: "agents",
					action: "import",
					name: finalName,
					path: target,
				});
				if (!isJson())
					log.success(`Imported '${finalName}' → ${pretty(target)}`);
				return;
			}
			if (action === "delegate") {
				if (!name)
					fail("Usage: agent-cli agents delegate prepare <name> --task <text>");
				const a = await showAgent(name, { cwd });
				if (!a) fail(`No agent named '${name}'`);
				const fspMod = await import("node:fs/promises");
				const content = await fspMod.readFile(a.path, "utf8");
				const task = opts.task || "(task not provided)";
				const prompt = [
					`You are delegating to the "${name}" sub-agent.`,
					`Description: ${a.description}`,
					a.model ? `Model alias: ${a.model}` : null,
					"",
					"## Task",
					task,
					"",
					"## Personality (embed for the sub-agent)",
					content,
				]
					.filter(Boolean)
					.join("\n");
				emit({ command: "agents", action: "delegate", name, task, prompt });
				if (!isJson()) process.stdout.write(prompt + "\n");
				return;
			}
			fail(
				`Unknown action: ${action}. Use list|show|new|validate|path|roster|edit|rename|remove|export|import|delegate`,
			);
		});
}
