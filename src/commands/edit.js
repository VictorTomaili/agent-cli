// src/commands/edit.js — edit + pull + onboard, extracted from cli.js (HIGH-3).
// Injected deps: { emit, fail, log, c, pretty, path, exists, writeFile, spawnSync,
//   MASTER_FILE, projectMasterPath, identityFilePath, POINTER_MARK, getTarget,
//   targetPath, masterPaths, isJson, parseEditorCommand, cmdShimSpawnSync }.

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
		parseEditorCommand,
		cmdShimSpawnSync,
	},
) {
	program
		.command("edit [kind]")
		.description(
			"Open a unified home file in $EDITOR. kind: agents (default) | soul | identity | user | lessons | environments | models | workflow",
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
						`Unknown kind: ${kind}. Use: agents|soul|identity|user|lessons|environments|models|workflow`,
					);
				}
				// --print-path only computes the path — it must not create the file.
				if (!opts.printPath && !(await exists(target))) {
					const arc = await import("../archetypes.js");
					let tpl = `# ${kind.toUpperCase()}.md\n\n`;
					if (kind === "identity") tpl = arc.identityContent("general-purpose");
					else if (kind === "soul") tpl = arc.soulContent("pragmatist");
					else if (kind === "user") tpl = arc.userContent();
					// The SAME seed `init` writes, not a stub. Seeding is
					// non-destructive, so a stub written here would never be
					// upgraded: running `edit workflow` before `init` would
					// permanently cost the user the curated recipe format.
					else if (kind === "workflow") tpl = arc.workflowContent();
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
			// L1: never hand the raw $VISUAL/$EDITOR string to a shell. Parse it into
			// argv (quote-aware) and spawn directly; only a metachar-free .cmd/.bat
			// shim falls back to cmd.exe with re-quoted arguments.
			const rawEditor =
				process.env.VISUAL ||
				process.env.EDITOR ||
				(process.platform === "win32" ? "notepad" : "vi");
			const editorArgs = parseEditorCommand(rawEditor);
			if (!editorArgs) {
				fail(
					`Cannot parse $VISUAL/$EDITOR (${JSON.stringify(rawEditor)}) — fix the variable (balanced quotes) or unset it.`,
				);
			}
			const editorArgv = [...editorArgs.slice(1), target];
			let r = spawnSync(editorArgs[0], editorArgv, { stdio: "inherit" });
			if (
				process.platform === "win32" &&
				r.error &&
				(r.error.code === "ENOENT" || r.error.code === "EINVAL")
			) {
				// Windows .cmd/.bat shims can't be CreateProcess'd directly — try the
				// guarded cmd.exe fallback (returns null when args carry metacharacters).
				const viaCmd = cmdShimSpawnSync(spawnSync, editorArgs, target);
				if (viaCmd) r = viaCmd;
			}
			// Editor failures must surface as a non-zero exit.
			if (r.error || r.status !== 0)
				process.exit(r.status == null ? 1 : r.status);
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
			"Onboarding: suggest (the single highest-priority gap as one question to ask the user).",
		)
		.action(async (action) => {
			action = action || "suggest";
			if (action === "suggest") {
				const agentsLib = await import("../agents-lib.js");
				const inv = await agentsLib.identityInventory({
					scope: "global",
					cwd: process.cwd(),
				});
				const s = agentsLib.nextGapSuggestion(inv);
				if (!s) {
					emit({ command: "onboard", kind: null, question: null, done: true });
					if (!isJson())
						log.success("Nothing to onboard — all tracked fields are filled.");
					return;
				}
				emit({ command: "onboard", ...s });
				if (!isJson()) {
					log.raw(c.bold(s.question));
					if (s.kind === "identity" && s.options) {
						log.dim(
							`Default: ${s.default}. Ask the user, then: agent-cli identity apply <choice>`,
						);
					} else {
						const { gapFixHints } = await import("../actions.js");
						const [hint] = gapFixHints({ [s.kind]: [s.tag] });
						log.dim(`Ask the user, then: ${hint}`);
					}
				}
				return;
			}
			fail(`Unknown action: ${action}. Use suggest`);
		});
}
