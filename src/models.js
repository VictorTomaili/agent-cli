// src/models.js — model aliases: category → alias → concrete model (+thinking).
// Stored in config.json `models.aliases` (machine) + MODELS.md (human-readable).

import fs from "node:fs";
import path from "node:path";
import { HOME, writeFileSync } from "./util.js";
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

/** Safe alias name pattern: lowercase alphanumeric + hyphen, must start
 *  alphanumeric. The historical write path accepted ANY key, so names like
 *  `smart-model <!-- ... -->` (pasted HTML commentary) could pollute
 *  config.json#models.aliases. Rejecting the pattern on write closes F10. */
export const ALIAS_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Whether `name` is an acceptable alias key. */
export function isValidAliasName(name) {
	return ALIAS_NAME_RE.test(String(name ?? ""));
}

/** Filter an aliases object to the keys that fail the safe pattern.
 *  `aliases` defaults to the live config (getAliases treats a corrupt config
 *  as empty, so this never throws). */
export function invalidAliasNames(aliases = getAliases()) {
	return Object.keys(aliases).filter((k) => !isValidAliasName(k));
}

/** Load config through the central corruption-aware loader. Throws on corrupt. */
function readConfig() {
	const cfg = loadConfigSync();
	if (isConfigCorrupt(cfg)) throw new Error(CORRUPT_MSG);
	return cfg;
}

// HIGH-6: writeModelsMd uses the shared util.writeFileSync (temp + rename +
// random suffix) instead of a drifted per-module duplicate.
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
/**
 * Remove an alias. Returns the removed entry, or null when there was none.
 *
 * Deliberately does NOT validate the name: aliases predating the name check
 * (P11 rejects invalid names on write, but nothing could clean the ones already
 * in config.json — e.g. a key with a trailing HTML comment) are exactly the
 * ones a user needs to remove. Refusing to delete a malformed name would leave
 * it unfixable through the CLI, which is the state this command exists to end.
 */
export function removeAlias(name) {
	// Throws on corrupt config BEFORE any mutation — original bytes stay intact.
	const cfg = readConfig();
	const aliases = cfg.models?.aliases;
	if (!aliases || !Object.hasOwn(aliases, name)) return null;
	const removed = aliases[name];
	delete aliases[name];
	saveConfigSync(cfg);
	return removed;
}

export function setAlias(name, { model, category, thinking, fallbacks }) {
	if (!isValidAliasName(name)) {
		const e = new Error(
			`invalid alias name: ${name} - must match ^[a-z0-9][a-z0-9-]*$`,
		);
		e.code = "INVALID_ALIAS_NAME";
		throw e;
	}
	// Throws on corrupt config BEFORE any mutation — the original bytes stay intact.
	const cfg = readConfig();
	cfg.models = cfg.models || {};
	cfg.models.aliases = cfg.models.aliases || {};
	const prev = cfg.models.aliases[name] || {};
	cfg.models.aliases[name] = {
		...prev,
		...(category == null ? {} : { category }),
		...(model == null ? {} : { model }),
		...(thinking == null ? {} : { thinking }),
		...(fallbacks == null
			? {}
			: { fallbacks: [...new Set(fallbacks.filter(Boolean))] }),
	};
	// Central corruption-aware save — also refuses to replace a corrupt config.
	saveConfigSync(cfg);
	return cfg.models.aliases[name];
}
/** Best-effort synchronous read of the existing MODELS.md; null if absent/unreadable. */
function readExistingModelsMd() {
	try {
		return fs.readFileSync(MODELS_MD, "utf8");
	} catch {
		return null;
	}
}

/** Replace a `## Heading` section in place (up to the next `## ` heading or
 *  EOF), or append it if the heading isn't present yet. Same pattern as
 *  mergeLiveCatalogSection's "## Live model catalog" handling below. */
function replaceOrAppendSection(content, heading, newSection) {
	const re = new RegExp(`${heading}[\\s\\S]*?(?=\\n## |$)`);
	const found = content.match(re);
	if (found) {
		// Preserve a blank line before whatever follows, unless this section is at EOF.
		const followedByMore = found.index + found[0].length < content.length;
		return content.replace(re, newSection.trimEnd() + (followedByMore ? "\n" : ""));
	}
	return content.trimEnd() + "\n\n" + newSection.trimEnd() + "\n";
}

/**
 * Sync MODELS.md's `## Aliases` block with config.json, WITHOUT touching
 * anything else in the file. Every other section — `## Categories`, the
 * curated/live model catalog, and any content a user or agent appended
 * (e.g. a "Pi Agent Bridge" or notes section) — is preserved byte-for-byte
 * on an existing file; only a brand-new file gets the full starter
 * document. This mirrors the managed-block pattern `src/blocks.js` uses for
 * the master AGENTS.md: the tool owns a specific region, not the whole file.
 *
 * agent-cli no longer emits a model catalog of its own, so no path here can
 * overwrite a catalog section a user or agent wrote by hand.
 */
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

	const aliasLines = ["## Aliases", ""];
	if (Object.keys(a).length === 0) {
		aliasLines.push(
			"_No aliases configured yet. Run `agent-cli models suggest` to auto-pick, or `agent-cli models set <alias> <provider/model>` to assign manually._",
			"",
		);
	}
	for (const [name, v] of Object.entries(a))
		aliasLines.push(
			`<ALIAS name="${esc(name)}" category="${esc(v.category)}" thinking="${esc(v.thinking)}" fallbacks="${esc((v.fallbacks || []).join(","))}">${esc(v.model)}</ALIAS>`,
		);
	aliasLines.push("");
	const aliasSection = aliasLines.join("\n");
	const categoriesSection = [
		"## Categories",
		...CATEGORIES.map((c) => `- **${c}** — ${CAT_DESC[c]}`),
		"",
	].join("\n");

	const existing = readExistingModelsMd();
	if (existing == null) {
		// First-time creation: no prior content to preserve.
		const lines = [
			"# MODELS.md — model aliases",
			"",
			"> When a configured model is unavailable, research the current host/provider model stack, select the best compatible equivalent, and test it with a minimal echo request before assigning it. Preserve the alias category, capability, and fallback intent. agent-cli only stores configuration; it does not perform research, model calls, or capability tests.",
			"> Edit with `agent-cli models set <alias> <provider/model> --fallback <provider/model>...`.",
			"> Run `agent-cli models research --fetch` to import a candidate list, then `agent-cli models suggest --apply` to assign one to each unresolved alias.",
			"",
			aliasSection,
			categoriesSection,
		];
		writeFileSync(MODELS_MD, lines.join("\n"));
		return MODELS_MD;
	}

	let out = replaceOrAppendSection(existing, "## Aliases", aliasSection);
	if (!/##\s+Categories/.test(out)) {
		out = out.trimEnd() + "\n\n" + categoriesSection;
	}
	writeFileSync(MODELS_MD, out.trimEnd() + "\n");
	return MODELS_MD;
}

// --- Model candidates --------------------------------------------------------
// agent-cli ships NO model data. It used to carry a hardcoded 24-entry catalog
// here, which went stale between releases and was written into the user's
// MODELS.md as if authoritative - contradicting the header this same file
// writes: "agent-cli only stores configuration; it does not perform research,
// model calls, or capability tests."
//
// Candidates now come from ONE place: the live catalog imported by
// `agent-cli models research --fetch` and persisted in config.json under
// `models.liveCatalog`. When nothing has been imported there are no candidates,
// and that is a legitimate, self-healing state rather than an error - every
// caller reports NO_CATALOG_HINT instead of guessing.

/** The remedy when there is genuinely nothing to pick from, so the user sees the
 *  same two commands whichever surface they hit it from. */
export const NO_CATALOG_HINT =
	"No model candidates available - import one with `agent-cli models research --fetch`, then assign aliases with `agent-cli models suggest --apply`.";

/** The remedy when a catalog IS imported and the aliases simply are not assigned
 *  from it yet. Telling that user to fetch a catalog they already have sends
 *  them down a step that changes nothing. */
export const CATALOG_READY_HINT =
	"A live catalog is imported but no alias is assigned from it yet - run `agent-cli models suggest --apply` to pick from it, or `agent-cli models research --fetch` to refresh the catalog first.";

/** The right remedy for the CURRENT state. Every surface that reports "no
 *  aliases" or "nothing applied" should call this rather than reaching for a
 *  fixed string, because those two outcomes have two different causes. */
export function catalogHint() {
	return hasCatalog() ? CATALOG_READY_HINT : NO_CATALOG_HINT;
}

/** True when a live catalog has been imported and yields at least one usable
 *  candidate. Callers use this to distinguish "nothing matched this category"
 *  from "there is no catalog at all", which need different messages. */
export function hasCatalog() {
	return Object.keys(livePicks()).length > 0;
}

/** Pick the best candidate for an alias category from the imported live
 *  catalog, preferring providers the user already uses (config.json
 *  `providers`). Returns null when no catalog has been imported or when the
 *  category has no candidate - both are expected states, not failures, and the
 *  caller is responsible for printing NO_CATALOG_HINT. */
export function pickForCategory(category, { preferredProviders } = {}) {
	const matches = livePicks()[category];
	if (!matches?.length) return null;
	return [...matches].sort((a, b) => {
		const ap = preferredProviders?.includes(a.provider) ? 0 : 1;
		const bp = preferredProviders?.includes(b.provider) ? 0 : 1;
		return ap - bp;
	})[0];
}

/** Map a live OpenRouter model id to an agent-cli category using keywords.
 *  Returns null when the id gives no strong signal. */
function categoryFromId(id) {
	const s = String(id || "").toLowerCase();
	if (/(vision|image)/.test(s)) return "vision";
	if (/(coder|code|swe)/.test(s)) return "coding";
	if (/(reason|think|o3\b|o4\b|r1\b|deepsearch)/.test(s)) return "deepsearch";
	if (/(mini|flash-lite|nano|small|lite\b|pico)/.test(s)) return "fast";
	if (/(max|pro\b|opus|large|ultra|turbo)/.test(s)) return "smart";
	// A bare vendor family name with no size qualifier (a provider slug plus
	// an unqualified family) carries no other signal, so treat it as smart.
	const last = s.split("/").pop() || s;
	if (/^(gpt|claude|gemini|qwen|deepseek|mistral|llama)[a-z0-9.-]*$/.test(last))
		return "smart";
	return null;
}

/**
 * Merge a freshly fetched "Live model catalog" Markdown section into the
 * existing MODELS.md content: replaces the section in place when one is
 * already present, else appends it. Pure string transform — the caller does
 * the actual file write. Used by `agent-cli models research --fetch`.
 */
export function mergeLiveCatalogSection(existing, liveSection) {
	if (/##\s+Live model catalog/.test(existing)) {
		return existing.replace(
			/## Live model catalog[\s\S]*?(?=\n## |$)/,
			liveSection.trimEnd(),
		);
	}
	return existing.trimEnd() + "\n\n" + liveSection.trimEnd() + "\n";
}

/**
 * Build `models suggest` rows: one candidate row per alias that needs
 * (re)assignment, with an auto-picked model (when the catalog has a match
 * for its category) and a human-readable guidance string. Pure computation
 * over already-loaded state (config-backed alias reads only) — never writes.
 *
 * @param {Array} unresolved - findUnresolvedModels() output; ignored when
 *   `reassign` is true (every existing alias is considered instead).
 * @param {object} [opts]
 * @param {boolean} [opts.reassign] - consider every existing alias, not just
 *   unresolved ones, so a live-catalog refresh can upgrade stale picks.
 * @param {string[]} [opts.preferredProviders] - providers to rank first.
 * @returns {{ rows: object[], shared: string[] }}
 */
export function buildModelSuggestions(
	unresolved,
	{ reassign = false, preferredProviders = [] } = {},
) {
	const byAlias = new Map();
	if (reassign) {
		for (const [alias, v] of Object.entries(getAliases())) {
			byAlias.set(alias, [
				{ name: alias, model: alias, scope: "global", existing: v.model },
			]);
		}
	} else {
		for (const u of unresolved) {
			const arr = byAlias.get(u.model) || [];
			arr.push(u);
			byAlias.set(u.model, arr);
		}
	}
	const rows = [];
	const shared = [];
	for (const [alias, personas] of byAlias) {
		// Derive a category from the alias name (strip "-model" suffix)
		// or fall back to the persona's configured category.
		const hint = String(alias).replace(/-model$/, "").toLowerCase();
		let category = CATEGORIES.includes(hint) ? hint : null;
		if (!category) {
			for (const p of personas) {
				const cfgForPersona = getAlias(p.name);
				if (cfgForPersona?.category) {
					category = cfgForPersona.category;
					break;
				}
			}
		}
		const picked = category
			? pickForCategory(category, { preferredProviders })
			: null;
		// Personas whose alias name doesn't match a category get a category
		// hint from the alias shape ("review-model" → try to infer review
		// or smart category by walking the alias name). If still no match,
		// fall back to "smart" so at least one model is auto-pickable.
		const fallbackCategory = category ? null : "smart";
		const finalPick =
			picked ||
			(fallbackCategory
				? pickForCategory(fallbackCategory, { preferredProviders })
				: null);
		const existing = personas[0]?.existing || getAlias(alias)?.model || null;
		const row = {
			alias,
			category: category || fallbackCategory,
			existing,
			pick: finalPick
				? {
						id: finalPick.id,
						provider: finalPick.provider,
						thinking: finalPick.thinking,
						notes: finalPick.notes,
					}
				: null,
			personas: personas.map((p) => ({ name: p.name, scope: p.scope })),
		};
		const fullId =
			finalPick && finalPick.id.includes("/")
				? finalPick.id
				: finalPick && `${finalPick.provider}/${finalPick.id}`;
		row.guidance = finalPick
			? `agent-cli models set ${alias} ${fullId}${finalPick.thinking ? " --thinking on" : ""}  (applies to ${personas.length} persona${personas.length === 1 ? "" : "s"})`
			: `agent-cli models set ${alias} <provider/model>  (${personas.length} persona${personas.length === 1 ? "" : "s"} share this alias)`;
		rows.push(row);
		if (personas.length > 1) shared.push(alias);
	}
	return { rows, shared };
}

/**
 * Decide which `models suggest` rows to write and which to skip (writes are
 * the caller's job — this is the pure applied/unchanged/writes split behind
 * `models suggest --apply`).
 */
export function planModelSuggestionApply(rows, { reassign = false } = {}) {
	const applied = [];
	const unchanged = [];
	const writes = [];
	for (const r of rows) {
		if (!r.pick) continue;
		const next = r.pick.id.includes("/")
			? r.pick.id
			: `${r.pick.provider}/${r.pick.id}`;
		if (reassign && r.existing === next) {
			unchanged.push({ alias: r.alias, model: next });
			continue;
		}
		writes.push({
			alias: r.alias,
			model: next,
			category: r.category,
			thinking: r.pick.thinking ? "on" : undefined,
		});
		applied.push({
			alias: r.alias,
			model: next,
			personas: r.personas.map((p) => p.name),
		});
	}
	return { applied, unchanged, writes };
}

/** Read the persisted live catalog (from `models research --fetch`). */
export function livePicks() {
	let cfg;
	try {
		cfg = readConfig();
	} catch {
		return {};
	}
	const live = cfg.models?.liveCatalog;
	if (!live || !Array.isArray(live.entries)) return {};
	const byCategory = {};
	for (const e of live.entries) {
		const cat = categoryFromId(e.id);
		if (!cat) continue;
		(byCategory[cat] ||= []).push({
			id: e.id,
			provider: e.provider,
			category: cat,
			thinking: /(reason|think|o3|o4|r1\b)/.test(String(e.id).toLowerCase()),
			notes: `${e.context ? e.context.toLocaleString() + " ctx" : ""} · $${e.inputPer1M ?? 0}/M in · $${e.outputPer1M ?? 0}/M out`,
		});
	}
	return byCategory;
}

/** Persist a fetched live catalog into config.json (models.liveCatalog). */
export function saveLiveCatalog(result) {
	const cfg = readConfig();
	cfg.models = cfg.models || {};
	cfg.models.liveCatalog = {
		source: result.source,
		fetchedAt: result.fetchedAt,
		count: result.count,
		entries: result.entries,
	};
	saveConfigSync(cfg);
	return cfg.models.liveCatalog;
}

/**
 * Staleness of the persisted live catalog, in days. Returns null when it has
 * never been fetched, else a non-negative number. Used by the brief to
 * suggest `agent-cli models research --fetch` when the data is old.
 */
export function liveCatalogAgeDays() {
	let cfg;
	try {
		cfg = readConfig();
	} catch {
		return null;
	}
	const fetchedAt = cfg.models?.liveCatalog?.fetchedAt;
	if (!fetchedAt) return null;
	const ms = Date.now() - new Date(fetchedAt).getTime();
	return Math.max(0, Math.floor(ms / 86_400_000));
}

// --- Live catalog fetch -----------------------------------------------------
// `agent-cli models research --fetch` pulls a real, no-auth model list from a
// public endpoint and writes it into MODELS.md so the agent has current
// provider/model data. Reports the failure and leaves the stored
// catalog untouched when offline.

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
		"> Auto-refresh: `agent-cli models research --fetch`. Pricing is USD per 1M tokens.",
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
