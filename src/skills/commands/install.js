import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import c from 'picocolors'
import { STORE_DIR } from '../lib/paths.js'
import { parseSkillMd } from '../lib/frontmatter.js'
import { fetchSkillsToTemp } from '../lib/npx.js'
import { sanitizeSkillName, guardStoreBase, copySkillIntoStore, readSkillMdBounded } from '../lib/store.js'
import { writeLock } from './lock.js'
import { cmdEnable } from './enable.js'

// Local paths are resolved to absolute BEFORE switching to the temp cwd, so
// npx skills looks them up relative to the user's cwd, not the temp dir.
function resolveSource(source) {
	if (/:\/\//.test(source) || source.startsWith('git@')) return source
	if (fs.existsSync(source)) return path.resolve(source)
	return source
}

// Fetch skill(s) from `source` into the store. Throws on failure (does NOT
// process.exit) so callers — the `install` command AND the `search` TUI loop —
// can decide how to handle errors. Returns the list of moved skill names.
export function installSource(source) {
	const resolved = resolveSource(source)
	console.log(c.cyan('Fetching: ') + resolved)
	console.log(c.gray('  via npx skills add (temp cwd; agent folders untouched)'))

	let tmp, fetchedDir
	try {
		({ tmp, fetchedDir } = fetchSkillsToTemp(resolved))
	} catch (e) {
		throw new Error(e.message)
	}

	try {
		const baseUnsafe = guardStoreBase()
		if (baseUnsafe) throw baseUnsafe
		fs.mkdirSync(STORE_DIR, { recursive: true })
		const moved = []
		const skipped = []
		for (const entry of fs.readdirSync(fetchedDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			const srcSkillDir = path.join(fetchedDir, entry.name)
			const mdPath = path.join(srcSkillDir, 'SKILL.md')
			let raw = entry.name
			if (fs.existsSync(mdPath)) {
				const rawMd = readSkillMdBounded(mdPath)
				if (rawMd != null) {
					try {
						const { data } = parseSkillMd(rawMd)
						if (data.name) raw = data.name
					} catch { /* fall back to dir name */ }
				}
			}
			// S1 (path traversal): the dest name is untrusted — it comes from the
			// fetched SKILL.md frontmatter or source dir name. `name: ../x` could
			// otherwise write (and the preceding rmSync could delete) outside STORE_DIR.
			// Prefer the frontmatter name when safe; else the dir name; else skip.
			const name = sanitizeSkillName(raw) || sanitizeSkillName(entry.name)
			if (!name) { skipped.push(entry.name); continue }
			const dest = path.join(STORE_DIR, name)
			const reinstalled = fs.existsSync(dest)
			fs.rmSync(dest, { recursive: true, force: true })
			// cpSync (not renameSync): rename fails across volumes (EXDEV: C: temp → S: store).
			// M1: copySkillIntoStore refuses a symlinked dest and any fetched tree that
			// contains symlinks/junctions (they'd escape the store on later reads).
			const rejected = copySkillIntoStore(srcSkillDir, dest)
			if (rejected) {
				skipped.push(entry.name)
				console.log(c.yellow('  ⚠ skipped ') + c.bold(entry.name) + c.gray(' — ' + rejected))
				continue
			}
			// remember the source so `skill update` can re-fetch it later
			fs.writeFileSync(path.join(dest, '.source'), resolved + '\n')
			// provenance lock (source + SKILL.md content hash) — `skill lock` re-reads it
			writeLock(dest, resolved)
			moved.push({ name, reinstalled })
		}
		for (const s of skipped) console.log(c.yellow('  ⚠ skipped ') + c.bold(s) + c.gray(' (not a safe skill name)'))

		if (moved.length === 0) {
			// throw (not process.exit) so the finally cleans up the temp dir
			throw new Error('No skills moved to store.')
		}
		const fresh = moved.filter(m => !m.reinstalled).length
		const re = moved.length - fresh
		console.log(c.green(`✓ ${fresh} installed` + (re ? c.gray(` · ${re} reinstalled`) : '') + ' to store:'))
		for (const m of moved) {
			const mark = m.reinstalled ? c.yellow('↻') : c.green('•')
			const tail = m.reinstalled ? c.gray('  (reinstalled)') : c.gray('  → ' + path.join(STORE_DIR, m.name))
			console.log('  ' + mark + ' ' + c.bold(m.name) + tail)
		}
		console.log()
		console.log(c.gray('Skills are passive until enabled. Activate with: ') + c.cyan('skill enable <name>') + c.gray(' or ') + c.cyan('-g'))
		return moved
	} finally {
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
	}
}

// `skill install <source>` — non-interactive. The TTY/no-args route to the search
// TUI is handled in cli.js (avoids a circular import with search.js).
export function cmdInstall(args) {
	const source = args[0]
	if (!source) {
		console.error(c.red('Usage: skill install <source>'))
		console.error(c.gray('  source: owner/repo | owner/repo@skill | github/gitlab URL | git URL | local path | npm package'))
		console.error(c.gray('  (in a terminal with no source → interactive search: skill search)'))
		process.exit(1)
	}
	let moved
	try {
		moved = installSource(source)
	} catch (e) {
		console.error(c.red(e.message))
		console.error(c.gray('Check the source (owner/repo, URL, path, npm package).'))
		process.exit(1)
	}
	// Interactive installs (real terminal) offer to enable each freshly-installed
	// skill in this project — the fetch is passive, so a TTY user is almost always
	// about to run `skill enable` anyway. Skipped for non-TTY (agents/CI) and `-y`.
	const yes = args.includes('-y') || args.includes('--yes')
	if (!yes && process.stdin.isTTY && moved && moved.length) {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
		const names = moved.map(m => m.name)
		const list = names.join(', ')
		rl.question(c.cyan('Enable ') + c.bold(list) + c.cyan(' in this project now? [y/N] '), (ans) => {
			rl.close()
			const a = ans.trim().toLowerCase()
			if (a === 'y' || a === 'yes') {
				for (const n of names) {
					try { cmdEnable([n]) } catch { /* keep going */ }
				}
			} else {
				console.log(c.gray('  Skipped. Enable later with: ') + c.cyan('skill enable <name>'))
			}
		})
	}
}
