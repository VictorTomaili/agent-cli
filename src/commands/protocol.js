// src/commands/protocol.js — manifest + schema, extracted from cli.js (HIGH-3).
// Injected deps: { emit, fail, program, collectCommands, EXIT, isJson }.

/** Register the machine-protocol commands (manifest, schema). */
export function registerProtocolCommands(
	program,
	{ emit, fail, collectCommands, EXIT, isJson },
) {
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
