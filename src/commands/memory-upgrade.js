// src/commands/memory-upgrade.js — agent-friendly memory-file upgrade flow.
//
// Subcommands (nested under the existing `memory` command in src/commands/
// memory-stack.js):
//
//   agent-cli memory upgrade plan                  → JSON plan listing pending
//                                                   migrations (id, target file,
//                                                   fields, instructions, backup).
//   agent-cli memory upgrade status                → brainSchemaVersion +
//                                                   pending count + ids.
//   agent-cli memory upgrade prepare <id>          → backs up target file, returns
//                                                   migration spec the LLM executes.
//   agent-cli memory upgrade apply <id>            → bumps schema version after the
//                                                   LLM has run per-field `set`
//                                                   commands.
//
// The flow the LLM follows:
//
//   1. agent-cli memory upgrade status --json
//   2. (if pending) agent-cli memory upgrade plan --json → read instructionsForAgent
//   3. for each applicable migration:
//        agent-cli memory upgrade prepare <id> --json → backup path + steps
//        (LLM does identity/soul/user/env set per the steps)
//        agent-cli memory upgrade apply <id> --json
//   4. agent-cli memory upgrade status --json → confirm upToDate=true

import { registerMemoryStackCommands } from "./memory-stack.js";

/** Register the memory upgrade subcommand tree.
 *  Must be called AFTER registerMemoryStackCommands so the `memory` parent
 *  command is already defined. */
export function registerMemoryUpgradeCommands(
	program,
	{ emit, fail, log, c, pretty, isJson },
) {
	// Look up the existing `memory <action>` command. We add `upgrade` as a
	// subcommand of it so the user can run `agent-cli memory upgrade plan`.
	const memory = program.commands.find((c) => c.name() === "memory");
	if (!memory) {
		// Should never happen — registerMemoryStackCommands runs first.
		throw new Error(
			"registerMemoryUpgradeCommands: parent `memory` command not registered",
		);
	}

	const upgrade = memory
		.command("upgrade")
		.description(
			"LLM-driven brain-schema upgrade: read `plan --json`, walk each migration's `steps`, then `prepare`/`apply` per migration. Run `status` to see what's pending.",
		);

	upgrade
		.command("status")
		.description(
			"Show current brain schema version + pending migration count + ids.",
		)
		.option("--scope <scope>", "global or project (default: global)", "global")
		.option("--cwd <dir>", "project cwd (project scope only)", null)
		.action(async (opts) => {
			const mod = await import("../memory-upgrade.js");
			const cwd = opts.cwd || process.cwd();
			const r = await mod.upgradeStatus({ scope: opts.scope, cwd });
			emit({ command: "memory upgrade status", ...r });
			if (!isJson()) {
				log.kv("brain schema version", c.bold(String(r.brainSchemaVersion)));
				log.kv("latest schema version", String(r.latestSchemaVersion));
				log.kv(
					"up to date",
					r.upToDate ? c.green("yes") : c.yellow("no"),
				);
				log.kv(
					"pending",
					r.pendingCount ? c.yellow(String(r.pendingCount)) : c.green("0"),
				);
				if (r.pending.length) {
					log.raw("");
					log.raw("Run `agent-cli memory upgrade plan --json` to see what to do.");
				}
			}
		});

	upgrade
		.command("plan")
		.description(
			"Machine-readable plan: each pending migration's id, target file, fields, steps, verify command, and a plain-English `instructionsForAgent` walkthrough.",
		)
		.option("--scope <scope>", "global or project (default: global)", "global")
		.option("--cwd <dir>", "project cwd (project scope only)", null)
		.action(async (opts) => {
			const mod = await import("../memory-upgrade.js");
			const cwd = opts.cwd || process.cwd();
			const r = await mod.planUpgrade({ scope: opts.scope, cwd });
			emit({ command: "memory upgrade plan", ...r });
			if (!isJson()) {
				if (r.upToDate) {
					log.success(`Brain is up to date at schema ${r.brainSchemaVersion}.`);
					return;
				}
				log.kv("current schema", c.bold(String(r.brainSchemaVersion)));
				log.kv("latest schema", String(r.latestSchemaVersion));
				log.raw("");
				log.raw(
					c.bold(
						`${r.applicable.length} migration(s) pending — instructionsForAgent (paste into your system prompt):`,
					),
				);
				log.raw("");
				log.raw(r.instructionsForAgent || "");
				log.raw("");
				for (const m of r.applicable) {
					log.raw(c.cyan(`• ${m.id}`) + c.gray(` (${m.kind})`));
					log.raw(`  ${m.summary}`);
					if (m.file) log.dim(`  target: ${pretty(m.file)}`);
					if (m.fields && m.fields.length)
						log.dim(`  fields: ${m.fields.join(", ")}`);
					if (m.notes) log.dim(`  notes: ${m.notes}`);
				}
			}
		});

	upgrade
		.command("prepare <id>")
		.description(
			"Back up the target file (atomic, .upgrade-backups/<ts>-<id>/) and return the migration spec the LLM will execute. Does NOT bump the schema version — use `apply <id>` after the LLM has run the per-field `set` commands.",
		)
		.option("--scope <scope>", "global or project (default: global)", "global")
		.option("--cwd <dir>", "project cwd (project scope only)", null)
		.action(async (id, opts) => {
			const mod = await import("../memory-upgrade.js");
			const cwd = opts.cwd || process.cwd();
			const r = await mod.prepareMigration(id, {
				scope: opts.scope,
				cwd,
			});
			if (!r.ok) {
				fail(`prepare: ${r.reason}`, {
					command: "memory upgrade prepare",
					id,
					reason: r.reason,
				});
				return;
			}
			emit({
				command: "memory upgrade prepare",
				id: r.migration.id,
				backup: r.backup,
				currentVersion: r.currentVersion,
				migration: {
					id: r.migration.id,
					title: r.migration.title,
					summary: r.migration.summary,
					kind: r.migration.kind,
					fields: r.migration.fields,
					steps: r.migration.steps,
					verify: r.migration.verify,
					notes: r.migration.notes || null,
				},
			});
			if (!isJson()) {
				log.success(
					`Backed up to ${r.backup ? pretty(r.backup) : "(no target file present)"}`,
				);
				log.raw("");
				log.raw(c.bold(`Migration: ${r.migration.title}`));
				log.raw(r.migration.summary);
				log.raw("");
				log.raw(c.bold("Steps:"));
				for (const [i, s] of r.migration.steps.entries())
					log.raw(`  ${i + 1}. ${s}`);
				log.raw("");
				log.raw(c.bold("Verify:"));
				log.raw(`  ${r.migration.verify}`);
				if (r.migration.notes) {
					log.raw("");
					log.dim(`Notes: ${r.migration.notes}`);
				}
			}
		});

	upgrade
		.command("apply <id>")
		.description(
			"Mark a migration as applied: bumps the brain schema version to the migration's `until`. Call this AFTER the LLM has executed the per-field `set` commands (use `prepare` first to back up the file).",
		)
		.option("--scope <scope>", "global or project (default: global)", "global")
		.option("--cwd <dir>", "project cwd (project scope only)", null)
		.action(async (id, opts) => {
			const mod = await import("../memory-upgrade.js");
			const cwd = opts.cwd || process.cwd();
			const r = await mod.markApplied(id, { scope: opts.scope, cwd });
			if (!r.ok)
				fail(`apply: ${r.reason}`, {
					command: "memory upgrade apply",
					id,
					reason: r.reason,
				});
			emit({
				command: "memory upgrade apply",
				id,
				version: r.version,
				previousVersion: r.previousVersion,
			});
			if (!isJson()) {
				log.success(
					`Marked '${id}' applied. Brain schema version: ${r.previousVersion} → ${r.version}.`,
				);
				const status = await mod.upgradeStatus({ scope: opts.scope, cwd });
				if (status.upToDate)
					log.success("Brain is now up to date at the latest schema.");
				else
					log.dim(
						`${status.pendingCount} migration(s) still pending — run \`agent-cli memory upgrade plan --json\`.`,
					);
			}
		});
}

// Avoid the unused-import warning when the parent's `registerMemoryStackCommands`
// is tree-shaken out by some bundlers (it's imported only to anchor the doc comment).
void registerMemoryStackCommands;