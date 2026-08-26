// src/commands/protocol.js — manifest + schema, extracted from cli.js (HIGH-3).
// Injected deps: { emit, fail, log, c, program, collectCommands, EXIT, isJson }.

/** Render the exit-code contract as a single `NAME=code` line (human mode). */
function exitCodeLine(EXIT) {
	return Object.entries(EXIT)
		.map(([k, v]) => `${k}=${v}`)
		.join("  ");
}

/** One-line summary of a command description — the full text stays in --json
 *  (and in `agent-cli help <command>`); this keeps the listing scannable. */
function summarize(description, max = 72) {
	const s = String(description || "").replace(/\s+/g, " ").trim();
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Print the `--json` envelope shape + exit-code contract (human mode). */
function printEnvelope(log, c, contract, EXIT) {
	log.raw(c.bold("envelope") + c.gray("  (every --json response)"));
	for (const [k, v] of Object.entries(contract)) log.kv(k, v);
	log.raw(c.bold("exit codes"));
	log.dim(exitCodeLine(EXIT));
}

/** Register the machine-protocol commands (manifest, schema, completion). */
export function registerProtocolCommands(
	program,
	{ emit, fail, log, c, collectCommands, EXIT, isJson },
) {
	program
		.command("completion <shell>")
		.description("Print a shell completion script (bash|zsh|fish|powershell).")
		.action(async (shell) => {
			const names = [
				...new Set(collectCommands().map((row) => row.name.split(" ")[0])),
			].sort();
			const words = names.join(" ");
			let script = null;
			if (shell === "bash")
				script = `_agent_cli() { COMPREPLY=( $(compgen -W "${words}" -- "\${COMP_WORDS[1]}") ); }\ncomplete -F _agent_cli agent-cli\n`;
			else if (shell === "zsh")
				script = `#compdef agent-cli\n_arguments '1:command:(${words})'\n`;
			else if (shell === "fish")
				script = `complete -c agent-cli -f -a "${words}"\n`;
			else if (shell === "powershell")
				script = `Register-ArgumentCompleter -Native -CommandName agent-cli -ScriptBlock { param($w,$c,$p) "${words}".Split(" ") | Where-Object { $_ -like "$c*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) } }\n`;
			if (!script)
				fail(`Unsupported shell: ${shell}. Use bash|zsh|fish|powershell`, {
					command: "completion",
					shell,
				});
			emit({ command: "completion", shell, script });
			if (!isJson()) process.stdout.write(script);
		});
	program
		.command("manifest")
		.description(
			"Emit the machine-readable command surface + exit-code contract.",
		)
		.action(async () => {
			const commands = collectCommands();
			emit({
				command: "manifest",
				commands,
				exitCodes: EXIT,
			});
			if (!isJson()) {
				const width = Math.min(
					32,
					commands.reduce((w, r) => Math.max(w, r.name.length), 0),
				);
				for (const r of commands)
					log.raw(
						`  ${c.bold(r.name.padEnd(width))}  ${c.gray(summarize(r.description))}`,
					);
				log.dim(
					`${commands.length} commands — exit codes: ${exitCodeLine(EXIT)}`,
				);
				log.dim(
					"Add --json for the full manifest; `agent-cli help <command>` for one command.",
				);
			}
		});

	program
		.command("schema [command]")
		.description("Print the JSON envelope contract (or one command's shape).")
		.action(async (name) => {
			const contract = {
				ok: "boolean",
				command: "string",
				apiVersion: "string",
				data: "object",
				error: "string (optional)",
			};
			if (name) {
				const cmd = program.commands.find((sub) => sub.name() === name);
				if (!cmd) fail(`Unknown command: ${name}`, { command: "schema", name });
				const options = (cmd.options || []).map((o) => o.flags);
				emit({
					command: "schema",
					envelope: contract,
					exitCodes: EXIT,
					requested: {
						name: cmd.name(),
						description: cmd.description(),
						options,
					},
				});
				if (!isJson()) {
					log.raw(c.bold(cmd.name()));
					log.dim(cmd.description() || "(no description)");
					log.raw("");
					printEnvelope(log, c, contract, EXIT);
					log.raw("");
					log.raw(c.bold("options"));
					if (!options.length) log.dim("(none)");
					for (const flags of options) log.raw(`  ${c.cyan(flags)}`);
				}
				return;
			}
			emit({ command: "schema", envelope: contract, exitCodes: EXIT });
			if (!isJson()) {
				printEnvelope(log, c, contract, EXIT);
				log.dim("Add --json for the machine-readable contract.");
			}
		});
}
