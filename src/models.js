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

export const DEFAULT_ALIASES = {
	"fast-model": { category: "fast", model: "minimax/MiniMax-M3", thinking: "" },
	"cheap-model": {
		category: "cheap",
		model: "minimax/MiniMax-M3",
		thinking: "",
	},
	"smart-model": {
		category: "smart",
		model: "zai/glm-5.2",
		thinking: "medium",
	},
	"coding-model": {
		category: "coding",
		model: "openai-codex/gpt-5.6-sol",
		thinking: "high",
	},
	"review-model": {
		category: "smart",
		model: "openai-codex/gpt-5.6-sol",
		thinking: "max",
	},
	"deep-model": {
		category: "deepsearch",
		model: "zai/glm-5.2",
		thinking: "high",
	},
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
export function setAlias(name, { model, category, thinking }) {
	const cfg = readConfig();
	cfg.models = cfg.models || {};
	cfg.models.aliases = cfg.models.aliases || {};
	const prev = cfg.models.aliases[name] || {};
	cfg.models.aliases[name] = {
		...prev,
		...(category != null ? { category } : {}),
		...(model != null ? { model } : {}),
		...(thinking != null ? { thinking } : {}),
	};
	writeConfig(cfg);
	return cfg.models.aliases[name];
}
/** Seed defaults without overwriting user-defined aliases. */
export function ensureDefaultAliases() {
	const cfg = readConfig();
	cfg.models = cfg.models || {};
	const existing = cfg.models.aliases || {};
	cfg.models.aliases = { ...DEFAULT_ALIASES, ...existing };
	writeConfig(cfg);
	return cfg.models.aliases;
}
export function writeModelsMd() {
	const a = getAliases();
	const lines = [
		"# MODELS.md — model aliases",
		"",
		"> Semantic model roles (category → alias → concrete model). Sub-agents reference aliases in frontmatter (`model: <alias>`); the subagent extension resolves them. Change an alias: `agent models set <alias> <provider/model>`.",
		"",
		"| Alias | Category | Model | Thinking | Use |",
		"|------|----------|-------|----------|-----|",
	];
	for (const [name, v] of Object.entries(a))
		lines.push(
			`| \`${name}\` | ${v.category} | \`${v.model}\` | ${v.thinking || "—"} | ${CAT_DESC[v.category] || ""} |`,
		);
	lines.push(
		"",
		"## Categories",
		...CATEGORIES.map((c) => `- **${c}** — ${CAT_DESC[c]}`),
		"",
	);
	fs.writeFileSync(MODELS_MD, lines.join("\n"), "utf8");
	return MODELS_MD;
}
