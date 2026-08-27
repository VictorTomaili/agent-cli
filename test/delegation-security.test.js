// test/delegation-security.test.js — load-bearing regression tests for the two
// delegation-surface vulnerabilities closed in 06801b2:
//
//   SEC-1 (editor injection, `agents edit`): the agent's on-disk *.md path is
//     repo-controlled. It used to be concatenated into a `shell: true`
//     spawnSync command line together with the raw $VISUAL/$EDITOR string, so a
//     checked-out project-scope agent FILENAME carrying shell metacharacters
//     executed arbitrary commands. The path must now reach the editor as one
//     literal argv element, with no shell in between.
//
//   SEC-2 (import traversal, `agents import`): the write target used to be
//     path.join(projectAgentsDir, `${name}.md`) where `name` comes from the
//     UNTRUSTED imported file's own frontmatter (`^name:\s*(\S+)` happily
//     matches `..`, `/` and `\`). A crafted persona escaped the agents dir and
//     overwrote arbitrary .md files. The destination must now fold through
//     resolveContained and fail closed — while a benign name still imports.
//
// Both are driven through the real CLI as a subprocess so the guard is
// exercised end-to-end (wiring in src/cli.js included), not just as a unit.
// Every filesystem effect is confined to fresh mkdtemp dirs: the child's HOME /
// USERPROFILE / AGENT_CLI_HOME all point at a throwaway sandbox home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli.js");

/** mkdtemp + realpath — the child's process.cwd() is the real path, so paths we
 *  compute here must be too (macOS /var→/private/var, Windows 8.3 short names). */
function tmpDir(prefix) {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Sandbox home: util.js resolves HOME from AGENT_CLI_HOME at module load, so the
// global agents dir (~/.agents/agents) can never be the real one.
const SANDBOX_HOME = tmpDir("agent-delegsec-home-");
process.env.AGENT_CLI_HOME = SANDBOX_HOME;

const SCRATCH = [SANDBOX_HOME];

function scratch(prefix) {
	const d = tmpDir(prefix);
	SCRATCH.push(d);
	return d;
}

/** Run the real CLI from `cwd` with a fully sandboxed environment. Per-call
 *  `env` entries are applied last so an explicit "" can neutralize an inherited
 *  var (e.g. a developer's real $VISUAL). */
function runCli(args, { cwd, env = {} } = {}) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		cwd,
		env: {
			...process.env,
			HOME: SANDBOX_HOME,
			USERPROFILE: SANDBOX_HOME,
			AGENT_CLI_HOME: SANDBOX_HOME,
			AGENT_OFFLINE: "1",
			AGENT_CLI_NO_UPDATE_CHECK: "1",
			...env,
		},
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function persona(name, extra = "") {
	return `---\nname: ${name}\ndescription: fixture persona\n---\n\n${extra}body\n`;
}

// -----------------------------------------------------------------------------
// SEC-2 — `agents import` must not let untrusted frontmatter escape the agents dir
// -----------------------------------------------------------------------------

test("SEC-2: `agents import` refuses a traversal name and writes nothing outside the agents dir", () => {
	// Layout: <root>/repo is the malicious project cwd, <root>/victim.md is an
	// existing file the traversal would clobber. projectAgentsDir is
	// <root>/repo/.agents/agents, so `../../..` lands back on <root>.
	const root = scratch("agent-delegsec-sec2-");
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo, { recursive: true });
	const victim = path.join(root, "victim.md");
	fs.writeFileSync(victim, "ORIGINAL VICTIM CONTENT\n", "utf8");

	const shared = scratch("agent-delegsec-shared-");

	// (a) the exact payload the guard's comment describes: escape two levels and
	//     drop a file straight into the project root.
	const evil = path.join(shared, "evil.md");
	fs.writeFileSync(evil, persona("../../PWNED"), "utf8");

	const r = runCli(["agents", "import", evil], { cwd: repo });

	// THE assertion (checked first so a regression reports the escape itself):
	// on the vulnerable code path
	// path.join(<repo>/.agents/agents, "../../PWNED.md") === <repo>/PWNED.md and
	// the file WAS created there.
	assert.equal(
		fs.existsSync(path.join(repo, "PWNED.md")),
		false,
		`traversal target [cwd]/PWNED.md must not be created (stdout: ${r.stdout})`,
	);
	assert.notEqual(
		r.status,
		0,
		`import of a traversal name must exit non-zero (stdout: ${r.stdout} stderr: ${r.stderr})`,
	);
	assert.match(
		r.stderr + r.stdout,
		/Refusing import/,
		"the refusal must be explained, not a bare crash",
	);

	// (b) same class, but aimed at an existing file — proves the guard blocks
	//     overwrite, not just creation.
	const evilOverwrite = path.join(shared, "evil-overwrite.md");
	fs.writeFileSync(evilOverwrite, persona("../../../victim"), "utf8");

	const r2 = runCli(["agents", "import", evilOverwrite], { cwd: repo });

	assert.equal(
		fs.readFileSync(victim, "utf8"),
		"ORIGINAL VICTIM CONTENT\n",
		"an existing .md outside the agents dir must be left untouched",
	);
	assert.notEqual(r2.status, 0, "overwrite traversal must exit non-zero");

	// Nothing was smuggled into the agents dir under a mangled name either.
	const agentsDir = path.join(repo, ".agents", "agents");
	const landed = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : [];
	assert.deepEqual(
		landed.filter((f) => /PWNED|victim/i.test(f)),
		[],
		"refused imports must leave no file behind",
	);
});

test("SEC-2: a benign `agents import` still succeeds and lands in the project agents dir", () => {
	// Guard precision: fail-closed must not turn into fail-always. Mirrors
	// projectAgentsDir() in src/agents-lib.js → [cwd]/.agents/agents.
	const repo = scratch("agent-delegsec-sec2-ok-");
	const shared = scratch("agent-delegsec-shared-ok-");
	const good = path.join(shared, "good.md");
	fs.writeFileSync(good, persona("helper"), "utf8");

	const r = runCli(["agents", "import", good], { cwd: repo });

	assert.equal(
		r.status,
		0,
		`benign import must succeed (stdout: ${r.stdout} stderr: ${r.stderr})`,
	);
	const target = path.join(repo, ".agents", "agents", "helper.md");
	assert.equal(
		fs.existsSync(target),
		true,
		`benign import must land at ${target}`,
	);
	assert.match(fs.readFileSync(target, "utf8"), /^name: helper$/m);
});

// -----------------------------------------------------------------------------
// SEC-1 — `agents edit` must hand the repo-controlled path to the editor as argv
// -----------------------------------------------------------------------------

/** A filename that is legal on this platform but is a command separator to the
 *  platform's shell — the whole point of the vulnerability. */
function injectionFilename() {
	// `>` `<` `|` `"` are illegal in Windows filenames, so the payload uses the
	// cmd.exe separator `&` plus a builtin that needs no redirection. On POSIX
	// both `$(...)` and `;` are legal filename characters.
	return process.platform === "win32"
		? "helper&mkdir pwned&.md"
		: "helper$(mkdir pwned);.md";
}

test("SEC-1: `agents edit` passes a metacharacter-laden agent path as one literal argv (no shell)", (t) => {
	const repo = scratch("agent-delegsec-sec1-");
	const agentsDir = path.join(repo, ".agents", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	// The FILENAME carries the payload; the frontmatter name is a clean id, so
	// `agents edit helper` resolves to it (showAgent matches on frontmatter).
	const evilName = injectionFilename();
	const agentPath = path.join(agentsDir, evilName);
	try {
		fs.writeFileSync(agentPath, persona("helper"), "utf8");
	} catch (err) {
		t.skip(
			`this platform cannot express the shell-metacharacter payload ${JSON.stringify(evilName)} as a filename (${err.code || err.message})`,
		);
		return;
	}

	// A "fake editor" that records exactly what argv it received. .cjs so it is
	// CommonJS regardless of any package.json above the scratch dir.
	const fakeEditor = path.join(repo, "fake-editor.cjs");
	fs.writeFileSync(
		fakeEditor,
		"require('node:fs').appendFileSync(process.env.FAKE_EDITOR_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n",
		"utf8",
	);
	const log = path.join(repo, "editor-argv.log");
	// Marker the payload would create if a shell ever interpreted the path.
	const marker = path.join(repo, "pwned");

	// process.execPath keeps the test hermetic (no PATH lookup); quoting it
	// exercises parseEditorCommand's quote-aware split too.
	const editor = `"${process.execPath}" "${fakeEditor}"`;
	const r = runCli(["agents", "edit", "helper"], {
		cwd: repo,
		env: { VISUAL: "", EDITOR: editor, FAKE_EDITOR_LOG: log },
	});

	assert.equal(
		fs.existsSync(log),
		true,
		`the editor must actually have been spawned (stdout: ${r.stdout} stderr: ${r.stderr})`,
	);

	const lines = fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter((l) => l.trim());
	assert.equal(lines.length, 1, "the editor must be spawned exactly once");
	const argv = JSON.parse(lines[0]);

	// THE assertion (asserted before the exit status so it is what a regression
	// reports): with shell: true the shell split the command line at the
	// metacharacter, so the editor received a TRUNCATED path (".../helper") and
	// the tail ran as a separate command. A shell-free spawn delivers the whole
	// path — metacharacters and all — as a single literal argv element.
	assert.equal(
		argv.length,
		1,
		`editor must receive exactly one argument, got ${JSON.stringify(argv)}`,
	);
	assert.equal(
		path.basename(argv[0]),
		evilName,
		`the agent path must arrive intact and unsplit, got ${JSON.stringify(argv[0])}`,
	);
	assert.equal(
		fs.realpathSync(argv[0]),
		fs.realpathSync(agentPath),
		"the editor must be pointed at the real agent file",
	);

	// And the injected command must never have run.
	assert.equal(
		fs.existsSync(marker),
		false,
		"the payload embedded in the filename must not have been executed",
	);

	// Only now the exit status: a shell that split the path also tried to run the
	// tail (".md") as a command and failed, so this catches the regression too.
	assert.equal(
		r.status,
		0,
		`agents edit must succeed (stdout: ${r.stdout} stderr: ${r.stderr})`,
	);
});

test("SEC-1: `agents edit` fails closed on an unparseable $EDITOR instead of falling back to a shell", () => {
	const repo = scratch("agent-delegsec-sec1-closed-");
	const agentsDir = path.join(repo, ".agents", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "helper.md"), persona("helper"), "utf8");

	const r = runCli(["agents", "edit", "helper"], {
		cwd: repo,
		env: { VISUAL: "", EDITOR: '"unbalanced -w' },
	});

	assert.notEqual(r.status, 0, "an unparseable editor must not be run");
	assert.match(r.stderr + r.stdout, /Cannot parse \$VISUAL\/\$EDITOR/);
});

test.after(() => {
	for (const d of SCRATCH) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			/* best effort — temp dirs */
		}
	}
});

// -----------------------------------------------------------------------------
// SEC-2b — the refute pass defeated the first fix. `resolveContained` is purely
// LEXICAL, so a name that stays "inside" the agents dir on paper can still be
// redirected by a symlink, and the write itself followed links. A checked-out
// repo controls .agents/agents, and git materializes symlinks on checkout (a
// Windows junction needs no elevation), so these are repo-shippable.
// -----------------------------------------------------------------------------

/** Plant a link, or null when the OS refuses (unprivileged Windows). */
function tryLink(target, linkPath, type) {
	try {
		fs.rmSync(linkPath, { recursive: true, force: true });
	} catch {
		/* nothing to clear */
	}
	try {
		fs.symlinkSync(target, linkPath, type);
		return linkPath;
	} catch (e) {
		if (["EPERM", "EACCES", "ENOSYS", "UNKNOWN"].includes(e.code)) return null;
		throw e;
	}
}

test("SEC-2b: a symlinked DIRECTORY component cannot redirect the import (`name: shared/CLAUDE`)", (t) => {
	const proj = scratch("agent-delegsec-linkdir-");
	const agentsDir = path.join(proj, ".agents", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	const victimDir = path.join(SANDBOX_HOME, ".claude");
	fs.mkdirSync(victimDir, { recursive: true });
	const victim = path.join(victimDir, "CLAUDE.md");
	const original = "# Real user instructions\n";
	fs.writeFileSync(victim, original);

	if (
		!tryLink(
			victimDir,
			path.join(agentsDir, "shared"),
			process.platform === "win32" ? "junction" : "dir",
		)
	) {
		t.skip("OS refused link creation (no privilege)");
		return;
	}

	const src = path.join(proj, "friendly.md");
	fs.writeFileSync(src, persona("shared/CLAUDE", "# OWNED\n"));
	const r = runCli(["agents", "import", src], { cwd: proj });

	assert.notEqual(r.status, 0, "a name with a path separator must be refused");
	assert.equal(
		fs.readFileSync(victim, "utf8"),
		original,
		"the instruction file behind the symlinked dir must be untouched",
	);
});

test("SEC-2b: a symlink AT the destination is replaced, not written through (`name: notes`)", (t) => {
	const proj = scratch("agent-delegsec-linkfile-");
	const agentsDir = path.join(proj, ".agents", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	const victim = path.join(SANDBOX_HOME, "victim-notes.md");
	const original = "# do not touch\n";
	fs.writeFileSync(victim, original);

	// No path separators and no '..' — the name itself is entirely innocent, so
	// only a symlink-safe WRITE can stop this one.
	if (!tryLink(victim, path.join(agentsDir, "notes.md"), "file")) {
		t.skip("OS refused link creation (no privilege)");
		return;
	}

	const src = path.join(proj, "notes-src.md");
	fs.writeFileSync(src, persona("notes", "# OWNED\n"));
	runCli(["agents", "import", src], { cwd: proj });

	assert.equal(
		fs.readFileSync(victim, "utf8"),
		original,
		"the symlink target must not be written through",
	);
	assert.equal(
		fs.lstatSync(path.join(agentsDir, "notes.md")).isSymbolicLink(),
		false,
		"the link must have been replaced by a real file",
	);
});

test("SEC-2b: `agents rename` refuses a traversal new-name", () => {
	const proj = scratch("agent-delegsec-rename-");
	const agentsDir = path.join(proj, ".agents", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "victim.md"), persona("victim"));
	const victim = path.join(SANDBOX_HOME, "rename-target.md");
	const original = "# untouched\n";
	fs.writeFileSync(victim, original);

	const rel = path
		.relative(agentsDir, victim)
		.split(path.sep)
		.join("/")
		.replace(/\.md$/, "");
	const r = runCli(["agents", "rename", "victim", rel], { cwd: proj });

	assert.notEqual(r.status, 0, "a traversal rename must be refused");
	assert.equal(fs.readFileSync(victim, "utf8"), original);
	assert.ok(
		fs.existsSync(path.join(agentsDir, "victim.md")),
		"a refused rename must not delete the original",
	);
});
