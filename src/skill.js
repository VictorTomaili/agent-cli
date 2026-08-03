// src/skill.js — skill-cli integration via the vendored submodule.
// Prefers a globally-installed `skill` bin; falls back to running the submodule's
// cli.js with node (after ensuring its deps). agent-cli owns the skill-cli
// instruction BLOCK inside the master, so we never inject into the pointer stubs.

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { HOME, exists, ensureDir, writeFile } from "./util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SUBMODULE_ROOT = path.resolve(__dirname, "../vendor/skill-cli");
const SUBMODULE_CLI = path.join(SUBMODULE_ROOT, "src/cli.js");
const SUBMODULE_PKG = path.join(SUBMODULE_ROOT, "package.json");

const SKILL_HOME = path.join(HOME, ".skill-cli");
const SKILL_STORE = path.join(SKILL_HOME, "store");
const SKILL_CONFIG = path.join(SKILL_HOME, "config.yaml");

export function submodulePresent() {
	return fs.existsSync(SUBMODULE_CLI);
}

export function submoduleHasDeps() {
	return fs.existsSync(path.join(SUBMODULE_ROOT, "node_modules"));
}

export function readSubmodulePkg() {
	try {
		return JSON.parse(fs.readFileSync(SUBMODULE_PKG, "utf8"));
	} catch {
		return null;
	}
}

export function submoduleVersion() {
	return readSubmodulePkg()?.version ?? null;
}

/** Resolve the global `skill` bin on PATH (or null). */
export function globalSkillBin() {
	try {
		const r = spawnSync("skill", ["--version"], {
			encoding: "utf8",
			shell: true,
			stdio: "pipe",
		});
		if (r.status === 0 && /skill-cli/i.test(r.stdout)) {
			const w = spawnSync(
				process.platform === "win32" ? "where" : "which",
				["skill"],
				{
					encoding: "utf8",
					shell: true,
				},
			);
			const line = (w.stdout || "").split(/\r?\n/).find((l) => l.trim());
			return line ? line.trim() : "skill";
		}
	} catch {
		/* ignore */
	}
	return null;
}

export function isSkillAvailable() {
	return !!globalSkillBin() || (submodulePresent() && submoduleHasDeps());
}

/** Ensure the submodule's deps are installed so it can run. Idempotent. */
export function ensureSubmoduleDeps() {
	if (!submodulePresent()) return { ok: false, reason: "no-submodule" };
	if (submoduleHasDeps()) return { ok: true, reason: "present" };
	const r = spawnSync("npm", ["install", "--omit=dev"], {
		cwd: SUBMODULE_ROOT,
		encoding: "utf8",
		shell: true,
		stdio: "pipe",
	});
	return {
		ok: r.status === 0,
		reason: r.status === 0 ? "installed" : "failed",
		stderr: r.stderr,
	};
}

function normalize(r) {
	return {
		code: r.status,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		ok: r.status === 0,
		error: r.error?.message ?? null,
	};
}

/** Run skill-cli: prefer the global bin, else run the submodule via node. */
export function runSkill(args, opts = {}) {
	const bin = globalSkillBin();
	const stdio = opts.stdio || "pipe";
	if (bin) {
		return normalize(
			spawnSync(bin, args, {
				encoding: "utf8",
				cwd: opts.cwd || process.cwd(),
				env: process.env,
				shell: true,
				stdio,
			}),
		);
	}
	const deps = ensureSubmoduleDeps();
	if (!deps.ok) {
		return {
			code: 1,
			stdout: "",
			stderr: "skill-cli submodule deps missing",
			ok: false,
			error: deps.reason,
		};
	}
	return normalize(
		spawnSync(process.execPath, [SUBMODULE_CLI, ...args], {
			encoding: "utf8",
			cwd: opts.cwd || process.cwd(),
			env: process.env,
			stdio,
		}),
	);
}

/** Create ~/.skill-cli/{store,config.yaml} if missing so skill-cli commands work. */
export async function ensureSkillStore() {
	const actions = [];
	if (!(await exists(SKILL_STORE))) {
		await ensureDir(SKILL_STORE);
		actions.push("created-store");
	}
	if (!(await exists(SKILL_CONFIG))) {
		// Raw backslashes are literal in YAML plain scalars — matches skill-cli's own output.
		const yaml = `version: 1\nstore: ${SKILL_STORE}\ndefaults: []\n`;
		await writeFile(SKILL_CONFIG, yaml);
		actions.push("created-config");
	}
	return { ok: true, actions, store: SKILL_STORE, config: SKILL_CONFIG };
}

/** Best-effort skill-cli version (global bin first, then submodule package.json). */
export function skillVersion() {
	const bin = globalSkillBin();
	if (bin) {
		const r = runSkill(["--version"]);
		if (r.ok) {
			const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
			if (m) return { version: m[1], source: "global", bin };
		}
	}
	return {
		version: submoduleVersion(),
		source: submodulePresent() ? "submodule" : "none",
		bin: null,
	};
}

export const PATHS = {
	SKILL_HOME,
	SKILL_STORE,
	SKILL_CONFIG,
	SUBMODULE_ROOT,
	SUBMODULE_CLI,
};
