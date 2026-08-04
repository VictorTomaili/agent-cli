// src/models.js — model aliases: category → alias → concrete model (+thinking).
// Stored in config.json `models.aliases` (machine) + MODELS.md (human-readable).

import path from "node:path";
import fs from "node:fs";
import { HOME } from "./util.js";
import {
	loadConfigSync,
	saveConfigSync,
	isConfigCorrupt,
} from "./config.js";

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

const CORRUPT_MSG =
	"config.json is corrupt; repair or remove it before changing model aliases";

/** Load config through the central corruption-aware loader. Throws on corrupt. */
function readConfig() {
	const cfg = loadConfigSync();
	if (isConfigCorrupt(cfg)) throw new Error(CORRUPT_MSG);
	return cfg;
}

function atomicWriteSync(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(tmp, content, "utf8");
		try {
			fs.renameSync(tmp, file);
		} catch (error) {
			if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
			fs.rmSync(file, { force: true });
			fs.renameSync(tmp, file);
		}
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}
export function getAliases() {
	let cfg;
	try {
		cfg = readConfig();
	} catch {
		// Permissive read: a corrupt config reads as empty (existing behavior).
		return {};
	}
	return cfg.models?.aliases ?? {};
}
export function getAlias(name) {
	return getAliases()[name] ?? null;
}
export function setAlias(name, { model, category, thinking, fallbacks }) {
	// Throws on corrupt config BEFORE any mutation — the original bytes stay intact.
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
	// Central corruption-aware save — also refuses to replace a corrupt config.
	saveConfigSync(cfg);
	return cfg.models.aliases[name];
}
export function writeModelsMd() {
	// Refuse to generate a misleading document from a corrupt config.
	const cfg = readConfig();
	const a = cfg.models?.aliases ?? {};
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
	atomicWriteSync(MODELS_MD, lines.join("\n"));
	return MODELS_MD;
}
