import fs from "node:fs";
import path from "node:path";
import c from "picocolors";
import {
  parseSkillMd,
  getTriggers,
  getVersion,
  getMetadata,
  stringField,
  SPEC_FIELDS,
  AGENT_CLI_EXT_FIELDS,
  EXT_NS,
} from "../lib/frontmatter.js";
import {
  sanitizeSkillName,
  listStore,
  readSkill,
  skillMdPath,
  readSkillMdBounded,
} from "../lib/store.js";

// Resolve a user-supplied target: a store skill name, or a path to a
// SKILL.md (or a dir containing SKILL.md). Returns null if unresolvable.
export function resolveSkillTarget(target) {
  if (!target) return null;
  // store name?
  if (sanitizeSkillName(target) && fs.existsSync(skillMdPath(target))) {
    return { kind: "store", name: target, path: skillMdPath(target) };
  }
  const hit = listStore().find(
    (s) => s.name.toLowerCase() === target.toLowerCase(),
  );
  if (hit) return { kind: "store", name: hit.name, path: hit.path };
  // path?
  const p = path.resolve(target);
  const md =
    fs.existsSync(p) && fs.statSync(p).isDirectory()
      ? path.join(p, "SKILL.md")
      : p;
  if (fs.existsSync(md))
    return { kind: "path", name: path.basename(path.dirname(md)), path: md };
  return null;
}

export function loadSkillTarget(target) {
  const res = resolveSkillTarget(target);
  if (!res) return null;
  // M5: an arbitrary user path (skill validate ./huge.md) must not be slurped.
  const raw = readSkillMdBounded(res.path);
  if (raw == null) return null;
  const { data, body } = parseSkillMd(raw);
  return { ...res, data, body };
}

// The validation checks shared by `skill validate` (and usable by `install`).
// Implements the Agent Skills spec (agentskills.io) validation rules — the
// same checks skills-ref runs: closed frontmatter allowlist, name charset /
// length / lowercase / directory match, description 1–1024, compatibility ≤500
// — PLUS agent-cli's documented extensions (triggers, version) accepted with a
// portability warning. Returns { ok, name, errors[], warnings[], data, body, triggers }.
export function validateSkill(
  content,
  { fileName: _fileName = "SKILL.md", dirName } = {},
) {
  const { data, body, parseError } = parseSkillMd(content);
  const errors = [];
  const warnings = [];
  // GAP-15: a YAML parse error is the root cause — report it, not a misleading
  // cascade of "name is required" style errors against an empty mapping.
  if (parseError) errors.push(`frontmatter is not valid YAML: ${parseError}`);

  // --- spec: name ---
  const name = stringField(data.name);
  if (!name) errors.push("frontmatter `name` is required");
  else if (!sanitizeSkillName(name))
    errors.push(`frontmatter \`name\` is not a safe skill name: "${name}"`);
  if (name) {
    const n = name.normalize("NFKC");
    if (n.length > 64)
      errors.push(
        `skill name exceeds the 64-character limit (${n.length} chars) — Agent Skills spec`,
      );
    if (n !== n.toLowerCase())
      errors.push(`skill name must be lowercase — got "${name}"`);
    if (n.startsWith("-") || n.endsWith("-"))
      errors.push("skill name cannot start or end with a hyphen");
    if (n.includes("--"))
      errors.push("skill name cannot contain consecutive hyphens");
    if (!/^[\p{Ll}\p{Nd}-]*$/u.test(n))
      errors.push(
        "skill name contains invalid characters — only lowercase letters, digits, and hyphens are allowed",
      );
    if (dirName && dirName.normalize("NFKC") !== n)
      errors.push(
        `directory name "${dirName}" must match skill name "${n}" (Agent Skills spec)`,
      );
  }

  // --- spec: description (required, 1–1024) ---
  const desc = stringField(data.description);
  if (!desc)
    errors.push(
      "frontmatter `description` is required — 1-1024 chars saying what the skill does and when to use it",
    );
  else if (desc.length > 1024)
    errors.push(
      `description exceeds the 1024-character limit (${desc.length} chars)`,
    );

  // --- spec: optional typed fields ---
  if (data.compatibility !== undefined) {
    if (typeof data.compatibility !== "string")
      errors.push("frontmatter `compatibility` must be a string");
    else if (data.compatibility.length > 500)
      errors.push(
        `compatibility exceeds the 500-character limit (${data.compatibility.length} chars)`,
      );
  }
  if (data.license !== undefined && typeof data.license !== "string")
    errors.push("frontmatter `license` must be a string");
  if (
    data["allowed-tools"] !== undefined &&
    typeof data["allowed-tools"] !== "string"
  )
    errors.push(
      "frontmatter `allowed-tools` must be a space-separated string of tool names",
    );
  if (data.metadata !== undefined) {
    const md = getMetadata(data);
    if (md)
      for (const [k, v] of Object.entries(md)) {
        if (typeof v !== "string")
          warnings.push(
            `metadata value for "${k}" is not a string — the spec defines metadata as string → string`,
          );
      }
    else
      errors.push(
        "frontmatter `metadata` must be a mapping (the spec defines it as string → string)",
      );
  }

  // --- spec: closed allowlist (+ our documented extensions) ---
  const allowed = new Set([...SPEC_FIELDS, ...AGENT_CLI_EXT_FIELDS]);
  const extra = Object.keys(data)
    .filter((k) => !allowed.has(k))
    .sort();
  if (extra.length) {
    errors.push(
      `unexpected fields in frontmatter: ${extra.join(", ")} — only ${SPEC_FIELDS.join(", ")} (Agent Skills spec) plus ${AGENT_CLI_EXT_FIELDS.join(", ")} (agent-cli extension) are allowed`,
    );
  }

  // --- agent-cli extensions: type checks + portability warnings ---
  const vRaw = data.version;
  if (
    vRaw !== undefined &&
    typeof vRaw !== "string" &&
    typeof vRaw !== "number"
  ) {
    errors.push("frontmatter `version` must be a string or number");
  }
  if (vRaw !== undefined) {
    warnings.push(
      `top-level \`version\` is an agent-cli extension — for portability move it under metadata: { "${EXT_NS}.version": "1.0.0" }`,
    );
  }
  const extMeta = getMetadata(data);
  if (extMeta) {
    const mv = extMeta[`${EXT_NS}.version`];
    if (mv !== undefined && typeof mv !== "string")
      errors.push(`metadata "${EXT_NS}.version" must be a string`);
  }
  if (data.triggers !== undefined) {
    const ok =
      (Array.isArray(data.triggers) &&
        data.triggers.every((t) => typeof t === "string")) ||
      typeof data.triggers === "string";
    if (!ok)
      errors.push(
        "frontmatter `triggers` must be a string or array of strings",
      );
    else
      warnings.push(
        `top-level \`triggers\` is an agent-cli extension — for portability move it under metadata: { "${EXT_NS}.triggers": "a, b" }`,
      );
  }
  const triggers = getTriggers(data);
  for (const t of triggers) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(t))
      warnings.push(
        `trigger "/${t}" is not alphanumeric — may be hard to invoke`,
      );
  }

  if (!body.trim())
    warnings.push("SKILL.md has no body — add instructions for the agent");
  return {
    ok: errors.length === 0,
    name,
    errors,
    warnings,
    data,
    body,
    triggers,
  };
}

// `skill validate <name|path>` — check a skill's SKILL.md frontmatter + body.
// Exits 0 on valid (warnings may print), 1 on invalid.
export function cmdValidate(args) {
  const target = args.find((a) => !a.startsWith("-"));
  const res = target ? resolveSkillTarget(target) : null;
  if (!res) {
    console.error(
      c.red(
        `Not found: ${target || "<none>"} — give a store skill name or a path to SKILL.md`,
      ),
    );
    console.error(
      c.gray("  Tip: after `skill create`, run `skill validate ./<name>`"),
    );
    process.exit(1);
  }
  const content = fs.readFileSync(res.path, "utf8");
  // Spec rule: the skill name must match its parent directory — pass it in so
  // the check runs wherever the skill lives (store entry or loose dir).
  const v = validateSkill(content, {
    dirName: path.basename(path.dirname(res.path)),
  });
  console.log(c.bold("skill validate") + c.gray(` — ${res.path}`));
  if (v.ok && v.warnings.length === 0) {
    console.log(c.green("✓ valid") + c.gray(` — ${v.name || "(no name)"}`));
    return;
  }
  for (const e of v.errors) console.log(c.red(`  ✗ ${e}`));
  for (const w of v.warnings) console.log(c.yellow(`  ⚠ ${w}`));
  if (v.errors.length) {
    console.log();
    process.exit(1);
  }
  console.log();
  console.log(
    c.green("✓ frontmatter valid") + c.gray(" (address warnings for best UX)"),
  );
}

// `skill preview <name|path>` — print what the agent would load (`skill cat`):
// frontmatter summary + full body. Useful for authoring/review.
export function cmdPreview(args) {
  const target = args.find((a) => !a.startsWith("-"));
  const res = target ? resolveSkillTarget(target) : null;
  if (!res) {
    console.error(c.red(`Not found: ${target || "<none>"}`));
    process.exit(1);
  }
  const { data, body } = parseSkillMd(fs.readFileSync(res.path, "utf8"));
  const name = stringField(data.name) || res.name;
  console.log(c.bold(name) + c.gray(`  (${res.path})`));
  const desc = stringField(data.description);
  if (desc) console.log(c.gray(`  ${desc.replace(/[\r\n]+/g, " ")}`));
  const trg = getTriggers(data);
  if (trg.length) console.log(c.gray(`  triggers: /${trg.join(", /")}`));
  const ver = getVersion(data);
  if (ver) console.log(c.gray(`  version: ${ver}`));
  console.log();
  console.log(body.trimEnd());
}

// `skill cat`-style body dump used by `preview --body` (agent-facing).
export function catBody(target) {
  const s = loadSkillTarget(target);
  if (!s) return null;
  return { name: s.data.name || s.name, body: s.body, data: s.data };
}

// Re-export readSkill for other commands (run/test/capture) to share lookup.
export { readSkill };
