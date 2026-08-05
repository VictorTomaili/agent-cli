// src/commands/protocol.js — manifest + schema, extracted from cli.js (HIGH-3).
// Injected deps: { emit, fail, program, collectCommands, EXIT, isJson }.

/** Register the machine-protocol commands (manifest, schema, completion). */
export function registerProtocolCommands(
	program,
	{ emit, fail, collectCommands, EXIT, isJson },
) {
	program
		.command("completion <shell>")
		.description("Print a shell completion script (bash|zsh|fish|powershell).")
		.action(async (shell) => {
			const names = [...new Set(collectCommands().map((c) => c.name.split(" ")[0]))].sort();
			const words = names.join(" ");
			let script = null;
			if (shell === "bash")
				script = `_agent() { COMPREPLY=( $(compgen -W "${words}" -- "\${COMP_WORDS[1]}") ); }\ncomplete -F _agent agent\n`;
			else if (shell === "zsh")
				script = `#compdef agent\n_arguments '1:command:(${words})'\n`;
			else if (shell === "fish")
				script = `complete -c agent -f -a "${words}"\n`;
			else if (shell === "powershell")
				script = `Register-ArgumentCompleter -Native -CommandName agent -ScriptBlock { param($w,$c,$p) "${words}".Split(" ") | Where-Object { $_ -like "$c*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) } }\n`;
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
			emit({
				command: "manifest",
				commands: collectCommands(),
				exitCodes: EXIT,
			});
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
				const cmd = program.commands.find((c) => c.name() === name);
				if (!cmd) fail(`Unknown command: ${name}`, { command: "schema", name });
				emit({
					command: "schema",
					envelope: contract,
					exitCodes: EXIT,
					requested: {
						name: cmd.name(),
						description: cmd.description(),
						options: (cmd.options || []).map((o) => o.flags),
					},
				});
				return;
			}
			emit({ command: "schema", envelope: contract, exitCodes: EXIT });
		});
}
