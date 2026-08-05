// src/commands/edit.js — edit + pull + onboard, extracted from cli.js (HIGH-3).
// Injected deps: { emit, fail, log, c, pretty, path, exists, writeFile, spawnSync,
//   MASTER_FILE, projectMasterPath, identityFilePath, POINTER_MARK, getTarget,
//   targetPath, masterPaths, isJson }.

/** Register the edit / pull / onboard commands. */
export function registerEditCommands(
	program,
	{
		emit,
		fail,
		log,
		c,
		pretty,
		path,
		exists,
		writeFile,
		spawnSync,
		MASTER_FILE,
		projectMasterPath,
		identityFilePath,
		POINTER_MARK,
		getTarget,
		targetPath,
		masterPaths,
		isJson,
	},
) {
	program
		.command("edit [kind]")
		.description(
			"Open a unified home file in $EDITOR. kind: agents (default) | soul | identity | user | lessons | environments | models",
		)
		.option("--print-path", "Just print the resolved path and exit (creates no file)")
		.option(
			"-p, --project",
			"Edit the project-local copy (master resolves to [cwd]/.agents/AGENTS.md)",
		)
		.action(async (kind, opts) => {
			const scope = opts.project ? "project" : "global";
			let target = scope === "project" ? projectMasterPath() : MASTER_FILE;
			if (kind === "models") {
				const modelsMod = await import("../models.js");
				target = modelsMod.MODELS_MD;
				if (!opts.printPath && !(await exists(target))) modelsMod.writeModelsMd();
			} else if (kind && kind !== "agents") {
				target = identityFilePath(kind, scope);
				if (!target) {
					fail(
						`Unknown kind: ${kind}. Use: agents|soul|identity|user|lessons|environments|models`,
					);
				}
				// --print-path only computes the path — it must not create the file.
				if (!opts.printPath && !(await exists(target))) {
					const arc = await import("../archetypes.js");
					let tpl = `# ${kind.toUpperCase()}.md\n\n`;
					if (kind === "identity") tpl = arc.identityContent("general-purpose");
					else if (kind === "soul") tpl = arc.soulContent("pragmatist");
					else if (kind === "user") tpl = arc.userContent();
					await writeFile(target, tpl);
				}
			}
			if (opts.printPath) {
				// Exactly one JSON value on stdout in JSON mode; no path mixed in.
				if (isJson())
					emit({
						command: "edit",
						kind: kind || "agents",
						path: target,
						printPath: true,
					});
				else process.stdout.write(target + "\n");
				return;
			}
			emit({ command: "edit", kind: kind || "agents", path: target });
			const editor =
				process.env.VISUAL ||
				process.env.EDITOR ||
				(process.platform === "win32" ? "notepad" : "vi");
			const r = spawnSync(editor, [target], { stdio: "inherit", shell: true });
			// Editor failures must surface as a non-zero exit.
			if (r.error || r.status !== 0)
				process.exit(r.status != null ? r.status : 1);
		});

	program
		.command("pull <id>")
		.description("Adopt a target file's native content as the new master body.")
		.option("-g, --global")
		.option("-p, --project")
		.action(async (id, opts) => {
			const t = getTarget(id);
			if (!t) {
				fail(`Unknown target: ${id}`);
			}
			const scope = opts.project ? "project" : "global";
			const p = targetPath(t, scope);
			if (!p) {
				fail(`${id} has no ${scope} path`);
			}
			if (!(await exists(p))) {
				fail(`Not found: ${p}`);
			}
			const fs = await import("node:fs/promises");
			const content = await fs.readFile(p, "utf8");
			if (content.includes(POINTER_MARK)) {
				fail(`${p} is already a pointer (no native content to pull).`);
			}
			const { ensureBlocks } = await import("../blocks.js");
			const merged = ensureBlocks(content);
			// P0-2: pull -p must write to the PROJECT master ([cwd]/.agents/AGENTS.md),
			// not the global ~/AGENTS.md.
			const { masterAbs } = masterPaths(scope, process.cwd());
			await writeFile(masterAbs, merged);
			emit({ command: "pull", id, scope, path: p, master: masterAbs, ok: true });
			if (!isJson())
				log.success(`Adopted ${pretty(p)} → ${pretty(masterAbs)}`);
		});

	program
		.command("onboard [action]")
		.description(
			"Identity onboarding: suggest (the one question + options for the agent to ask the user).",
		)
		.action(async (action) => {
			const id = await import("../identity.js");
			action = action || "suggest";
			if (action === "suggest") {
				const s = id.onboardSuggest();
				emit({ command: "onboard", ...s });
				if (!isJson()) {
					log.raw(c.bold(s.question));
					log.dim(
						`Default: ${s.default}. Ask the user, then: agent identity apply <choice>`,
					);
				}
				return;
			}
			fail(`Unknown action: ${action}. Use suggest`);
		});
}
