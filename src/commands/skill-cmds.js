// src/commands/skill-cmds.js — skill, extracted from cli.js (HIGH-3).
// Injected deps: { emit, fail, log, c, isJson, ensureSkillStore,
//   refreshBlocks, isSkillAvailable, runSkill,
//   serializeEnvelope, envelope, JSON_COMPACT }.

/** Register the skill command. */
export function registerSkillCommands(
	program,
	{
		emit,
		fail,
		log,
		c,
		isJson,
		ensureSkillStore,
		refreshBlocks,
		isSkillAvailable,
		runSkill,
		serializeEnvelope,
		envelope,
		JSON_COMPACT,
	},
) {
	program
		.command("skill [args...]")
		.description(
			"Integrated skill manager: setup|refresh|status|active|gate, or pass commands such as list, show, cat, install, enable, disable, update, remove.",
		)
		.allowUnknownOption(true) // skill sub-commands accept their own flags (e.g. gate --task)
		.action(async (args) => {
			const sub = args[0];
			if (sub === "setup") {
				const store = await ensureSkillStore();
				const blocks = await refreshBlocks();
				emit({ command: "skill", sub: "setup", store, blocks });
				if (!isJson())
					log.success(
						`skill-cli store ready; blocks ${blocks.changed ? "refreshed" : "current"}`,
					);
				return;
			}
			if (sub === "refresh") {
				const blocks = await refreshBlocks();
				emit({ command: "skill", sub: "refresh", blocks });
				if (!isJson())
					log.success(
						`skill-cli block ${
							blocks.changed
								? c.green("refreshed in master")
								: "already current" +
									(blocks.reason ? c.gray(" (" + blocks.reason + ")") : "")
						}`,
					);
				return;
			}
			if (sub === "status") {
				emit({
					command: "skill",
					sub: "status",
					available: isSkillAvailable(),
					backend: "integrated",
					integrated: isSkillAvailable(),
				});
				if (!isJson()) {
					log.kv(
						"available",
						isSkillAvailable() ? c.green("yes") : c.red("no"),
					);
					log.kv("backend", "integrated");
				}
				return;
			}
			if (sub === "active") {
				const sg = await import("../skills-gate.js");
				const { GATE_DECIDE_HINT } = await import("../skill.js");
				const effective = sg.effectiveSkills(process.cwd());
				const installed = sg.listSkills();
				const active = installed.filter((s) => effective.includes(s.name));
				emit({
					command: "skill",
					sub: "active",
					active: active.map((s) => ({
						name: s.name,
						description: s.description,
						activation: s.activation,
						triggers: s.triggers,
					})),
					effective,
					hint: GATE_DECIDE_HINT,
				});
				if (!isJson()) {
					for (const s of active)
						log.raw(
							`  ${c.bold(s.name.padEnd(18))} ${s.description} ${c.gray("[" + s.activation.mode + "]")}`,
						);
					// The START GATE in AGENTS.md tells the agent to run this command
					// and then classify what comes back. Without the hint it gets a
					// bare list and no instruction to act on, so the gate does
					// nothing. Rendered from the shared constant, never a local copy.
					if (active.length) {
						log.raw("");
						for (const line of GATE_DECIDE_HINT.split("\n"))
							log.raw(line.startsWith("→") ? c.bold(line) : c.gray(line));
					} else {
						// Zero active skills is a valid answer, but printing nothing
						// at all reads as a broken command - and the START GATE sends
						// the agent here as its first action of the session.
						log.info("No active skills in this project.");
						log.dim("  Nothing to classify. Continue with the task.");
					}
				}
				return;
			}
			if (sub === "gate") {
				const sg = await import("../skills-gate.js");
				const op = args[1];
				if (op === "ack") {
					const flags = args.slice(2);
					const readFlag = (flag) => {
						const i = flags.indexOf(flag);
						return i >= 0 ? flags[i + 1] : null;
					};
					const enable = (readFlag("--enable") || "")
						.split(",")
						.filter(Boolean);
					const disable = (readFlag("--disable") || "")
						.split(",")
						.filter(Boolean);
					const session = flags.includes("--session");
					const remember = flags.includes("--remember");
					const r = sg.gateAck({
						enable,
						disable,
						session,
						remember,
						cwd: process.cwd(),
					});
					emit({ command: "skill", sub: "gate", op: "ack", ...r });
					if (!isJson()) log.success(`Gate ack ${r.decisionId}`);
					return;
				}
				if (op === "status") {
					const r = sg.gateStatus(process.cwd());
					emit({ command: "skill", sub: "gate", op: "status", ...r });
					if (!isJson())
						log.raw(`effective: ${r.effective.join(", ") || "(none)"}`);
					return;
				}
				const task = op === "--task" ? args[2] : null;
				if (!task)
					fail(
						"Usage: agent-cli skill gate --task <text> | gate ack --enable a --disable b [--session|--remember] | gate status",
					);
				const r = sg.gateForTask(task, process.cwd());
				emit({ command: "skill", sub: "gate", ...r });
				if (!isJson()) {
					log.kv("autoLoad", r.autoLoad.join(", ") || "(none)");
					log.kv("ask", r.ask.join(", ") || "(none)");
					log.kv("manual", r.manual.join(", ") || "(none)");
					for (const q of r.questions)
						log.warn(`? ${q.name}: ${q.question}`);
				}
				return;
			}
			// passthrough
			if (isJson()) {
				// JSON mode: capture the skill output and wrap it in the envelope so
				// stdout stays one parseable value. The child's stderr/code are DATA,
				// not the envelope error — the child's exit code is forwarded below.
				const r = runSkill(args);
				console.log(
					serializeEnvelope(
						envelope({
							command: "skill",
							data: {
								passthrough: true,
								args,
								output: r.stdout,
								error: r.stderr,
								code: r.code,
								ok: r.ok,
							},
						}),
						{ compact: JSON_COMPACT },
					),
				);
				process.exit(typeof r.code === "number" ? r.code : r.ok ? 0 : 1);
			}
			const r = runSkill(args, { stdio: "inherit" });
			process.exit(typeof r.code === "number" ? r.code : r.ok ? 0 : 1);
		});
}
