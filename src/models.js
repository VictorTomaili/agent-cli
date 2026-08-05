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
export function writeModelsMd({ includeCatalog = true } = {}) {
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
		"> Run `agent models research` to refresh the curated catalog below; run `agent models suggest` to auto-pick a model for each unresolved alias.",
		"",
		"## Aliases",
		"",
	];
	if (Object.keys(a).length === 0) {
		lines.push(
			"_No aliases configured yet. Run `agent models suggest` to auto-pick, or `agent models set <alias> <provider/model>` to assign manually._",
		);
		lines.push("");
	}
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
	if (includeCatalog) {
		lines.push(catalogMarkdown());
	}
	atomicWriteSync(MODELS_MD, lines.join("\n"));
	return MODELS_MD;
}

// --- Curated model catalog ---------------------------------------------------
// A bundled snapshot of well-known model families as of 2026. Used by:
//   1. `agent models research` to seed MODELS.md with real candidates (not just
//      categories) so the agent has data to assign to aliases.
//   2. `agent models suggest --auto` to pick a concrete provider/model per
//      alias based on the persona's role.
//   3. The brief's "unresolved alias" hint to recommend specific models.
//
// This is NOT a live registry. It is a curated baseline that the agent keeps
// current by running `agent models research` and updating entries. The intent
// is "agent-cli ships a useful starting catalog so the agent isn't staring at
// an empty file."

/**
 * Each entry: { id, provider, family, category, thinking, notes }.
 * `family` is the API family (openai, anthropic, gemini, mistral, ollama,
 * openrouter, …). `id` is the canonical model id.
 * `thinking` indicates whether the model supports a separate "thinking" mode.
 */
export const CATALOG = [
	// OpenAI
	{ id: "gpt-5", provider: "openai", family: "openai", category: "smart", thinking: true, notes: "Strongest general reasoning, 400k context, function-calling, vision, JSON mode. Good default for `smart` and `coding` aliases." },
	{ id: "gpt-5-mini", provider: "openai", family: "openai", category: "smart", thinking: true, notes: "Mid-tier GPT-5. Cheaper than gpt-5 with similar capability profile." },
	{ id: "gpt-4.1", provider: "openai", family: "openai", category: "coding", thinking: false, notes: "Reliable workhorse for code; 1M context, function-calling, JSON mode." },
	{ id: "gpt-4.1-mini", provider: "openai", family: "openai", category: "fast", thinking: false, notes: "Fast, cheap; good for bulk simple tasks and routing." },
	{ id: "gpt-4.1-nano", provider: "openai", family: "openai", category: "cheap", thinking: false, notes: "Lowest cost OpenAI model; use for classification, extraction, simple chat." },
	{ id: "o3", provider: "openai", family: "openai", category: "deepsearch", thinking: true, notes: "Reasoning model with tool use; best for multi-step research with code execution." },
	{ id: "o4-mini", provider: "openai", family: "openai", category: "coding", thinking: true, notes: "Reasoning + coding; competitive with o3 on SWE-bench at lower cost." },
	// Anthropic
	{ id: "claude-opus-4-7", provider: "anthropic", family: "anthropic", category: "smart", thinking: true, notes: "Anthropic flagship; 1M context, tool use, vision, strong at agentic loops." },
	{ id: "claude-sonnet-4-5", provider: "anthropic", family: "anthropic", category: "coding", thinking: true, notes: "Best coding/long-context workhorse; 1M context, strong at tool use." },
	{ id: "claude-haiku-4-5", provider: "anthropic", family: "anthropic", category: "fast", thinking: false, notes: "Fast, cheap, low-latency. Good default for sub-agent scouts." },
	// Google
	{ id: "gemini-2.5-pro", provider: "google", family: "gemini", category: "smart", thinking: true, notes: "2M context, vision, audio, video, function-calling. Strong default for `smart`." },
	{ id: "gemini-2.5-flash", provider: "google", family: "gemini", category: "fast", thinking: true, notes: "Fast, cheap, multimodal. Good default for `fast`/`cheap`." },
	{ id: "gemini-2.5-flash-lite", provider: "google", family: "gemini", category: "cheap", thinking: false, notes: "Cheapest Google model; bulk extraction, classification." },
	// Mistral
	{ id: "mistral-large-2", provider: "mistral", family: "mistral", category: "smart", thinking: false, notes: "Mistral flagship; 128k context, function-calling, JSON mode." },
	{ id: "mistral-small-3", provider: "mistral", family: "mistral", category: "fast", thinking: false, notes: "Mid-tier; good price/performance for routing." },
	{ id: "codestral-25", provider: "mistral", family: "mistral", category: "coding", thinking: false, notes: "Code-specialised; fast fill-in-the-middle completions." },
	// DeepSeek
	{ id: "deepseek-chat", provider: "deepseek", family: "openai", category: "cheap", thinking: false, notes: "Very cheap; OpenAI-compatible API. Good for `cheap`." },
	{ id: "deepseek-reasoner", provider: "deepseek", family: "openai", category: "deepsearch", thinking: true, notes: "Reasoning model; OpenAI-compatible. Good for `deepsearch`." },
	// Local
	{ id: "qwen2.5-coder:32b", provider: "ollama", family: "ollama", category: "coding", thinking: false, notes: "Local via Ollama; strong at code, no API cost, runs on 24GB+ VRAM." },
	{ id: "qwen2.5:72b", provider: "ollama", family: "ollama", category: "smart", thinking: false, notes: "Local via Ollama; close to GPT-4 class on benchmarks." },
	{ id: "llama-3.3-70b", provider: "ollama", family: "ollama", category: "smart", thinking: false, notes: "Local via Ollama; broad capability, multilingual." },
	{ id: "deepseek-r1:32b", provider: "ollama", family: "ollama", category: "deepsearch", thinking: true, notes: "Local reasoning model; useful when you need offline `deepsearch`." },
	// OpenRouter (multi-provider passthrough)
	{ id: "anthropic/claude-sonnet-4-5", provider: "openrouter", family: "openai", category: "coding", thinking: true, notes: "OpenRouter passthrough; pay-as-you-go across providers." },
	{ id: "openai/gpt-5", provider: "openrouter", family: "openai", category: "smart", thinking: true, notes: "OpenRouter passthrough for GPT-5." },
];

/** Look up a catalog entry by `id`. Returns null when absent. */
export function findInCatalog(id) {
	const target = String(id).toLowerCase();
	return CATALOG.find((m) => m.id.toLowerCase() === target) || null;
}

/** Pick the best catalog entry for an alias category. Prefers providers the
 *  user has used recently (looked up from config.json `providers` list) but
 *  falls back to a stable per-category default. */
export function pickForCategory(category, { preferredProviders } = {}) {
	const matches = CATALOG.filter((m) => m.category === category);
	if (!matches.length) return null;
	const ordered = [...matches].sort((a, b) => {
		const ap = preferredProviders?.includes(a.provider) ? 0 : 1;
		const bp = preferredProviders?.includes(b.provider) ? 0 : 1;
		return ap - bp;
	});
	return ordered[0];
}

/** Render the curated catalog as a Markdown block (used by `models research`). */
export function catalogMarkdown() {
	const lines = [
		"## Curated model catalog",
		"",
		"> Bundled 2026-Q2 baseline. Run `agent models research --refresh` after",
		"> investigating provider docs / changelogs to update this section.",
		"",
		"| id | provider | family | category | thinking | notes |",
		"|---|---|---|---|---|---|",
	];
	for (const m of CATALOG) {
		const thinking = m.thinking ? "✓" : "—";
		lines.push(
			`| \`${m.id}\` | ${m.provider} | ${m.family} | ${m.category} | ${thinking} | ${m.notes.replace(/\|/g, "\\|")} |`,
		);
	}
	lines.push("");
	return lines.join("\n");
}

// --- Live catalog fetch -----------------------------------------------------
// `agent models research --fetch` pulls a real, no-auth model list from a
// public endpoint and writes it into MODELS.md so the agent has current
// provider/model data instead of only the bundled baseline. Falls back
// gracefully to the baseline when offline.

/** Public, no-auth model registry with per-model context + pricing. */
const LIVE_SOURCES = [
	{
		name: "openrouter",
		url: "https://openrouter.ai/api/v1/models",
		parse: (json) => {
			const list = json?.data;
			if (!Array.isArray(list)) throw new Error("unexpected shape");
			return list
				.filter((m) => m && typeof m.id === "string" && !m.id.startsWith(":free"))
				.map((m) => {
					// OpenRouter pricing is USD per TOKEN (e.g. 2e-6 = $2/M).
					// Convert to the industry-standard $/1M-token figure.
					const p = m.pricing || {};
					const priceIn = p.prompt ? parseFloat(p.prompt) * 1e6 : 0;
					const priceOut = p.completion ? parseFloat(p.completion) * 1e6 : 0;
					return {
						id: m.id,
						provider: (m.id || "").split("/")[0] || "unknown",
						context: m.context_length || null,
						inputPer1M: priceIn,
						outputPer1M: priceOut,
						modalities: Array.isArray(m.modalities)
							? m.modalities.join(", ")
							: "",
					};
				})
				.slice(0, 500);
		},
	},
];

/**
 * Fetch the live model catalog from public endpoints.
 * Returns { ok: true, source, count, entries, fetchedAt } on success,
 * or { ok: false, reason, source? } when offline / parse fails.
 */
export async function fetchLiveCatalog({ timeoutMs = 8000 } = {}) {
	for (const src of LIVE_SOURCES) {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		try {
			const res = await fetch(src.url, { signal: ac.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			const entries = src.parse(json);
			if (!entries.length) throw new Error("empty model list");
			return {
				ok: true,
				source: src.name,
				count: entries.length,
				entries,
				fetchedAt: new Date().toISOString(),
			};
		} catch (error) {
			// try next source (or report the last failure)
		} finally {
			clearTimeout(timer);
		}
	}
	return { ok: false, reason: "all live sources failed or offline" };
}

/** Format a $/1M-token price without trailing zeros (0 → "—"). */
function formatPrice(per1M) {
	if (!per1M || !isFinite(per1M)) return "—";
	// $2.00/M, $0.30/M, $0.002/M — drop trailing zeros.
	return "$" + Number(per1M.toFixed(3)).toString() + "/M";
}

/** Render live entries as a Markdown table section for MODELS.md. */
export function liveCatalogMarkdown(result) {
	const lines = [
		"## Live model catalog",
		"",
		`> Fetched from ${result.source} at ${result.fetchedAt} (${result.count} models).`,
		"> Auto-refresh: `agent models research --fetch`. Pricing is USD per 1M tokens.",
		"",
		"| id | provider | context | input $/1M | output $/1M | modalities |",
		"|---|---|---|---|---|---|",
	];
	for (const m of result.entries) {
		const ctx = m.context ? String(m.context) : "—";
		const inp = formatPrice(m.inputPer1M);
		const out = formatPrice(m.outputPer1M);
		lines.push(
			`| \`${m.id}\` | ${m.provider} | ${ctx} | ${inp} | ${out} | ${m.modalities || "—"} |`,
		);
	}
	lines.push("");
	return lines.join("\n");
}
