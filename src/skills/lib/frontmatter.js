import yaml from "yaml";

// SKILL.md = YAML frontmatter + markdown body. Faithful to the npx skills standard.

/** Longest parse-error string we surface (YAML errors embed source snippets). */
const MAX_PARSE_ERROR_CHARS = 200;

function boundParseError(e) {
	const msg = String((e && e.message) || e || "malformed YAML frontmatter");
	return msg.length > MAX_PARSE_ERROR_CHARS
		? msg.slice(0, MAX_PARSE_ERROR_CHARS) + "…"
		: msg;
}

function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse SKILL.md content. Returns { data, body, parseError }:
 *   - data: frontmatter mapping ({} when absent, malformed, or not a mapping —
 *     a `--- [1,2] ---` header parses to an array, which is not a mapping)
 *   - body: markdown after the closing `---`
 *   - parseError: null, or a bounded message when the YAML could not be parsed
 *     or was not a mapping. GAP-15: callers surface this instead of silently
 *     treating every field as missing.
 */
export function parseSkillMd(content) {
	// strip a leading UTF-8 BOM — Windows editors often save with one, and it would
	// break the `^---` frontmatter match (silently dropping name/triggers/version).
	if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { data: {}, body: content, parseError: null };
	let data = {};
	let parseError = null;
	try {
		data = yaml.parse(m[1]) || {};
	} catch (e) {
		parseError = boundParseError(e);
	}
	if (!isPlainObject(data)) {
		parseError =
			parseError ||
			"frontmatter is not a YAML mapping (expected key: value lines)";
		data = {};
	}
	return { data, body: m[2] || "", parseError };
}

/**
 * GAP-6: frontmatter values are untrusted. Only a real non-empty string may
 * surface as name/description/version — a number `name` would crash padEnd/
 * localeCompare later, an object `description` would render "[object Object]".
 * Anything else falls back to the caller's default (reject, don't guess).
 */
export function stringField(v, fallback = "") {
	return typeof v === "string" && v.trim() !== "" ? v : fallback;
}

// "/Research", "Research", "research" → "research". Trim BEFORE stripping the
// leading slash, so comma-split entries like " /code" also normalize.
export function normalizeTrigger(t) {
	return String(t).trim().replace(/^\/+/, "").toLowerCase();
}

// frontmatter.triggers → normalized array. Dual-location read: legacy
// top-level `triggers` (array or comma string) OR the spec-conformant
// `metadata.agent-cli.triggers` (comma string) — see SPEC_FIELDS below.
export function getTriggers(data) {
	const t = data.triggers;
	if (Array.isArray(t)) return t.map(normalizeTrigger).filter(Boolean);
	if (typeof t === "string")
		return t.split(",").map(normalizeTrigger).filter(Boolean);
	const m = metadataString(data, "triggers");
	if (m) return m.split(",").map(normalizeTrigger).filter(Boolean);
	return [];
}

// --- Agent Skills open standard (agentskills.io) ------------------------------
// The spec defines a CLOSED frontmatter allowlist: name, description, license,
// allowed-tools, metadata, compatibility. agent-cli's historical extensions
// (triggers, version) are NOT spec fields — for portability they live under
// `metadata` (the spec's extension escape hatch: a string→string map) as
// `agent-cli.triggers` / `agent-cli.version`. Everything is read dual-location
// (top-level legacy + metadata) so existing stores keep working while new
// skills mint spec-conformant frontmatter that passes skills-ref validate.

/** The six frontmatter fields the Agent Skills spec allows. */
export const SPEC_FIELDS = [
	"name",
	"description",
	"license",
	"allowed-tools",
	"metadata",
	"compatibility",
];

/** agent-cli extension fields — allowed, but warned as non-portable. */
export const AGENT_CLI_EXT_FIELDS = ["triggers", "version"];

/** Namespace prefix for agent-cli extensions inside `metadata`. */
export const EXT_NS = "agent-cli";

function metadataString(data, key) {
	const m = isPlainObject(data?.metadata) ? data.metadata : null;
	if (!m) return undefined;
	const v = m[`${EXT_NS}.${key}`];
	return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export function getLicense(data) {
	return stringField(data.license);
}

export function getCompatibility(data) {
	return stringField(data.compatibility);
}

/** Space-separated pre-approved tool list (spec, experimental). Inert here. */
export function getAllowedTools(data) {
	return stringField(data["allowed-tools"]);
}

/** The spec's extension map, when present and a mapping. */
export function getMetadata(data) {
	return isPlainObject(data?.metadata) ? data.metadata : null;
}

/** Dual-location version read: legacy top-level (string or finite number),
 * else metadata.agent-cli.version. '' when unset. */
export function getVersion(data) {
	const v = data?.version;
	if (typeof v === "string" && v.trim() !== "") return v;
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	return metadataString(data, "version") ?? "";
}
