// src/commands/info.js — dependency-light commands extracted from cli.js
// (HIGH-3: cli.js monolith extraction). Registered via registerInfoCommands.
// Injected deps: { emit, fail, log, c, pretty, JSON_MODE } + module refs.

import { TARGETS } from "../targets.js";

/** Register the simple info commands (version, config, targets, snapshots, stats). */
export function registerInfoCommands(
	program,
	{ emit, fail, log, c, pretty, isJson, VERSION },
) {
	program
		.command("config")
		.description("Print the config path + effective settings (config.json).")
		.action(async () => {
			const { loadConfig } = await import("../config.js");
			const { CONFIG_FILE } = await import("../util.js");
			const cfg = await loadConfig();
			emit({ command: "config", path: CONFIG_FILE, config: cfg });
			if (!isJson()) {
				log.kv("path", pretty(CONFIG_FILE));
				log.kv("global", cfg.global.join(", ") || "(none)");
				log.kv("seedVersion", cfg.seedVersion ?? "(none)");
				log.kv("skillManaged", String(cfg.skillManaged));
				log.kv("sync", cfg.sync ? "configured" : "(none)");
			}
		});

	program
		.command("version")
		.description("Print the installed agent-cli version.")
		.action(async () => {
			emit({ command: "version", version: VERSION });
			if (!isJson()) log.raw(VERSION);
		});

	program
		.command("targets")
		.description(
			"List all known agent targets with install/enable state; use `status` for pointer health or `where` for resolved paths.",
		)
		.action(async () => {
			const { detectInstalled } = await import("../detect.js");
			const { loadConfig, isGlobalEnabled } = await import("../config.js");
			const installed = new Set(await detectInstalled());
			const cfg = await loadConfig();
			const rows = TARGETS.map((t) => ({
				id: t.id,
				name: t.name,
				installed: installed.has(t.id),
				globalEnabled: isGlobalEnabled(cfg, t.id),
				global: t.global,
				project: t.project,
				docs: t.docs,
			}));
			emit({ command: "targets", count: rows.length, targets: rows });
			if (!isJson()) {
				for (const t of rows) {
					const mark = t.installed ? c.green("✓") : c.gray(" ");
					const en = t.globalEnabled ? c.green("on") : c.gray("off");
					log.raw(
						`  ${mark} ${c.bold(t.id.padEnd(9))} ${t.name.padEnd(34)} ${en} ${c.gray(t.global ? "~/" + t.global : "(project only)")}`,
					);
				}
				log.dim(`${rows.length} targets — ${installed.size} detected installed`);
			}
		});

	program
		.command("snapshots")
		.description("List brain snapshots.")
		.action(async () => {
			const { listSnapshots } = await import("../snapshot.js");
			const list = listSnapshots();
			emit({ command: "snapshots", count: list.length, snapshots: list });
			if (!isJson()) {
				if (!list.length) log.info("No snapshots.");
				for (const n of list) log.raw(`  ${n}`);
			}
		});

	program
		.command("stats")
		.description("Local, privacy-safe usage stats: snapshots, backups, lessons, config age.")
		.action(async () => {
			const { listSnapshots } = await import("../snapshot.js");
			const memMod = await import("../memory.js");
			const { listLessons } = await import("../lessons-lib.js");
			const sessMod = await import("../session.js");
			const { loadConfig } = await import("../config.js");
			const cfg = await loadConfig();
			const snaps = listSnapshots();
			const backups = memMod.backupsList().backups;
			const lessons = await listLessons({ includeProject: true });
			const session = sessMod.readSession();
			emit({
				command: "stats",
				snapshots: snaps.length,
				backups: backups.length,
				lessons: lessons.length,
				updatedAt: cfg.updatedAt,
				session: session ? { startedAt: session.startedAt, task: session.task } : null,
			});
			if (!isJson()) {
				log.kv("snapshots", String(snaps.length));
				log.kv("backups", String(backups.length));
				log.kv("lessons", String(lessons.length));
				log.kv("config updated", cfg.updatedAt ?? "(never)");
			}
		});
}
