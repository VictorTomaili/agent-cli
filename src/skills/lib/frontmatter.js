import yaml from 'yaml'

// SKILL.md = YAML frontmatter + markdown body. Faithful to the npx skills standard.

/** Longest parse-error string we surface (YAML errors embed source snippets). */
const MAX_PARSE_ERROR_CHARS = 200

function boundParseError(e) {
	const msg = String((e && e.message) || e || 'malformed YAML frontmatter')
	return msg.length > MAX_PARSE_ERROR_CHARS
		? msg.slice(0, MAX_PARSE_ERROR_CHARS) + '…'
		: msg
}

function isPlainObject(v) {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
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
	if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
	if (!m) return { data: {}, body: content, parseError: null }
	let data = {}
	let parseError = null
	try {
		data = yaml.parse(m[1]) || {}
	} catch (e) {
		parseError = boundParseError(e)
	}
	if (!isPlainObject(data)) {
		parseError = parseError || 'frontmatter is not a YAML mapping (expected key: value lines)'
		data = {}
	}
	return { data, body: m[2] || '', parseError }
}

/**
 * GAP-6: frontmatter values are untrusted. Only a real non-empty string may
 * surface as name/description/version — a number `name` would crash padEnd/
 * localeCompare later, an object `description` would render "[object Object]".
 * Anything else falls back to the caller's default (reject, don't guess).
 */
export function stringField(v, fallback = '') {
	return typeof v === 'string' && v.trim() !== '' ? v : fallback
}

// "/Research", "Research", "research" → "research". Trim BEFORE stripping the
// leading slash, so comma-split entries like " /code" also normalize.
export function normalizeTrigger(t) {
	return String(t).trim().replace(/^\/+/, '').toLowerCase()
}

// frontmatter.triggers → normalized array
export function getTriggers(data) {
	const t = data.triggers
	if (Array.isArray(t)) return t.map(normalizeTrigger).filter(Boolean)
	if (typeof t === 'string') return t.split(',').map(normalizeTrigger).filter(Boolean)
	return []
}
