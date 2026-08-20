// L1 regression tests: `agent-cli edit` must never hand the raw $VISUAL/$EDITOR
// string to a shell. Editor values parse into argv; unparseable values fail
// closed; the Windows .cmd/.bat shim fallback re-quotes metachar-free args.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const CLI = path.join(ROOT, "src", "cli.js");

// util.js resolves HOME at module load from AGENT_CLI_HOME — set before import.
const TMP = mkdtempSync(path.join(tmpdir(), "agent-edit-l1-"));
process.env.AGENT_CLI_HOME = TMP;

const util = await import("../src/util.js");

// ---- parseEditorCommand ------------------------------------------------------

test("parseEditorCommand: plain value → single argv", () => {
	assert.deepEqual(util.parseEditorCommand("vi"), ["vi"]);
	assert.deepEqual(util.parseEditorCommand("  nano  "), ["nano"]);
});

test("parseEditorCommand: value with flags → multiple argv", () => {
	assert.deepEqual(util.parseEditorCommand("code -w"), ["code", "-w"]);
	assert.deepEqual(util.parseEditorCommand("code --wait --new-window"), [
		"code",
		"--wait",
		"--new-window",
	]);
});

test("parseEditorCommand: quoted exe path with spaces stays one argv", () => {
	assert.deepEqual(
		util.parseEditorCommand('"C:\\Program Files\\Editor\\edit.exe" -w'),
		["C:\\Program Files\\Editor\\edit.exe", "-w"],
	);
	assert.deepEqual(util.parseEditorCommand("'code' -w"), ["code", "-w"]);
});

test("parseEditorCommand: escaped quote inside double quotes", () => {
	assert.deepEqual(util.parseEditorCommand('"we \\"ed\\" bin"'), [
		'we "ed" bin',
	]);
});

test("parseEditorCommand: unparseable values return null (fail closed)", () => {
	assert.equal(util.parseEditorCommand(""), null);
	assert.equal(util.parseEditorCommand("   "), null);
	assert.equal(util.parseEditorCommand(null), null);
	assert.equal(util.parseEditorCommand(undefined), null);
	assert.equal(util.parseEditorCommand('"unterminated -w'), null);
	assert.equal(util.parseEditorCommand("code -w'"), null);
});

// ---- cmdShimSpawnSync (guarded Windows fallback) ------------------------------

test("cmdShimSpawnSync: metachar editor args fail closed (null)", () => {
	const calls = [];
	const fake = (cmd, args, opts) => {
		calls.push([cmd, args, opts]);
		return { status: 0 };
	};
	// the original shell-injection payloads must never reach cmd.exe
	assert.equal(
		util.cmdShimSpawnSync(fake, ["notepad & calc"], "C:\\x\\AGENTS.md"),
		null,
	);
	assert.equal(util.cmdShimSpawnSync(fake, ["x%PATH%"], "t"), null);
	assert.equal(util.cmdShimSpawnSync(fake, ["x", "|rm"], "t"), null);
	assert.equal(util.cmdShimSpawnSync(fake, ["x", "<in"], "t"), null);
	assert.equal(util.cmdShimSpawnSync(fake, ['say "hi"'], "t"), null);
	assert.equal(calls.length, 0, "no spawn may happen for rejected args");
});

test("cmdShimSpawnSync: clean args spawn comspec /d /s /c with quoted cmdline", () => {
	const calls = [];
	const fake = (cmd, args, opts) => {
		calls.push([cmd, args, opts]);
		return { status: 0 };
	};
	const r = util.cmdShimSpawnSync(
		fake,
		["code", "-w"],
		"C:\\Users\\victor tomaili\\AGENTS.md",
	);
	assert.ok(r);
	assert.equal(calls.length, 1);
	const [cmd, args, opts] = calls[0];
	assert.equal(cmd, process.env.ComSpec || "cmd.exe");
	assert.deepEqual(args.slice(0, 3), ["/d", "/s", "/c"]);
	// target with spaces is re-quoted inside the synthesized cmdline
	assert.match(args[3], /"C:\\Users\\victor tomaili\\AGENTS\.md"$/);
	assert.equal(args[3].startsWith("code -w "), true);
	assert.equal(opts.stdio, "inherit");
});

// ---- end-to-end: `agent-cli edit` spawns the editor argv without a shell ----------

function runCli(args, env) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		cwd: TMP,
		env: { ...process.env, ...env },
	});
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("agent-cli edit: EDITOR='node -e script' receives the target as argv (no shell)", () => {
	// The editor writes a marker into the file it was given as its LAST argv —
	// only possible if we appended target to the parsed argv, not a shell string.
	const script = "require('fs').appendFileSync(process.argv[1], 'EDITED')";
	const r = runCli(["edit", "lessons"], {
		AGENT_CLI_HOME: TMP,
		VISUAL: "",
		EDITOR: `node -e "${script}"`,
	});
	assert.equal(r.status, 0, `edit failed: ${r.stderr}`);
	const edited = readFileSync(
		path.join(TMP, ".agents", "LESSONS.md"),
		"utf8",
	);
	assert.match(edited, /EDITED$/);
});

test("agent-cli edit: shell metacharacters in EDITOR are NOT executed", () => {
	// With shell:true this payload would have been shell-interpreted (redirect +
	// `|| calc`). Now: parseEditorCommand splits it into argv [node, -e, script,
	// "pwned>marker", "||", "calc"] — spawnSync("node", …) passes them as LITERAL
	// argv, node ignores the extra script args, and no marker file appears.
	// (`node` is the editor argv[0] so the test needs no PATH executables beyond
	// the runtime itself — hermetic on win32 and POSIX.)
	const marker = path.join(TMP, "pwned");
	const script = "process.exit(0)";
	const r = runCli(["edit", "lessons"], {
		AGENT_CLI_HOME: TMP,
		VISUAL: "",
		EDITOR: `node -e "${script}" pwned>${JSON.stringify(marker).replaceAll('\\"', "")} || calc`,
	});
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	assert.equal(
		existsSync(marker),
		false,
		"marker file must NOT exist — metacharacters must not be shell-interpreted",
	);
});

test("agent-cli edit: unparseable EDITOR fails closed with a clear error", () => {
	const r = runCli(["edit", "lessons"], {
		AGENT_CLI_HOME: TMP,
		VISUAL: "",
		EDITOR: '"unbalanced -w',
	});
	assert.notEqual(r.status, 0);
	assert.match(r.stderr + r.stdout, /Cannot parse \$VISUAL\/\$EDITOR/);
});

// keep the tmp home populated for the e2e cases above (edit seeds missing files)
mkdirSync(path.join(TMP, ".agents"), { recursive: true });
writeFileSync(
	path.join(TMP, ".agents", "LESSONS.md"),
	"# LESSONS\n",
	{ flag: "a" },
);
