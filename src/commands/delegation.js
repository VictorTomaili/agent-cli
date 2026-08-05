// src/commands/delegation.js — handoff + agents, extracted from cli.js (HIGH-3).
// Injected deps: { emit, fail, log, c, pretty, EXIT, isJson, listAgents,
//   showAgent, scaffoldAgent, validateAgent, GLOBAL_AGENTS_DIR,
//   projectAgentsDir, readFile, spawnSync, path }.

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
	},
) {
	// agent handoff / whoami — delegation artifacts + identity summary
	// ---------------------------------------------------------------------------
	program
		.command("handoff <action> [id]")
		.description(
			"Delegation artifacts: create --to <name> --task <text> | list | show <id> | accept <id> | close <id> [--lesson <topic>]",
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
				if (!id) fail("Usage: agent handoff show <id>");
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
				if (!id) fail(`Usage: agent handoff ${action} <id>`);
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

	// agent edit / pull / where
	// ---------------------------------------------------------------------------
	program
		.command("agents [action] [name] [rest...]")
		.description(
			"Manage reusable sub-agent personalities: list | show | new | validate | path | roster | edit | rename | remove | export | import | delegate",
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
							"No personalities yet — create one: agent agents new <name>",
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
					fail("Usage: agent agents show <name>");
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
					fail("Usage: agent agents new <name>");
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
				if (!name) fail("Usage: agent agents edit <name>");
				const a = await showAgent(name, { cwd });
				if (!a) fail(`No agent named '${name}'`);
				emit({ command: "agents", action: "edit", name, path: a.path });
				const editor =
					process.env.VISUAL ||
					process.env.EDITOR ||
					(process.platform === "win32" ? "notepad" : "vi");
				const r = spawnSync(editor, [a.path], {
					stdio: "inherit",
					shell: true,
				});
				if (r.error || r.status !== 0)
					process.exit(r.status != null ? r.status : 1);
				return;
			}
			if (action === "rename") {
				const [newName] = rest || [];
				if (!name || !newName) fail("Usage: agent agents rename <old> <new>");
				const a = await showAgent(name, { cwd });
				if (!a) fail(`No agent named '${name}'`);
				const content = await readFile(a.path);
				const updated = content.replace(/^name:\s*.*$/m, `name: ${newName}`);
				const fspMod = await import("node:fs/promises");
				const newPath = path.join(path.dirname(a.path), `${newName}.md`);
				await fspMod.writeFile(newPath, updated, "utf8");
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
				if (!name) fail("Usage: agent agents remove <name>");
				const a = await showAgent(name, { cwd });
				if (!a) fail(`No agent named '${name}'`);
				const fspMod = await import("node:fs/promises");
				await fspMod.rm(a.path, { force: true });
				emit({ command: "agents", action: "remove", name, path: a.path });
				if (!isJson()) log.success(`Removed ${pretty(a.path)}`);
				return;
			}
			if (action === "export") {
				if (!name) fail("Usage: agent agents export <name>");
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
				if (!name) fail("Usage: agent agents import <path.md> [--name <new>]");
				const fspMod = await import("node:fs/promises");
				const content = await fspMod.readFile(name, "utf8");
				let finalName = opts.name || name;
				const m = /^name:\s*(\S+)/m.exec(content);
				if (m && !opts.name) finalName = m[1];
				const targetDir = projectAgentsDir(cwd);
				await (await import("../util.js")).ensureDir(targetDir);
				const target = path.join(targetDir, `${finalName}.md`);
				await fspMod.writeFile(target, content, "utf8");
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
					fail("Usage: agent agents delegate prepare <name> --task <text>");
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
