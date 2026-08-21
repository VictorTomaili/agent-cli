import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

// Native skill fetch — replaces the external `skills` npm package (HIGH-1:
// the old path shelled out to `npx -y skills@<pinned>`; skills are now
// integrated into this lib, so the dependency is gone entirely).
//
// A `source` is one of:
//   owner/repo            → github.com/owner/repo
//   owner/repo@skill      → github.com/owner/repo, only the `skill` subdir
//   https://host/…(git)   → any git URL (github, gitlab, self-hosted)
//   git@host:owner/repo   → SSH git URL
//   ./local/path          → local dir containing skill dirs
//   npm-package-name      → an npm package exposing skills (npm registry tarball)
//
// Fetch lands in a TEMP dir as `<tmp>/.claude/skills/<skill>/…` — the same
// layout the old npx path produced, so install/update code is unchanged. The
// caller owns the returned `tmp` and MUST rmSync it in a finally.
//
// Security: git clone runs with shell:false + args array (no shell injection);
// Windows metacharacter rejection (M2) carries over; the caller's
// copySkillIntoStore (M1) and bounded reads (M5) apply after fetch.

/** Detect a `@skill` pin on the source (owner/repo@skill or URL@skill). SSH git
 *  URLs (`git@host:owner/repo`) start with git@ and are NOT a pin. */
export function skillPin(source) {
	if (typeof source !== 'string') return null
	if (source.startsWith('git@')) return null
	const at = source.lastIndexOf('@')
	if (at <= 0) return null
	const skill = source.slice(at + 1)
	if (!skill || skill.includes('/') || skill.includes(':')) return null
	return skill
}

/** Pure classifier: which fetch strategy applies to this source. */
export function classifySource(source) {
	const s = String(source ?? '').trim()
	if (!s) return { kind: 'invalid' }
	if (s.startsWith('git@')) return { kind: 'git', url: s }
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
		// URL with scheme — git (http/https/ssh/file) or npm registry
		return /^https?:\/\//.test(s) ? { kind: 'git', url: s } : { kind: 'invalid' }
	}
	if (s.includes('/') && !s.startsWith('.')) {
		// owner/repo → GitHub shorthand (strip an @skill pin first)
		const base = skillPin(s) ? s.slice(0, s.lastIndexOf('@')) : s
		const parts = base.split('/')
		if (parts.length === 2 && parts[0] && parts[1]) {
			return { kind: 'github', owner: parts[0], repo: parts[1] }
		}
		// path-like with a slash but not ./ — a local relative path
		return fs.existsSync(s) ? { kind: 'local', dir: path.resolve(s) } : { kind: 'invalid' }
	}
	// no slash, no scheme: local file/dir or npm package name
	if (fs.existsSync(s)) return { kind: 'local', dir: path.resolve(s) }
	if (/^[a-z0-9][a-z0-9._-]*$/.test(s)) return { kind: 'npm', name: s }
	return { kind: 'invalid' }
}

/** GitHub shorthand → clone URL (https; no auth needed for public repos). */
function githubUrl(owner, repo) {
	return `https://github.com/${owner}/${repo}.git`
}

function hasGit() {
	try {
		execFileSync('git', ['--version'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

/** Shallow-clone a git source into `dest`. Throws on failure with a tail of stderr. */
function gitClone(url, dest, timeoutMs = 120000) {
	if (!hasGit()) throw new Error('git not found on PATH — needed to fetch skills from git sources')
	try {
		execFileSync('git', ['clone', '--depth', '1', '--quiet', url, dest], {
			stdio: ['ignore', 'pipe', 'pipe'],
			encoding: 'utf8',
			timeout: timeoutMs,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		})
	} catch (e) {
		const tail = ((e.stderr || e.stdout) || '').toString().trim().split('\n').pop()
		const timedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT'
		throw new Error(timedOut ? 'git clone timed out' : `git clone failed: ${tail || e.message}`)
	}
}

/** Download + extract an npm package's tarball via `npm pack`. */
function npmFetch(name, dest, timeoutMs = 120000) {
	const cwd = path.join(dest, '_npm')
	fs.mkdirSync(cwd, { recursive: true })
	try {
		execFileSync('npm', ['pack', name, '--silent', '--pack-destination', cwd], {
			stdio: ['ignore', 'pipe', 'pipe'],
			encoding: 'utf8',
			cwd,
			timeout: timeoutMs,
		})
	} catch (e) {
		const tail = ((e.stderr || e.stdout) || '').toString().trim().split('\n').pop()
		throw new Error(`npm pack failed for '${name}': ${tail || e.message}`)
	}
	const tgz = fs.readdirSync(cwd).find((f) => f.endsWith('.tgz'))
	if (!tgz) throw new Error(`npm pack produced no tarball for '${name}'`)
	fs.mkdirSync(path.join(cwd, 'pkg'), { recursive: true })
	execFileSync('tar', ['-xzf', path.join(cwd, tgz), '-C', path.join(cwd, 'pkg')], {
		stdio: 'ignore',
		encoding: 'utf8',
		cwd,
	})
	return path.join(cwd, 'pkg', 'package')
}

// Walk bounds — a hostile repo must not make discovery unbounded (M5-style).
const MAX_COLLECT_DEPTH = 5;
const MAX_COLLECT_ENTRIES = 20_000;
// Never descended into: VCS/tooling dirs that are huge or irrelevant.
const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * Recursively copy skill dirs — any directory DIRECTLY containing SKILL.md —
 * from `srcDir` into `outDir`. Finds skills at any depth: flat
 * (`<root>/<skill>/SKILL.md`), conventional (`<root>/skills/<skill>/`), and
 * nested-category layouts (`<root>/skills/<category>/<skill>/SKILL.md` —
 * e.g. mattpocock/skills). Rules:
 *   - a dir that directly contains SKILL.md is collected and NOT descended
 *     into (a nested SKILL.md inside a skill is not a separate skill)
 *   - symlinked dirs are never followed (M1 containment)
 *   - `.git` / `node_modules` are never entered
 *   - duplicate dir names: first wins, deterministically (entries sorted)
 *   - `only` pins the collected dir's basename, at any depth
 * Exported for direct testing.
 */
export function collectSkills(srcDir, outDir, { only } = {}) {
	fs.mkdirSync(outDir, { recursive: true });
	const seen = new Set();
	let visited = 0;
	const walk = (dir, depth) => {
		let found = 0;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return 0; // unreadable/vanished mid-walk — treated as empty
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const e of entries) {
			if (++visited > MAX_COLLECT_ENTRIES) return found;
			if (!e.isDirectory() || e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue;
			const child = path.join(dir, e.name);
			if (fs.existsSync(path.join(child, "SKILL.md"))) {
				if (only && e.name !== only) continue;
				if (seen.has(e.name)) continue;
				seen.add(e.name);
				fs.cpSync(child, path.join(outDir, e.name), { recursive: true });
				found++;
			} else if (depth < MAX_COLLECT_DEPTH) {
				found += walk(child, depth + 1);
			}
		}
		return found;
	};
	return walk(srcDir, 0);
}

// B5/M2: the source reaches no shell here (execFileSync with args array), but a
// hostile source with cmd metacharacters is still nonsense — reject loudly.
function windowsShellMetachars(safe) {
	return /[&|<>^%!"']/.exec(safe)
}

/**
 * Fetch skill(s) from `source` into a TEMP cwd. Returns { tmp, fetchedDir } where
 * fetchedDir = `<tmp>/.claude/skills/`. Throws on any failure (caller cleans tmp).
 */
export function fetchSkillsToTemp(source) {
	const fixture = process.env.SKILL_CLI_FETCH_FIXTURE
	if (fixture) return fetchFromFixture(fixture)

	const safe = String(source ?? '').trim()
	if (!safe) throw new Error('empty source')
	if (/[\r\n]/.test(safe)) throw new Error('source must be a single line')
	if (process.platform === 'win32' && windowsShellMetachars(safe)) {
		throw new Error(
			"source contains Windows shell metacharacters (& | < > ^ % ! \" ') — use a path/URL without them",
		)
	}

	const cls = classifySource(safe)
	if (cls.kind === 'invalid') {
		throw new Error(`cannot fetch source '${safe}' — expected owner/repo, a git URL, a local dir, or an npm package`)
	}

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-cli-'))
	const pin = skillPin(safe)

	try {
		let skillsRoot
		if (cls.kind === 'github') {
			skillsRoot = path.join(tmp, 'repo')
			gitClone(githubUrl(cls.owner, cls.repo), skillsRoot)
		} else if (cls.kind === 'git') {
			const url = pin ? safe.slice(0, safe.lastIndexOf('@')) : cls.url
			skillsRoot = path.join(tmp, 'repo')
			gitClone(url, skillsRoot)
		} else if (cls.kind === 'npm') {
			skillsRoot = npmFetch(cls.name, tmp)
		} else if (cls.kind === 'local') {
			skillsRoot = cls.dir
		}

		const fetchedDir = path.join(tmp, ".claude", "skills");
		// Recursive discovery from the source root — finds flat, ./skills/, and
		// nested-category layouts (skills/<category>/<skill>/SKILL.md) alike.
		let found = collectSkills(skillsRoot, fetchedDir, { only: pin || undefined });
		if (found === 0 && fs.existsSync(path.join(skillsRoot, "SKILL.md"))) {
			// the source IS a single skill dir (SKILL.md at its root) — copy it whole
			const name = pin || path.basename(skillsRoot);
			fs.mkdirSync(fetchedDir, { recursive: true });
			fs.cpSync(skillsRoot, path.join(fetchedDir, name), { recursive: true });
			found = 1;
		}
		if (found === 0) {
			throw new Error(
				`no skills found in source${pin ? ` matching '${pin}'` : ""} after fetch`,
			);
		}
		return { tmp, fetchedDir }
	} catch (e) {
		fs.rmSync(tmp, { recursive: true, force: true })
		throw e
	}
}

// Fixture-backed fetch (test seam). The fixture is a dir of skill dirs — the same
// layout a real fetch produces under .claude/skills/. No network.
function fetchFromFixture(fixture) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-cli-'))
	const fetchedDir = path.join(tmp, '.claude', 'skills')
	fs.mkdirSync(fetchedDir, { recursive: true })
	if (fs.existsSync(fixture)) {
		for (const entry of fs.readdirSync(fixture, { withFileTypes: true })) {
			if (entry.isDirectory()) fs.cpSync(path.join(fixture, entry.name), path.join(fetchedDir, entry.name), { recursive: true })
		}
	}
	return { tmp, fetchedDir }
}
