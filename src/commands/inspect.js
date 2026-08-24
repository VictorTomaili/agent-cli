// src/commands/inspect.js — whoami, files, validate, extracted from cli.js
// (HIGH-3). Injected deps: { emit, fail, log, c, pretty, readFile,
// identityInventory, isJson, isConfigCorrupt, loadConfig, classify,
// getTarget, detectInstalled, EXIT }.

/** Register the inspect commands (whoami, files, validate). */
export function registerInspectCommands(program, deps) {
	const {
		emit,
		fail,
		log,
		c,
		pretty,
		readFile,
		identityInventory,
		isJson,
		isConfigCorrupt,
		loadConfig,
		classify,
		getTarget,
		detectInstalled,
		EXIT,
	} = deps;

	program
		.command("whoami")
		.description(
			"One-line identity summary: <AGENT_NAME>, soul variant, and any field gaps.",
		)
		.action(async () => {
			const inv = await identityInventory({ scope: "global", cwd: process.cwd() });
			const gaps = {};
			for (const f of inv.files) if (f.gaps && f.gaps.length) gaps[f.kind] = f.gaps;
			const identityFile = inv.files.find((f) => f.kind === "identity");
			let who = null;
			if (identityFile?.exists) {
				const content = await readFile(identityFile.path);
				const m = /<AGENT_NAME>([^<]*)<\/AGENT_NAME>/.exec(content);
				who = m && m[1].trim() ? m[1].trim() : null;
			}
			const soulFile = inv.files.find((f) => f.kind === "soul");
			let soulVariant = null;
			if (soulFile?.exists) {
				const content = await readFile(soulFile.path);
				const m = /\(Soul variant: ([^)]+)\)/.exec(content);
				soulVariant = m ? m[1].trim() : null;
			}
			emit({ command: "whoami", identity: who, soul: soulVariant, gaps });
			if (!isJson()) {
				log.raw(
					`  ${c.bold(who || "(name unset)")}${soulVariant ? c.gray(" · " + soulVariant) : ""}`,
				);
				if (Object.keys(gaps).length) log.warn(`Gaps: ${JSON.stringify(gaps)}`);
				else log.success("Identity complete.");
			}
		});

	program
		.command("files")
		.description(
			"Show the unified identity/memory file inventory (~/.agents) with per-file gaps — broader than `whoami`'s one-line summary.",
		)
		.option("-p, --project", "project-local")
		.action(async (opts) => {
			const inv = await identityInventory({
				scope: opts.project ? "project" : "global",
				cwd: process.cwd(),
			});
			emit({ command: "files", ...inv });
			if (!isJson()) {
				log.kv("base", pretty(inv.base));
				for (const f of inv.files) {
					const mark = !f.exists
						? c.gray("✗")
						: f.filled === false
							? c.yellow("⚠")
							: c.green("✓");
					const tag = f.filled === false ? c.yellow(" (unfilled)") : "";
					log.raw(
						`  ${mark} ${f.kind.padEnd(13)} ${pretty(f.path)}${f.size != null ? c.gray(" (" + f.size + "B)") : ""}${tag}`,
					);
				}
				log.raw(
					`  ${c.gray("agents/  ")} ${pretty(inv.agentsDir)} ${c.gray("(" + inv.agentsCount + " personalities)")}`,
				);
			}
		});

	/**
	 * `validate` — fast setup integrity check, distinct from `doctor`:
	 *   - `doctor` is comprehensive and may take a few seconds (npm-check,
	 *     share-health walk, etc.).
	 *   - `validate` is the 100ms "is my setup OK?" check used as a CI/cron
	 *     primitive. Always exits 0 on a healthy setup, EXIT.ERROR when any
	 *     check fails.
	 *
	 * Checks performed:
	 *   1. config.json loads cleanly (not corrupt, closed key-set)
	 *   2. every enabled target resolves to a known id (no stale cfg entries)
	 *   3. every enabled global target has a pointer stub at its native path
	 *      (state ∈ {pointer, pointer-stale}; native-content is also OK
	 *      because the user can pull it)
	 *   4. every identity/memory file that EXISTS is readable as UTF-8
	 */
	program
		.command("validate")
		.description(
			"Fast setup integrity check (config not corrupt, enabled targets resolve, pointer stubs readable, brain files UTF-8). Exits 0 on healthy; 1 with details otherwise. Distinct from `doctor` (which is comprehensive).",
		)
		.action(async () => {
			const checks = [];
			const add = (name, ok, detail) =>
				checks.push({ name, ok, detail: detail || "" });

			// 1. config
			let cfg = null;
			try {
				cfg = await loadConfig();
				if (isConfigCorrupt(cfg)) {
					add("config", false, "config.json has corrupt values");
				} else {
					add("config", true, `keys=${Object.keys(cfg).length}`);
				}
			} catch (e) {
				add("config", false, `load failed: ${e.message}`);
			}

			// 2 & 3. enabled targets
			if (cfg) {
				const knownIds = new Set(
					(await import("../targets/index.js")).TARGETS.map((t) => t.id),
				);
				const installed = await detectInstalled();
				const enabled = cfg.global ?? [];
				for (const id of enabled) {
					if (!knownIds.has(id)) {
						add(`target:${id}`, false, "unknown id in cfg.global");
						continue;
					}
					const t = getTarget(id);
					if (!t?.global) {
						add(`target:${id}`, true, "project-only");
						continue;
					}
					try {
						const cls = await classify(t, "global");
						if (cls.state === "missing") {
							add(`target:${id}`, false, `stub missing at ${cls.path}`);
						} else {
							add(`target:${id}`, true, `state=${cls.state}`);
						}
					} catch (e) {
						add(`target:${id}`, false, `classify failed: ${e.message}`);
					}
				}
				// Hint about installed-but-not-enabled tools (advisory, not a
				// failure — that's a workflow decision, not a setup bug).
				const installedNotEnabled = installed.filter((i) => !enabled.includes(i));
				if (installedNotEnabled.length) {
					add(
						"info:installed-not-enabled",
						true,
						`hint: ${installedNotEnabled.join(", ")} — run \`agent-cli target enable <id>\` if you want them linked`,
					);
				}
			}

			// 4. brain files readable
			try {
				const inv = await identityInventory({ scope: "global", cwd: process.cwd() });
				for (const f of inv.files) {
					if (!f.exists) continue;
					try {
						await readFile(f.path);
						add(`brain:${f.kind}`, true, `size ${f.size}B`);
					} catch (e) {
						add(`brain:${f.kind}`, false, `read failed: ${e.message}`);
					}
				}
			} catch (e) {
				add("brain", false, `inventory failed: ${e.message}`);
			}

			const failed = checks.filter((chk) => !chk.ok);
			const result = {
				command: "validate",
				ok: failed.length === 0,
				failed: failed.length,
				total: checks.length,
				checks,
			};
			emit(result);
			if (!isJson()) {
				for (const chk of checks) {
					const mark = chk.ok ? c.green("✓") : c.red("✗");
					log.raw(
						`  ${mark} ${chk.name.padEnd(28)} ${c.gray(chk.detail || "")}`,
					);
				}
				log.raw("");
				if (failed.length) {
					log.error(
						`${failed.length}/${checks.length} check(s) failed — run \`agent-cli doctor\` for the full diagnostic.`,
					);
				} else {
					log.success(`All ${checks.length} checks passed.`);
				}
			}
			if (failed.length) process.exit(EXIT.ERROR);
		});
}