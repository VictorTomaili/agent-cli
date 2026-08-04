import { log, c } from "../util.js";
import { getTarget } from "../targets.js";
import {
	effectiveProjectIds,
	enableGlobal,
	disableGlobal,
	loadConfig,
	saveConfig,
} from "../config.js";
import { linkTarget, unlinkTarget, targetPath } from "../pointer.js";

/** Register target enable/disable commands without coupling them to cli.js globals. */
export function registerTargetCommand(
	program,
	{ emit, fail, ctxPaths, isJson },
) {
	program
		.command("target <action> [id]")
		.description(
			"enable|disable a target globally (--project for project scope)",
		)
		.option("-g, --global")
		.option("-p, --project")
		.action(async (action, id, opts) => {
			if (!id || !["enable", "disable", "on", "off"].includes(action))
				fail("Usage: agent target enable|disable <id> [-g|-p]");
			const t = getTarget(id);
			if (!t) fail(`Unknown target: ${id}. Run ${c.cyan("agent targets")}.`);
			const scope = opts.project ? "project" : "global";
			const cfg = await loadConfig();
			const enabling = action === "enable" || action === "on";
			if (scope === "global")
				enabling ? enableGlobal(cfg, id) : disableGlobal(cfg, id);
			else
				enabling
					? (cfg.project = Array.from(
							new Set([...(Array.isArray(cfg.project) ? cfg.project : []), id]),
						))
					: (cfg.project = (
							Array.isArray(cfg.project)
								? cfg.project
								: effectiveProjectIds(cfg)
						).filter((x) => x !== id));
			await saveConfig(cfg);
			const { masterAbs, masterTilde } = ctxPaths();
			let result;
			if (enabling) {
				result = await linkTarget(t, scope, { masterAbs, masterTilde });
			} else {
				const enabledIds =
					scope === "global" ? cfg.global : effectiveProjectIds(cfg);
				const shared = enabledIds.some((otherId) => {
					if (otherId === id) return false;
					const other = getTarget(otherId);
					return other && targetPath(other, scope) === targetPath(t, scope);
				});
				result = await unlinkTarget(t, scope, { preserve: shared });
			}
			emit({
				command: "target",
				action,
				id,
				scope,
				config: { global: cfg.global, project: cfg.project },
				result,
			});
			if (!isJson())
				log.success(`${enabling ? "enabled" : "disabled"} ${id} (${scope})`);
		});
}
