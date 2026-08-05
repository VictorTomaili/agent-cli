import c from 'picocolors'
import { readGlobalConfig, writeGlobalConfig, readProjectConfig, writeProjectConfig } from '../lib/config.js'

export function cmdDisable(args) {
	const global = args.includes('-g') || args.includes('--global')
	const name = args.find(a => !a.startsWith('-'))
	if (!name) { console.error(c.red('Usage: skill disable <name> [-g]')); process.exit(1) }

	if (global) {
		const cfg = readGlobalConfig()
		const had = (cfg.defaults || []).some(a => a.toLowerCase() === name.toLowerCase())
		cfg.defaults = (cfg.defaults || []).filter(a => a.toLowerCase() !== name.toLowerCase())
		writeGlobalConfig(cfg)
		console.log(had
			? (c.green('✓') + ' removed global default: ' + c.bold(name))
			: (c.gray('·') + ' not a global default: ' + c.bold(name) + c.gray(' (nothing to do)')))
	} else {
		const cwd = process.cwd()
		const cfg = readProjectConfig(cwd) || { inherit: true, deny: [], allow: [] }
		const hadAllow = (cfg.allow || []).some(a => a.toLowerCase() === name.toLowerCase())
		const hadDeny = (cfg.deny || []).some(a => a.toLowerCase() === name.toLowerCase())
		cfg.allow = (cfg.allow || []).filter(a => a.toLowerCase() !== name.toLowerCase())
		// B11: also add it to deny — removing it from `allow` alone isn't enough: a
		// globally defaulted skill stays active in the project via inheritance, so
		// `computeEffective` must see the deny entry to actually turn it off.
		if (!hadDeny) cfg.deny = [...(cfg.deny || []), name]
		writeProjectConfig(cwd, cfg)
		const changed = hadAllow || !hadDeny
		console.log(changed
			? (c.green('✓') + ' disabled in project: ' + c.bold(name))
			: (c.gray('·') + ' not enabled in project: ' + c.bold(name) + c.gray(' (nothing to do)')))
	}
}
