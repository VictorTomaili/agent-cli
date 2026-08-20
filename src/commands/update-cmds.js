// src/commands/update-cmds.js — update + upgrade, extracted from cli.js
// (HIGH-3). Injected deps: { emit, fail, log, c, pretty, EXIT, isJson,
//   loadConfig, saveConfig, ctxPaths, getTarget, linkTarget, refreshBlocks,
//   resolveContained, exists, readFile, preSnapshot, AGENTS_DIR, VERSION,
//   PKG_NAME }.

/** Register the update + upgrade commands. */
export function registerUpdateCommands(
	program,
	{
		emit,
		fail,
		log,
		c,
		pretty,
		EXIT,
		isJson,
		loadConfig,
		saveConfig,
		ctxPaths,
		getTarget,
		linkTarget,
		refreshBlocks,
		resolveContained,
		exists,
		readFile,
		preSnapshot,
		AGENTS_DIR,
		VERSION,
		PKG_NAME,
	},
) {
	program
		.command("update [action] [version]")
		.description(
			"Shipped-default updates: list staged payloads + npm latest version (default), stage seeds, diff <version> [--file <rel>], apply <version> to install one reviewed payload, or clear <version>. Use `upgrade` to apply everything staged at once.",
		)
		.option("--force", "force a fresh npm version check (writes config.json)")
		.option("--offline", "never hit the network; use the cached check only")
		.option("--no-network", "alias for --offline")
		.option(
			"--file <rel>",
			"restrict diff to one staged file (relative, e.g. agents/dev-agent.md)",
		)
		.action(async (action, version, opts) => {
			const seed = await import("../seed.js");
			const npm = await import("../npm-check.js");
			const cfg = await loadConfig();
			action = action || "list";
			if (action === "stage") {
				const r = await seed.stageSeeds({
					home: AGENTS_DIR,
					version: VERSION,
				});
				// Never mark seeding as done before `agent-cli init` has installed the defaults:
				// planSeedAction(prev=null) must still return "install" for the first run.
				if (cfg.seedVersion != null) {
					cfg.seedVersion = VERSION;
					await saveConfig(cfg);
				}
				emit({ command: "update", action, ...r });
				if (!isJson())
					log.success(`Staged ${r.staged.length} seeds → ${pretty(r.path)}`);
				return;
			}
			if (action === "list") {
				const offline =
					opts.offline ||
					opts.network === false ||
					process.env.AGENT_OFFLINE === "1";
				let upd;
				if (opts.force && !offline) {
					upd = await npm.ensureUpdateCheck(cfg, PKG_NAME, VERSION, {
						force: true,
						offline,
					});
					if (upd.refreshed) await saveConfig(cfg);
				} else {
					upd = npm.readCachedUpdate(cfg, VERSION);
				}
				const staged = await seed.listStagedUpdates({ home: AGENTS_DIR });
				emit({
					command: "update",
					action: "list",
					installedVersion: VERSION,
					latest: upd.latest,
					upToDate: upd.upToDate,
					checkedAt: upd.checkedAt,
					cached: upd.cached,
					seedVersion: cfg.seedVersion,
					staged,
				});
				if (!isJson()) {
					log.kv("installed", c.bold(VERSION));
					log.kv(
						"latest",
						upd.latest
							? upd.upToDate
								? c.green(upd.latest + " (up to date)")
								: c.yellow(upd.latest + " (update available)")
							: c.gray("unknown"),
					);
					log.kv("seeded at", cfg.seedVersion || c.gray("not yet"));
					if (staged.length) {
						log.raw(c.bold("Staged updates (awaiting your migration):"));
						for (const s of staged) {
							log.raw(
								`  ${c.cyan(s.version)} ${pretty(s.path)} ${c.gray("(" + s.files.length + " files)")}`,
							);
							for (const f of s.files) log.dim("    " + f);
						}
						log.dim(
							"Review & migrate each file with the user's consent; never clobber their edits.",
						);
					} else log.kv("staged", c.green("none"));
				}
				return;
			}
			if (action === "clear") {
				if (!version) fail("Usage: agent-cli update clear <version>");
				const r = await seed.clearStaged(version, { home: AGENTS_DIR });
				emit({ command: "update", action: "clear", ...r });
				if (!r.ok) {
					if (!isJson()) log.error(`Not found: update-${version}`);
					process.exit(1);
				}
				if (!isJson()) log.success(`Removed ${pretty(r.path)}`);
				return;
			}
			if (action === "diff") {
				if (!version) fail("Usage: agent-cli update diff <version> [--file <rel>]");
				const stagedList = await seed.listStagedUpdates({ home: AGENTS_DIR });
				const payload = stagedList.find((s) => s.version === version);
				if (!payload) fail(`No staged update for ${version}`);
				const requested = opts.file
					? opts.file.replace(/\\/g, "/")
					: null;
				if (requested && !payload.files.includes(requested))
					fail(`File is not part of staged update: ${opts.file}`);
				const rels = requested ? [requested] : payload.files;
				const diffs = [];
				for (const rel of rels) {
					const stagedContent = await seed.readStagedFile(version, rel, {
						home: AGENTS_DIR,
					});
					const livePath = resolveContained(AGENTS_DIR, rel);
					if (!livePath) fail(`Invalid staged file path: ${rel}`);
					let liveContent = null;
					if (await exists(livePath)) liveContent = await readFile(livePath);
					diffs.push({
						rel,
						livePath,
						liveExists: liveContent != null,
						diff: seed.diffLines(liveContent ?? "", stagedContent ?? ""),
					});
				}
				emit({ command: "update", action: "diff", version, diffs });
				if (!isJson())
					for (const d of diffs) {
						log.raw(
							c.bold(`${d.rel}  ${d.liveExists ? "" : c.gray("(live missing)")}`),
						);
						const hasChanges = d.diff
							.split("\n")
							.some((line) => line.startsWith("+") || line.startsWith("-"));
						if (!hasChanges) {
							log.dim("  No differences.");
							continue;
						}
						for (const line of d.diff.split("\n")) {
							let colored;
							if (line.startsWith("+")) colored = c.green(line);
							else if (line.startsWith("-")) colored = c.red(line);
							else colored = c.gray(line);
							process.stdout.write(colored + "\n");
						}
					}
				return;
			}
			if (action === "apply") {
				if (!version) fail("Usage: agent-cli update apply <version>");
				const pre = await preSnapshot("update-apply");
				const r = await seed.applyStaged(version, { home: AGENTS_DIR });
				emit({
					command: "update",
					action: "apply",
					...r,
					...(pre ? { preSnapshot: pre } : {}),
				});
				if (!isJson()) {
					if (!r.ok) {
						log.error(r.reason);
						process.exit(EXIT.ERROR);
					}
					log.success(
						`Applied ${r.applied.length} file(s) from update-${version}`,
					);
					if (r.backedUp.length)
						log.dim(`Backed up: ${r.backedUp.join(", ")}`);
					if (r.skipped.length)
						for (const s of r.skipped)
							log.warn(`Skipped ${s.rel}: ${s.reason}`);
				}
				if (!r.ok) process.exit(EXIT.ERROR);
				return;
			}
			fail(`Unknown action: ${action}. Use list|diff|stage|clear|apply <version>`);
		});

	program
		.command("upgrade")
		.description(
			"Apply all staged seed updates, then re-link pointers and refresh skill blocks.",
		)
		.action(async () => {
			const seed = await import("../seed.js");
			const staged = await seed.listStagedUpdates({ home: AGENTS_DIR });
			const applied = [];
			const failed = [];
			for (const s of staged) {
				const r = await seed.applyStaged(s.version, { home: AGENTS_DIR });
				if (r.ok) applied.push({ version: s.version, ...r });
				else failed.push({ version: s.version, reason: r.reason });
			}
			// re-link + refresh skill blocks after applying seeds
			const cfg = await loadConfig();
			const { masterAbs, masterTilde } = ctxPaths();
			let relinked = 0;
			for (const id of cfg.global) {
				const t = getTarget(id);
				if (!t) continue;
				const lr = await linkTarget(t, "global", { masterAbs, masterTilde });
				if (lr.linked || lr.unchanged) relinked++;
			}
			const blocks = await refreshBlocks();
			emit({
				command: "upgrade",
				applied,
				failed,
				relinked,
				blocksRefreshed: blocks.changed,
			});
			if (!isJson()) {
				for (const a of applied)
					log.success(
						`update-${a.version}: applied ${a.applied.length}, skipped ${a.skipped.length}`,
					);
				for (const f of failed)
					log.warn(`update-${f.version}: ${f.reason}`);
				log.kv("relinked", relinked);
				log.kv("skill blocks", blocks.changed ? "refreshed" : "current");
			}
		});
}
