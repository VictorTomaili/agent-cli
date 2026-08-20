import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'
import { CLI_ROOT, GLOBAL_CONFIG, PROJECT_CONFIG, STORE_DIR } from './paths.js'

const DEFAULT_GLOBAL = {
	version: 1,
	store: STORE_DIR,
	defaults: [],
}

const GLOBAL_CORRUPT = Symbol('skillGlobalConfigCorrupt')
const PROJECT_CORRUPT = Symbol('skillProjectConfigCorrupt')

function isStringArray(v) {
	return Array.isArray(v) && v.every((x) => typeof x === 'string')
}
function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function corruptGlobal() {
	const cfg = { ...DEFAULT_GLOBAL }
	Object.defineProperty(cfg, GLOBAL_CORRUPT, { value: true })
	return cfg
}

function corruptProject() {
	const cfg = { inherit: true, deny: [], allow: [] }
	Object.defineProperty(cfg, PROJECT_CORRUPT, { value: true })
	return cfg
}

export function isGlobalConfigCorrupt(cfg) {
	return cfg?.[GLOBAL_CORRUPT] === true
}

export function isProjectConfigCorrupt(cfg) {
	return cfg?.[PROJECT_CORRUPT] === true
}

// Schema check for the global config.yaml: `defaults` must be a string array,
// `store` must be a string, and legacy lists must be string arrays. Wrong shapes
// are classified as corrupt rather than reaching code that assumes arrays.
function globalShapeValid(p) {
	if (p.defaults !== undefined && !isStringArray(p.defaults)) return false
	if (p.store !== undefined && typeof p.store !== 'string') return false
	if (p.enabled_global !== undefined && !isStringArray(p.enabled_global)) return false
	if (p.defaults_global !== undefined && !isStringArray(p.defaults_global)) return false
	return true
}

// Schema check for skill.config: `allow`/`deny` must be string arrays and
// `inherit` must be a boolean.
function projectShapeValid(p) {
	if (p.inherit !== undefined && typeof p.inherit !== 'boolean') return false
	if (p.allow !== undefined && !isStringArray(p.allow)) return false
	if (p.deny !== undefined && !isStringArray(p.deny)) return false
	return true
}

export function readGlobalConfig() {
	let raw
	try { raw = fs.readFileSync(GLOBAL_CONFIG, 'utf8') } catch { return { ...DEFAULT_GLOBAL } }
	let parsed
	try { parsed = yaml.parse(raw) } catch (e) {
		process.stderr.write('skill-cli config: parse error (' + (e.message || e) + ') — using defaults\n')
		return corruptGlobal()
	}
	if (parsed === null || parsed === undefined) parsed = {}
	if (!isPlainObject(parsed) || !globalShapeValid(parsed)) return corruptGlobal()
	const merged = { ...DEFAULT_GLOBAL, ...parsed }
	// backward-compat: legacy configs split the active-by-default set
	// (`enabled_global`) from the auto-load set (`defaults_global`). The unified
	// model collapses them into one `defaults` list (a default skill is now BOTH
	// active-by-default AND auto-loaded). On read, adopt the union of both legacy
	// lists when no new-format `defaults` is present; `defaults` always wins.
	if (!Array.isArray(merged.defaults) || merged.defaults.length === 0) {
		const legacy = [
			...(Array.isArray(parsed?.enabled_global) ? parsed.enabled_global : []),
			...(Array.isArray(parsed?.defaults_global) ? parsed.defaults_global : []),
		]
		if (legacy.length) merged.defaults = [...new Set(legacy.map(String))]
	}
	return merged
}

export function writeGlobalConfig(cfg) {
	if (isGlobalConfigCorrupt(cfg)) throw new Error('skill-cli config.yaml is corrupt; repair or remove it before changing settings')
	fs.mkdirSync(CLI_ROOT, { recursive: true })
	// write only the known schema, not arbitrary pass-through keys. readGlobalConfig
	// merges parsed-over-defaults, which would otherwise round-trip dead keys (e.g.
	// the removed `default_agents`) back into the file forever.
	const out = {
		version: cfg.version ?? 1,
		store: typeof cfg.store === 'string' ? cfg.store : STORE_DIR,
		defaults: Array.isArray(cfg.defaults) ? cfg.defaults : [],
	}
	fs.writeFileSync(GLOBAL_CONFIG, yaml.stringify(out), 'utf8')
}

export function projectConfigPath(cwd = process.cwd()) {
	return path.join(cwd, PROJECT_CONFIG)
}

// Returns null when no project config exists. A malformed YAML or a
// schema-invalid shape is reported on stderr and returned as a corrupt marker
// (rather than silently falling back to global behavior or being overwritten).
export function readProjectConfig(cwd = process.cwd()) {
	let raw
	try { raw = fs.readFileSync(projectConfigPath(cwd), 'utf8') } catch { return null }
	let parsed
	try { parsed = yaml.parse(raw) } catch (e) {
		process.stderr.write('skill.config: parse error (' + (e.message || e) + ') — using global behavior\n')
		return corruptProject()
	}
	if (parsed === null || parsed === undefined) parsed = {}
	if (!isPlainObject(parsed) || !projectShapeValid(parsed)) return corruptProject()
	return { inherit: true, deny: [], allow: [], ...parsed }
}

export function writeProjectConfig(cwd, cfg) {
	if (isProjectConfigCorrupt(cfg)) throw new Error('skill.config is corrupt; repair or remove it before changing settings')
	// normalize to the known schema on write (drops stale/junk keys).
	const out = {
		inherit: cfg.inherit !== false,
		deny: Array.isArray(cfg.deny) ? cfg.deny : [],
		allow: Array.isArray(cfg.allow) ? cfg.allow : [],
	}
	fs.writeFileSync(projectConfigPath(cwd), yaml.stringify(out), 'utf8')
}

// Simple glob: * → any chars, ? → single char. Pattern length is capped to guard
// against ReDoS on user-supplied deny patterns.
function globMatch(pattern, name) {
	if (pattern === '*') return true
	if (pattern.length > 200) return false
	const re = new RegExp(
		'^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
		'i'
	)
	return re.test(name)
}

// Effective skills, returned as CANONICAL names (from the installed store). allow
// always wins over deny, so `deny: ["*"]` + `allow: [X]` = "only X". Matching is
// case-insensitive throughout — the user may type "React-BP" while the skill is "react-bp".
export function computeEffective(installed, globalCfg, projCfg) {
	const canonByLower = new Map(installed.map(s => [String(s.name).toLowerCase(), s.name]))
	const enabled = new Set(
		(projCfg && projCfg.inherit === false ? [] : (globalCfg.defaults || []))
			.map(s => String(s).toLowerCase())
	)
	if (projCfg) {
		const allowLower = new Set((projCfg.allow || []).map(a => String(a).toLowerCase()))
		for (const d of (projCfg.deny || [])) {
			for (const name of [...enabled]) {
				if (allowLower.has(name)) continue
				if (d.includes('*') ? globMatch(d, name) : String(d).toLowerCase() === name) {
					enabled.delete(name)
				}
			}
		}
		for (const a of (projCfg.allow || [])) enabled.add(String(a).toLowerCase())
	}
	return [...enabled]
		.filter(n => canonByLower.has(n))
		.map(n => canonByLower.get(n))
		.sort()
}

// Effective DEFAULT skills (auto-loaded on agent-cli session start), as CANONICAL
// names. In the unified model the default list IS the globally-active-by-default
// set (one `defaults` key in config.yaml): a default skill is active in every
// project AND auto-loaded on start. So this just returns that list filtered to
// installed skills. Defaults are GLOBAL (never per-folder) and ignore a
// project's deny rules (deny only governs active state, not auto-load).
export function computeDefaults(installed, globalCfg) {
	const canonByLower = new Map(installed.map(s => [String(s.name).toLowerCase(), s.name]))
	return [...new Set((globalCfg.defaults || []).map(s => String(s).toLowerCase()))]
		.filter(n => canonByLower.has(n))
		.map(n => canonByLower.get(n))
		.sort()
}
