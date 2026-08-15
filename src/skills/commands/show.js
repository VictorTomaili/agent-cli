import c from 'picocolors'
import { readSkill } from '../lib/store.js'
import { getTriggers, stringField } from '../lib/frontmatter.js'

export function cmdShow(args) {
	const name = args[0]
	if (!name) { console.error(c.red('Usage: skill show <name>')); process.exit(1) }
	const s = readSkill(name)
	if (!s) { console.error(c.red('Skill not found: ' + name)); process.exit(1) }

	// GAP-15: surface a YAML parse error instead of silently showing empty fields.
	if (s.parseError) console.log(c.red('frontmatter parse error: ' + s.parseError))
	const desc = stringField(s.data.description)
	console.log(c.bold(s.name) + c.gray('  v' + stringField(s.data.version, '-')))
	if (desc) console.log(c.gray(desc))
	console.log()
	console.log(c.gray('path:     ') + s.path)
	const trg = getTriggers(s.data).map(t => '/' + t).join(', ') || '—'
	console.log(c.gray('triggers: ') + trg)
	console.log(c.gray('content:  ') + c.cyan('skill cat ' + s.name))
}
