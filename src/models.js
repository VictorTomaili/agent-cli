// src/models.js — model aliases: category → alias → concrete model (+thinking).
// Stored in config.json `models.aliases` (machine) + MODELS.md (human-readable).

import path from "node:path";
import fs from "node:fs";
import { HOME, CONFIG_FILE } from "./util.js";

const CONFIG = CONFIG_FILE;
export const MODELS_MD = path.join(HOME, ".agents", "MODELS.md");

export const CATEGORIES = [
	"fast",
	"cheap",
	"smart",
	"coding",
	"deepsearch",
	"vision",
];
const CAT_DESC = {
	fast: "low-latency, simple tasks",
	cheap: "cost-minimal, bulk/simple",
	smart: "strongest general reasoning",
	coding: "strong at code",
	deepsearch: "long-context + tools, research/web",
	vision: "image-capable",
};

function readConfig() {
	try {
		return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
	} catch {
		return {};
	}
}
function writeConfig(cfg) {
	fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
	fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
export function getAliases() {
	const cfg = readConfig();
	return cfg.models?.aliases ?? {};
}
export function getAlias(name) {
	return getAliases()[name] ?? null;
}
export function setAlias(name, { model, category, thinking, fallbacks }) {
	const cfg = readConfig();
	cfg.models = cfg.models || {};
	cfg.models.aliases = cfg.models.aliases || {};
	const prev = cfg.models.aliases[name] || {};
	cfg.models.aliases[name] = {
		...prev,
		...(category != null ? { category } : {}),
		...(model != null ? { model } : {}),
		...(thinking != null ? { thinking } : {}),
		...(fallbacks != null
			? { fallbacks: [...new Set(fallbacks.filter(Boolean))] }
			: {}),
	};
	writeConfig(cfg);
	return cfg.models.aliases[name];
}
export function writeModelsMd() {
	const a = getAliases();
	const esc = (v) =>
		String(v ?? "")
			.replace(/&/g, "&amp;")
			.replace(/"/g, "&quot;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
	const lines = [
		"# MODELS.md — model aliases",
		"",
		"> When a configured model is unavailable, research the current host/provider model stack, select the best compatible equivalent, and test it with a minimal echo request before assigning it. Preserve the alias category, capability, and fallback intent. agent-cli only stores configuration; it does not perform research, model calls, or capability tests.",
		"> Edit with `agent models set <alias> <provider/model> --fallback <provider/model>...`.",
		"",
		"## Aliases",
		"",
	];
	for (const [name, v] of Object.entries(a))
		lines.push(
			`<ALIAS name="${esc(name)}" category="${esc(v.category)}" thinking="${esc(v.thinking)}" fallbacks="${esc((v.fallbacks || []).join(","))}">${esc(v.model)}</ALIAS>`,
		);
	lines.push(
		"",
		"## Categories",
		...CATEGORIES.map((c) => `- **${c}** — ${CAT_DESC[c]}`),
		"",
	);
	fs.mkdirSync(path.dirname(MODELS_MD), { recursive: true });
	fs.writeFileSync(MODELS_MD, lines.join("\n"), "utf8");
	return MODELS_MD;
}
