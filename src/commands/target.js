import { log, c } from "../util.js";
import { getTarget, pathFor } from "../targets.js";
import {
	effectiveProjectIds,
	loadConfig,
	isConfigCorrupt,
	atomicEnableGlobal,
	atomicDisableGlobal,
	atomicEnableProjectTarget,
	atomicDisableProjectTarget,
} from "../config.js";
import { linkTarget, unlinkTarget, targetPath } from "../pointer.js";

/** Register target enable/disable commands without coupling them to cli.js globals. */
export function registerTargetCommand(
	program,
	{ emit, fail, masterPaths, isJson },
) {
	program
		.command("target <action> [id]")
	.description(
		"Enable or disable an agent-cli target (writes/removes its pointer stub and updates config.json — unlike link/unlink, which only touch pointer files). Action: enable|disable <id>. -g/--global for home scope (default), -p/--project for project scope. Use 'agent-cli targets' to list known ids.",
	)
		.option("-g, --global")
		.option("-p, --project")
		.action(async (action, id, opts) => {
			if (!id || !["enable", "disable", "on", "off"].includes(action))
				fail("Usage: agent-cli target enable|disable <id> [-g|-p]");
			if (opts.global && opts.project)
				fail("Use either -g or -p, not both", { command: "target", action, id });
			const t = getTarget(id);
			if (!t)
				fail(`Unknown target: ${id}. Run ${c.cyan("agent-cli targets")}.`, {
					command: "target",
					action,
					id,
				});
			const scope = opts.project ? "project" : "global";
			const enabling = action === "enable" || action === "on";
			let cfg = await loadConfig();
			// Refuse to mutate a corrupt config — original bytes are preserved.
			if (isConfigCorrupt(cfg))
				fail(
					"config.json is corrupt; repair or remove it before changing settings",
					{ command: "target", action, id, scope },
				);
			// Validate target scope BEFORE any mutation or persistence: a target may
			// only be enabled/disabled in a scope it actually supports (e.g. cursor
			// has no global path, so `target enable cursor --global` is rejected).
			if (!pathFor(t, scope))
				fail(
					`Target '${id}' does not support ${scope} scope.`,
					{
						command: "target",
						action,
						id,
						scope,
						ok: false,
						reason: "unsupported-scope",
					},
				);
			const { masterAbs, masterTilde } = masterPaths(scope, process.cwd());
			const root = process.cwd();
			let result;
			if (enabling) {
				// Deploy BEFORE persisting: only saveConfig after a successful link.
				result = await linkTarget(t, scope, { masterAbs, masterTilde });
				if (result.blocked === "native-content" || result.skipped) {
					fail(
						`Cannot enable ${id} (${scope}): ${
							result.blocked ?? result.skipped
						}${result.hint ? ` (${result.hint})` : ""}.`,
						{
							command: "target",
							action,
							id,
							scope,
							ok: false,
							reason: result.blocked ?? result.skipped,
							result,
						},
					);
				}
				// P0-3: mutate config atomically (lock + read-merge-write) so
				// concurrent enables never lose each other's update.
				cfg =
					scope === "global"
						? atomicEnableGlobal(id)
						: atomicEnableProjectTarget(root, id);
			} else {
				const enabledIds =
					scope === "global" ? cfg.global : effectiveProjectIds(cfg, root);
				const shared = enabledIds.some((otherId) => {
					if (otherId === id) return false;
					const other = getTarget(otherId);
					return other && targetPath(other, scope) === targetPath(t, scope);
				});
				// Deploy BEFORE persisting: only saveConfig after a successful unlink.
				result = await unlinkTarget(t, scope, { preserve: shared });
				if (result.skipped || result.blocked) {
					fail(
						`Cannot disable ${id} (${scope}): ${
							result.skipped ?? result.blocked
						}.`,
						{
							command: "target",
							action,
							id,
							scope,
							ok: false,
							reason: result.skipped ?? result.blocked,
							result,
						},
					);
				}
				// P0-3: mutate config atomically.
				cfg =
					scope === "global"
						? atomicDisableGlobal(id)
						: atomicDisableProjectTarget(root, id);
			}
			emit({
				command: "target",
				action,
				id,
				scope,
				ok: true,
				config: {
					global: cfg.global,
					project: cfg.project,
					projectTargets: cfg.projectTargets,
				},
				result,
			});
			if (!isJson())
				log.success(`${enabling ? "enabled" : "disabled"} ${id} (${scope})`);
		});
}
