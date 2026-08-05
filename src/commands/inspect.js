// src/commands/inspect.js — whoami + files, extracted from cli.js (HIGH-3).
// Injected deps: { emit, log, c, pretty, readFile, identityInventory, isJson }.

/** Register the inspect commands (whoami, files). */
export function registerInspectCommands(
	program,
	{ emit, log, c, pretty, readFile, identityInventory, isJson },
) {
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
				log.raw(`  ${c.bold(who || "(name unset)")}${soulVariant ? c.gray(" · " + soulVariant) : ""}`);
				if (Object.keys(gaps).length) log.warn(`Gaps: ${JSON.stringify(gaps)}`);
				else log.success("Identity complete.");
			}
		});

	program
		.command("files")
		.description("Show the unified identity/memory file inventory (~/.agents).")
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
}
