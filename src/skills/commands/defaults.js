import c from 'picocolors'
import { listStore } from '../lib/store.js'
import { readGlobalConfig, writeGlobalConfig, readProjectConfig, computeEffective, computeDefaults } from '../lib/config.js'
import { GATE_DECIDE_HINT } from '../lib/gate-policy.js'

// `skill active` (aliases: `status`) — the description-only
// catalog of ACTIVE skills in the current project (defaults + project allow,
// minus deny). The agent runs this at session start: it lists each active skill's
// name + FULL description (never the body), then the agent itself decides per
// skill — functional → `skill cat`, context-altering → propose. Detection of
// context-altering is the agent's judgment from the description (no flag, no fixed
// list), so it works for any skill, including ones installed later. The decision
// hint text is single-sourced in gate-policy.js.
export function cmdActive() {
	const installed = listStore()
	const globalCfg = readGlobalConfig()
	const projCfg = readProjectConfig()
	const eff = computeEffective(installed, globalCfg, projCfg)
	const defs = new Set((globalCfg.defaults || []).map(d => String(d).toLowerCase()))

	console.log(c.bold('skill active') + c.gray(' — active skills (descriptions only). LOAD correctness/quality ones; PROPOSE every cost/style/speed one (a trade-off is the USER') + c.gray("'s call — never skip it)."))
	console.log()

	if (eff.length === 0) {
		console.log(c.gray('  No active skills in this project.'))
		return
	}

	// CATALOG of ACTIVE skills only (not all installed): defaults + project allow,
	// minus deny. Print each one's name + FULL description (one line) + triggers —
	// never the body. The agent reads descriptions and itself decides per skill:
	// load (skill cat) if functional for the task, or PROPOSE if context-altering
	// (changes HOW the agent responds). Detection is the agent's judgment from the
	// description, so it works for any skill — including ones installed later —
	// with no hardcoded list or flag.
	for (const name of eff) {
		const s = installed.find(x => x.name === name)
		if (!s) continue
		const star = defs.has(s.name.toLowerCase()) ? c.yellow('★') + ' ' : '  '
		const trg = s.triggers.length ? '  ' + c.gray('/' + s.triggers.join(', /')) : ''
		console.log(`  ${star}${c.bold(s.name)}${trg}`)
		if (s.description) console.log(c.gray('      ' + String(s.description).replace(/[\r\n]+/g, ' ').trim()))
	}
	console.log()
	for (const line of GATE_DECIDE_HINT.split('\n')) {
		if (line.startsWith('  ⚠')) console.log(c.yellow(line))
		else if (line.startsWith('→')) console.log(c.bold(line))
		else console.log(c.gray(line))
	}
}

// `skill defaults` (plural, legacy alias of `default` management) — list the
// skills marked as global defaults. Distinct from `skill active` (which lists
// ACTIVE skills incl. project allow/deny): defaults are the auto-load + global
// active-by-default set.
export function cmdDefaults() {
	const installed = listStore()
	const globalCfg = readGlobalConfig()
	const names = computeDefaults(installed, globalCfg)

	console.log(c.bold('skill defaults') + c.gray(' — global defaults (active by default + auto-load in every project).'))
	console.log()
	if (!names.length) {
		console.log(c.gray('  No default skills. Mark one: ') + c.cyan('skill default <name>'))
		return
	}
	for (const name of names) {
		const s = installed.find(x => x.name === name)
		if (!s) continue
		const trg = s.triggers.length ? '  ' + c.gray('/' + s.triggers.join(', /')) : ''
		console.log('  ' + c.yellow('★') + ' ' + c.bold(s.name) + trg)
		if (s.description) console.log(c.gray('      ' + String(s.description).replace(/[\r\n]+/g, ' ').trim()))
	}
	console.log()
	console.log(c.gray('Remove: ') + c.cyan('skill undefault <name>'))
}

// `skill default <name>` — mark a skill as a default (active by default in every
// project + auto-loaded on session start). Always GLOBAL. Requires the skill to
// be installed (a typo would silently "succeed" but never resolve). `-g`/`--global`
// is accepted for compatibility but is a no-op — defaults are inherently global.
export function cmdDefault(args) {
	const name = args.find(a => !a.startsWith('-'))
	if (!name) {
		console.error(c.red('Usage: skill default <name>'))
		console.error(c.gray('  Marks a skill as a default: active by default in every project + auto-load on session start.'))
		process.exit(1)
	}
	if (!listStore().some(s => s.name.toLowerCase() === name.toLowerCase())) {
		console.error(c.red('Not installed: ' + name))
		console.error(c.gray('  Install first: skill install <source>'))
		process.exit(1)
	}
	const cfg = readGlobalConfig()
	if (!(cfg.defaults || []).some(d => d.toLowerCase() === name.toLowerCase())) {
		cfg.defaults.push(name.toLowerCase())
		cfg.defaults.sort()
	}
	writeGlobalConfig(cfg)
	console.log(c.green('✓') + ' default (global): ' + c.bold(name) + c.gray('  (active + auto-load in every project)'))
}

// `skill undefault <name>` — remove the default flag (always global).
export function cmdUndefault(args) {
	const name = args.find(a => !a.startsWith('-'))
	if (!name) {
		console.error(c.red('Usage: skill undefault <name>'))
		process.exit(1)
	}
	const cfg = readGlobalConfig()
	const had = (cfg.defaults || []).some(d => d.toLowerCase() === name.toLowerCase())
	cfg.defaults = (cfg.defaults || []).filter(d => d.toLowerCase() !== name.toLowerCase())
	writeGlobalConfig(cfg)
	console.log(had
		? (c.green('✓') + ' removed default: ' + c.bold(name))
		: (c.gray('·') + ' not a default: ' + c.bold(name) + c.gray(' (nothing to do)')))
}
