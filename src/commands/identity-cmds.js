// src/commands/identity-cmds.js — identity + soul + user, extracted from cli.js (HIGH-3).
// Injected deps: { emit, fail, log, c, pretty, exists, readFile, writeFile,
//   identityFilePath, preSnapshot, isJson }.

/** Register the identity/soul/user commands. */
export function registerIdentityCommands(
	program,
	{
		emit,
		fail,
		log,
		c,
		pretty,
		exists,
		readFile,
		writeFile,
		identityFilePath,
		preSnapshot,
		isJson,
	},
) {
	program
		.command("identity [action] [rest...]")
		.description(
			"Identity archetypes: list | apply <id> [--soul <v>] | set <section> <value...>. -p project.",
		)
		.option("-p, --project", "project scope")
		.option("--soul <variant>", "also apply this soul variant")
		.option(
			"--fallback",
			"apply the default archetype for an unknown id (both modes)",
		)
		.action(async (action, rest, opts) => {
			const id = await import("../identity.js");
			action = action || "list";
			const scope = opts.project ? "project" : "global";
			const cwd = process.cwd();
			if (action === "list") {
				emit({
					command: "identity",
					action,
					identities: id.listIdentities(),
					souls: id.listSouls(),
				});
				if (!isJson()) {
					log.raw(c.bold("Identities:"));
					for (const i of id.listIdentities())
						log.raw(`  ${c.bold(i.key.padEnd(18))} ${i.label}`);
					log.raw(c.bold("Souls:"));
					for (const s of id.listSouls())
						log.raw(`  ${c.bold(s.key.padEnd(18))} ${s.label}`);
				}
				return;
			}
			if (action === "apply") {
				const key = rest[0];
				if (!key) {
					fail("Usage: agent identity apply <id>");
				}
				const known = id.listIdentities().some((i) => i.key === key);
				const resolved = known ? null : "general-purpose";
				if (!known && !opts.fallback) {
					fail(
						`Unknown identity '${key}' (would resolve to default 'general-purpose'). Pass --fallback to apply it. Use: agent identity list`,
						{ command: "identity", action, key },
					);
				}
				const pre = await preSnapshot("identity-apply");
				const r = await id.applyIdentity(key, { scope, cwd });
				let soul = null;
				if (opts.soul) {
					const sr = await id.applySoul(opts.soul, { scope, cwd });
					soul = sr.soul;
				}
				emit({
					command: "identity",
					action,
					...r,
					soul,
					...(pre ? { preSnapshot: pre } : {}),
					...(known ? {} : { fallback: true, resolved }),
				});
				if (!isJson())
					log.success(
						`Identity '${key}'${soul ? ` + soul '${soul}'` : ""} → ${pretty(r.file)}`,
					);
				return;
			}
			if (action === "set") {
				const [section, ...val] = rest;
				if (!section) {
					fail("Usage: agent identity set <section> <value...>");
				}
				const f = await id.setSection(
					id.idFile(scope, cwd),
					section,
					val.join(" "),
					{ scope, cwd },
				);
				emit({ command: "identity", action, file: f });
				if (!isJson()) log.success(`Updated ${pretty(f)}`);
				return;
			}
			fail(`Unknown action: ${action}. Use list|apply|set`);
		});

	program
		.command("soul [action] [rest...]")
		.description(
			"Soul variants: list | apply <variant> | set <section> <value...>. -p project.",
		)
		.option("-p, --project", "project scope")
		.option(
			"--fallback",
			"apply the default variant for an unknown id (both modes)",
		)
		.action(async (action, rest, opts) => {
			const id = await import("../identity.js");
			action = action || "list";
			const scope = opts.project ? "project" : "global";
			const cwd = process.cwd();
			if (action === "list") {
				emit({ command: "soul", action, souls: id.listSouls() });
				if (!isJson())
					for (const s of id.listSouls())
						log.raw(`  ${c.bold(s.key.padEnd(14))} ${s.label}`);
				return;
			}
			if (action === "apply") {
				const key = rest[0];
				if (!key) {
					fail("Usage: agent soul apply <variant>");
				}
				const known = id.listSouls().some((s) => s.key === key);
				const resolved = known ? null : "pragmatist";
				if (!known && !opts.fallback) {
					fail(
						`Unknown soul '${key}' (would resolve to default 'pragmatist'). Pass --fallback to apply it. Use: agent soul list`,
						{ command: "soul", action, key },
					);
				}
				const pre = await preSnapshot("soul-apply");
				const r = await id.applySoul(key, { scope, cwd });
				emit({
					command: "soul",
					action,
					...r,
					...(pre ? { preSnapshot: pre } : {}),
					...(known ? {} : { fallback: true, resolved }),
				});
				if (!isJson()) log.success(`Soul '${key}' → ${pretty(r.file)}`);
				return;
			}
			if (action === "set") {
				const [section, ...val] = rest;
				if (!section) {
					fail("Usage: agent soul set <section> <value...>");
				}
				const f = await id.setSection(
					id.soulFile(scope, cwd),
					section,
					val.join(" "),
					{ scope, cwd },
				);
				emit({ command: "soul", action, file: f });
				if (!isJson()) log.success(`Updated ${pretty(f)}`);
				return;
			}
			fail(`Unknown action: ${action}. Use list|apply|set`);
		});

	program
		.command("user [action] [rest...]")
		.description(
			"USER.md: apply (write template; --force replaces an existing file) | set <field> <value...>. -p project.",
		)
		.option("-p, --project", "project scope")
		.option("--force", "overwrite an existing non-empty USER.md")
		.option("--replace", "alias for --force")
		.action(async (action, rest, opts) => {
			const id = await import("../identity.js");
			const arc = await import("../archetypes.js");
			action = action || "apply";
			const scope = opts.project ? "project" : "global";
			const cwd = process.cwd();
			const file = identityFilePath("user", scope, cwd);
			const replace = opts.force || opts.replace;
			if (action === "apply") {
				if (!replace && (await exists(file))) {
					const existing = await readFile(file);
					if (existing && existing.trim()) {
						fail(
							`USER.md already exists (${pretty(file)}). Pass --force to replace it.`,
						);
					}
				}
				await writeFile(file, arc.userContent());
				emit({ command: "user", action, file });
				if (!isJson()) log.success(`USER.md template → ${pretty(file)}`);
				return;
			}
			if (action === "set") {
				const [section, ...val] = rest;
				if (!section) {
					fail("Usage: agent user set <field> <value...>");
				}
				const f = await id.setSection(file, section, val.join(" "), { scope, cwd });
				emit({ command: "user", action, file: f });
				if (!isJson()) log.success(`Updated ${pretty(f)}`);
				return;
			}
			fail(`Unknown action: ${action}. Use apply|set`);
		});
}
