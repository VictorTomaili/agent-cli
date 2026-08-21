import c from 'picocolors'
import { readSkill } from '../lib/store.js'
import {
	getTriggers,
	getVersion,
	getLicense,
	getCompatibility,
	getAllowedTools,
	getMetadata,
	stringField,
} from '../lib/frontmatter.js'
import { trunc } from '../lib/format.js'

export function cmdShow(args) {
	const name = args[0]
	if (!name) { console.error(c.red('Usage: skill show <name>')); process.exit(1) }
	const s = readSkill(name)
	if (!s) { console.error(c.red('Skill not found: ' + name)); process.exit(1) }

	// GAP-15: surface a YAML parse error instead of silently showing empty fields.
	if (s.parseError) console.log(c.red('frontmatter parse error: ' + s.parseError))
	const desc = stringField(s.data.description)
	console.log(c.bold(s.name) + c.gray('  v' + (getVersion(s.data) || '-')))
	if (desc) console.log(c.gray(desc))
	console.log()
	console.log(c.gray('path:     ') + s.path)
	const trg = getTriggers(s.data).map(t => '/' + t).join(', ') || '—'
	console.log(c.gray('triggers: ') + trg)
	// Agent Skills spec fields (agentskills.io), when present.
	const lic = getLicense(s.data)
	if (lic) console.log(c.gray('license:  ') + lic)
	const comp = getCompatibility(s.data)
	if (comp) console.log(c.gray('compat:   ') + trunc(comp, 64))
	const tools = getAllowedTools(s.data)
	if (tools) console.log(c.gray('tools:    ') + tools)
	const md = getMetadata(s.data)
	if (md && Object.keys(md).length) {
		console.log(c.gray('metadata: ') + trunc(JSON.stringify(md), 80))
	}
	console.log(c.gray('content:  ') + c.cyan('skill cat ' + s.name))
}
