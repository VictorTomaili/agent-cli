// src/commands/archetype.js — archetype + template, extracted from cli.js (HIGH-3).
// Injected deps: { emit, fail, log, c, pretty, path, exists, writeFile, AGENTS_DIR, isJson }.

/** Register the archetype and template commands. */
export function registerArchetypeCommands(
	program,
	{ emit, fail, log, c, pretty, path, exists, writeFile, AGENTS_DIR, isJson },
) {
	program
		.command("archetype <action> [arg]")
		.description("Identity/soul archetypes: list | export <id> | import <file>.")
		.option("-p, --project", "project scope (for import)")
		.action(async (action, arg, opts) => {
			const arc = await import("../archetypes.js");
			const idMod = await import("../identity.js");
			if (action === "list") {
				emit({
					command: "archetype",
					action,
					identities: idMod.listIdentities(),
					souls: idMod.listSouls(),
				});
				if (!isJson()) {
					for (const i of idMod.listIdentities())
						log.raw(`  ${c.bold("identity")} ${i.key.padEnd(18)} ${i.label}`);
					for (const s of idMod.listSouls())
						log.raw(`  ${c.bold("soul")}     ${s.key.padEnd(18)} ${s.label}`);
				}
				return;
			}
			if (action === "export") {
				if (!arg) fail("Usage: agent archetype export <identity|soul-id>");
				const isSoul = idMod.listSouls().some((s) => s.key === arg);
				const content = isSoul ? arc.soulContent(arg) : arc.identityContent(arg);
				emit({ command: "archetype", action, kind: isSoul ? "soul" : "identity", id: arg, content });
				if (!isJson()) process.stdout.write(content + "\n");
				return;
			}
			if (action === "import") {
				if (!arg) fail("Usage: agent archetype import <file>");
				const fsp = await import("node:fs/promises");
				let content;
				try {
					content = await fsp.readFile(arg, "utf8");
				} catch (error) {
					// HIGH-4: only ENOENT means "not found"; a permission error
					// (EACCES) must be surfaced as such, not misreported.
					if (error && error.code === "ENOENT") fail(`Not found: ${arg}`);
					fail(
						`Cannot read ${arg}: ${error && error.message ? error.message : error}`,
					);
				}
				if (!/^# IDENTITY\.md/m.test(content))
					fail(`Not a valid identity archetype file: ${arg}`);
				const scope = opts.project ? "project" : "global";
				const file = idMod.idFile(scope);
				await writeFile(file, content);
				emit({ command: "archetype", action, name: arg, file });
				if (!isJson()) log.success(`Imported archetype → ${pretty(file)}`);
				return;
			}
			fail(`Unknown archetype action: ${action}. Use list|export|import`, {
				command: "archetype",
				action,
			});
		});

	program
		.command("template install <source>")
		.description("Install a personality bundle (agents/*.md) from a local dir or git URL.")
		.action(async (source) => {
			const fsp = await import("node:fs/promises");
			const { spawnSync } = await import("node:child_process");
			const os = await import("node:os");
			let bundleDir = null;
			let tmp = null;
			if (await exists(path.resolve(source))) {
				bundleDir = path.resolve(source);
			} else {
				tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-template-"));
				const r = spawnSync("git", ["clone", "--depth", "1", source, path.join(tmp, "bundle")], {
					encoding: "utf8",
				});
				if (!r.ok || r.status !== 0)
					fail(`template fetch failed: ${(r.stderr || "").slice(0, 300)}`);
				bundleDir = path.join(tmp, "bundle");
			}
			const candidates = [path.join(bundleDir, "agents"), bundleDir];
			const installed = [];
			for (const dir of candidates) {
				let entries = [];
				try {
					entries = await fsp.readdir(dir);
				} catch {
					continue;
				}
				for (const e of entries) {
					if (!e.endsWith(".md")) continue;
					const content = await fsp.readFile(path.join(dir, e), "utf8");
					const m = /^name:\s*(\S+)/m.exec(content);
					const name = (m ? m[1] : e.replace(/\.md$/, "")).replace(/[^A-Za-z0-9._-]/g, "");
					const target = path.join(AGENTS_DIR, "agents", `${name}.md`);
					await writeFile(target, content);
					installed.push(name);
				}
			}
			if (tmp) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
			emit({ command: "template", action: "install", source, installed });
			if (!isJson()) {
				if (!installed.length) log.info("No agents/*.md found in the bundle.");
				for (const n of installed) log.success(`Installed ${n}`);
			}
		});
}
