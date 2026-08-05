// src/skills-gate.js — core-level structured skill gate.
// Reads the skill store + configs directly (the sub-CLI only consumes
// name/description/version/triggers) and adds the `activation` contract:
// mode auto|ask|manual, axes, parameters, question. Gate decisions persist to
// ~/.skill-cli/policy.json (+ project skill.config when --remember).

import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { HOME } from "./util.js";

const SKILL_HOME = path.join(HOME, ".skill-cli");
const STORE_DIR = path.join(SKILL_HOME, "store");
const GLOBAL_CONFIG = path.join(SKILL_HOME, "config.yaml");
const POLICY_FILE = path.join(SKILL_HOME, "policy.json");
const PROJECT_CONFIG = "skill.config";

const VALID_MODES = ["auto", "ask", "manual"];

function parseSkillMd(content) {
	if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { data: {}, body: content };
	let data = {};
	try {
		data = yaml.parse(m[1]) || {};
	} catch {
		/* malformed */
	}
	return { data, body: m[2] || "" };
}

function getTriggers(data) {
	const t = data.triggers;
	if (Array.isArray(t)) return t.map((x) => String(x).trim().replace(/^\/+/, "").toLowerCase()).filter(Boolean);
	if (typeof t === "string")
		return t.split(",").map((x) => String(x).trim().replace(/^\/+/, "").toLowerCase()).filter(Boolean);
	return [];
}

function parseActivation(act) {
	if (!act || typeof act !== "object")
		return { mode: "auto", axes: [], parameters: [], question: null };
	return {
		mode: VALID_MODES.includes(act.mode) ? act.mode : "auto",
		axes: Array.isArray(act.axes) ? act.axes : [],
		parameters: Array.isArray(act.parameters) ? act.parameters : [],
		question: typeof act.question === "string" ? act.question : null,
	};
}

/** Every installed skill, with the activation contract. */
export function listSkills() {
	if (!fs.existsSync(STORE_DIR)) return [];
	const out = [];
	for (const entry of fs.readdirSync(STORE_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const md = path.join(STORE_DIR, entry.name, "SKILL.md");
		if (!fs.existsSync(md)) continue;
		try {
			const { data } = parseSkillMd(fs.readFileSync(md, "utf8"));
			out.push({
				name: data.name || entry.name,
				dir: entry.name,
				description: data.description || "",
				version: data.version || "-",
				triggers: getTriggers(data),
				activation: parseActivation(data.activation),
				path: md,
			});
		} catch {
			/* skip */
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readGlobalDefaults() {
	try {
		const cfg = yaml.parse(fs.readFileSync(GLOBAL_CONFIG, "utf8")) || {};
		return Array.isArray(cfg.defaults) ? cfg.defaults : [];
	} catch {
		return [];
	}
}

/** Project skill.config: null = missing, { ok:false } = corrupt, else the shape. */
export function readProjectConfig(cwd = process.cwd()) {
	let raw;
	try {
		raw = fs.readFileSync(path.join(cwd, PROJECT_CONFIG), "utf8");
	} catch {
		return null;
	}
	let parsed;
	try {
		parsed = yaml.parse(raw) || {};
	} catch {
		return { ok: false, reason: "parse error" };
	}
	return {
		inherit: parsed.inherit !== false,
		deny: Array.isArray(parsed.deny) ? parsed.deny : [],
		allow: Array.isArray(parsed.allow) ? parsed.allow : [],
	};
}

/** Effective skill names (canonical) for a cwd (allow wins over deny). */
export function effectiveSkills(cwd = process.cwd()) {
	const installed = listSkills();
	const byLower = new Map(installed.map((s) => [s.name.toLowerCase(), s.name]));
	const proj = readProjectConfig(cwd);
	const enabled = new Set(
		(proj && proj.inherit === false ? [] : readGlobalDefaults()).map((s) =>
			String(s).toLowerCase(),
		),
	);
	if (proj && proj.ok !== false) {
		const allowLower = new Set(proj.allow.map((a) => String(a).toLowerCase()));
		for (const d of proj.deny) {
			for (const name of [...enabled]) {
				if (allowLower.has(name)) continue;
				if (String(d).toLowerCase() === name || d === "*") enabled.delete(name);
			}
		}
		for (const a of proj.allow) enabled.add(String(a).toLowerCase());
	}
	return [...enabled]
		.filter((n) => byLower.has(n))
		.map((n) => byLower.get(n))
		.sort();
}

/** Classify installed skills for a task: autoLoad / ask / manual + questions. */
export function gateForTask(task, cwd = process.cwd()) {
	const installed = listSkills();
	const effective = new Set(effectiveSkills(cwd).map((s) => s.toLowerCase()));
	const t = String(task || "").toLowerCase();
	const autoLoad = [];
	const ask = [];
	const manual = [];
	const questions = [];
	for (const s of installed) {
		const axisHit =
			s.activation.axes.length === 0 ||
			s.activation.axes.some((a) => t.includes(String(a).toLowerCase()));
		if (s.activation.mode === "ask") {
			ask.push(s.name);
			if (s.activation.question)
				questions.push({ name: s.name, question: s.activation.question });
		} else if (s.activation.mode === "manual") {
			if (axisHit) manual.push(s.name);
		} else if (effective.has(s.name.toLowerCase()) || axisHit) {
			autoLoad.push(s.name);
		}
	}
	return {
		ok: true,
		task,
		autoLoad: [...new Set(autoLoad)].sort(),
		ask: [...new Set(ask)].sort(),
		manual: [...new Set(manual)].sort(),
		questions,
	};
}

function readPolicy() {
	try {
		return JSON.parse(fs.readFileSync(POLICY_FILE, "utf8"));
	} catch {
		return { decisions: [], session: [] };
	}
}

/** Persist a gate ack. `--remember` also writes the project skill.config. */
export function gateAck({
	enable = [],
	disable = [],
	session = false,
	remember = false,
	cwd = process.cwd(),
} = {}) {
	const policy = readPolicy();
	const decisionId = `g-${Date.now().toString(36)}`;
	const decision = { decisionId, enable, disable, session, remember, at: new Date().toISOString() };
	if (remember) {
		const proj = readProjectConfig(cwd) || { inherit: true, deny: [], allow: [] };
		if (proj.ok !== false) {
			for (const e of enable) if (!proj.allow.includes(e)) proj.allow.push(e);
			for (const d of disable) {
				proj.allow = proj.allow.filter((x) => x !== d);
				if (!proj.deny.includes(d)) proj.deny.push(d);
			}
			fs.writeFileSync(
				path.join(cwd, PROJECT_CONFIG),
				yaml.stringify({ inherit: proj.inherit, deny: proj.deny, allow: proj.allow }),
				"utf8",
			);
		}
	}
	if (session) {
		policy.session = policy.session || [];
		policy.session.push(decision);
	}
	policy.decisions = policy.decisions || [];
	policy.decisions.push(decision);
	fs.mkdirSync(path.dirname(POLICY_FILE), { recursive: true });
	fs.writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2) + "\n");
	return { ok: true, decisionId, enable, disable, session, remember, file: POLICY_FILE };
}

export function gateStatus(cwd = process.cwd()) {
	return {
		ok: true,
		effective: effectiveSkills(cwd),
		policy: readPolicy(),
	};
}

export { SKILL_HOME, STORE_DIR, POLICY_FILE };
