// src/commands/configure.js — the `configure` command (sub-agent runner
// configuration: `agent configure run [tool]`). Injected deps:
// { emit, fail, log, c, pretty, isJson }.

/** Register the `configure` command (runner config under `runners` in config.json). */
export function registerConfigureCommands(
	program,
	{ emit, fail, log, c, pretty, isJson },
) {
	program
		.command("configure <area> [tool]")
		.description(
			"Configure sub-agent runners: `configure run <tool> --model <m> [--provider p] [--thinking lvl] [--fallback <tool:provider/model[:thinking]>...] [--default]`; bare `configure run` prints the current config.",
		)
		.option("--provider <p>", "provider id for the tool (pi: zai, openrouter, …)")
		.option("--model <m>", "model id (required on first configuration of a tool)")
		.option("--thinking <lvl>", "thinking/reasoning level")
		.option(
			"--fallback <spec...>",
			"ordered fallback spec(s): tool:provider/model[:thinking]",
		)
		.option("--default", "make this tool the default runner")
		.action(async (area, tool, opts) => {
			if (area !== "run") {
				fail(
					`Unknown configure area: '${area}'. Use: agent configure run [tool]`,
					{ command: "configure", area },
				);
			}
			const runners = await import("../runners.js");
			// Bare `configure run` — print the current runner config.
			if (!tool) {
				const cfg = runners.getRunners();
				const chains = {};
				for (const id of Object.keys(cfg.tools || {})) {
					try {
						chains[id] = runners.resolveChain({ toolOverride: id });
					} catch {
						chains[id] = null; // broken fallback spec — show the raw entry only
					}
				}
				emit({
					command: "configure",
					area,
					default: cfg.default,
					tools: cfg.tools,
					chains,
				});
				if (!isJson()) {
					log.kv("default", cfg.default ?? "(none)");
					const tools = Object.entries(cfg.tools || {});
					if (!tools.length) {
						log.dim(
							"No runners configured — agent configure run <tool> --model <model>",
						);
						return;
					}
					for (const [id, t] of tools) {
						const head = `${t.provider ? t.provider + "/" : ""}${t.model}${t.thinking ? ":" + t.thinking : ""}`;
						const chain = chains[id]
							? chains[id]
									.slice(1)
									.map((e) => `${e.tool}:${e.provider ?? "-"}/${e.model}`)
									.join(" → ")
							: "";
						log.raw(
							`  ${c.bold(id.padEnd(8))}${cfg.default === id ? c.green("(default) ") : ""}${head}${chain ? c.gray("  fallbacks: " + chain) : ""}`,
						);
					}
				}
				return;
			}
			// `configure run <tool> [options]` — persist the entry.
			let entry;
			try {
				entry = runners.setRunner(tool, {
					provider: opts.provider,
					model: opts.model,
					thinking: opts.thinking,
					fallbacks: opts.fallback,
					makeDefault: opts.default === true,
				});
			} catch (e) {
				fail(e.message, { command: "configure", area, tool });
			}
			emit({ command: "configure", area, tool, runner: entry });
			if (!isJson()) {
				log.success(
					`Runner '${tool}' → ${entry.model}${entry.provider ? " @" + entry.provider : ""}${entry.thinking ? " @" + entry.thinking : ""}${runners.getRunners().default === tool ? " (default)" : ""}`,
				);
				for (const f of entry.fallbacks || [])
					log.dim(`fallback: ${pretty(f)}`);
			}
		});
}
