// src/color.js — the color-support decision, settled before picocolors loads.
//
// picocolors resolves `isColorSupported` once, at import time, from
// process.argv/process.env — and it force-enables color on Windows:
//
//   !(NO_COLOR || --no-color) &&
//   (FORCE_COLOR || --color || platform === "win32" || (stdout.isTTY && TERM !== "dumb") || CI)
//
// That `platform === "win32"` clause means `agent-cli status > out.txt` on
// Windows writes ANSI escapes into the file. This module applies the same rule
// *without* the win32 clause and, when the answer is "no color", exports the
// decision as NO_COLOR so picocolors picks it up (and so do child processes we
// spawn). It must therefore be imported before src/util.js — see the import
// order in src/cli.js.

/** True when ANSI output should be suppressed for this process. */
export function colorDisabled({
	env = process.env,
	argv = process.argv,
	stdout = process.stdout,
} = {}) {
	if (env.NO_COLOR || argv.includes("--no-color")) return true;
	if (env.FORCE_COLOR || argv.includes("--color") || env.CI) return false;
	return !(stdout && stdout.isTTY && env.TERM !== "dumb");
}

if (colorDisabled()) process.env.NO_COLOR = "1";
