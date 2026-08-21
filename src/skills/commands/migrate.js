import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import c from "picocolors";
import {
  parseSkillMd,
  getTriggers,
  getVersion,
  EXT_NS,
} from "../lib/frontmatter.js";
import { listStore, readSkillMdBounded } from "../lib/store.js";
import { readLock, writeLock } from "./lock.js";

/**
 * Pure rewrite plan for one SKILL.md: move top-level agent-cli extension
 * fields (triggers, version) into the spec-conformant metadata namespace
 * (`agent-cli.triggers` / `agent-cli.version`), preserving every other
 * frontmatter field (original order) and the body verbatim.
 *
 * Returns { needs: false } or { needs: true, moves, next } where `next` is
 * the full replacement file content. `data.triggers: []` (empty) is DROPPED,
 * not migrated — empty triggers carry no behavior.
 */
export function planMigrate(content) {
  const { data, body, parseError } = parseSkillMd(content);
  if (parseError) return { needs: false, parseError };
  const hasTriggers = data.triggers !== undefined;
  const hasVersion = data.version !== undefined;
  if (!hasTriggers && !hasVersion) return { needs: false };

  const moves = [];
  const merged = {
    ...(typeof data.metadata === "object" &&
    data.metadata !== null &&
    !Array.isArray(data.metadata)
      ? data.metadata
      : {}),
  };
  if (hasTriggers) {
    const trg = getTriggers(data);
    if (trg.length > 0) {
      merged[`${EXT_NS}.triggers`] = trg.join(", ");
      moves.push(`triggers [${trg.join(", ")}]`);
    } else {
      moves.push("triggers [] (dropped — empty)");
    }
  }
  if (hasVersion) {
    const ver = getVersion(data);
    if (ver) {
      merged[`${EXT_NS}.version`] = ver;
      moves.push(`version ${ver}`);
    } else {
      moves.push("version (dropped — unparseable)");
    }
  }

  // Rebuild the frontmatter preserving the original field order; metadata
  // keeps its original slot, extension fields leave, everything else is
  // untouched. lineWidth 0 keeps long descriptions unwrapped.
  const next = {};
  let metadataPlaced = false;
  for (const k of Object.keys(data)) {
    if (k === "triggers" || k === "version") continue;
    if (k === "metadata") {
      next[k] = merged;
      metadataPlaced = true;
    } else {
      next[k] = data[k];
    }
  }
  if (!metadataPlaced) next.metadata = merged;

  const fm = yaml.stringify(next, { lineWidth: 0 }).trimEnd();
  return {
    needs: true,
    moves,
    next: `---\n${fm}\n---\n${body}`,
  };
}

/** Atomic write: tmp file in the same dir, then rename over the target. */
function atomicWrite(file, content) {
  const tmp = path.join(path.dirname(file), `.SKILL.md.migrate-${process.pid}`);
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * `skill migrate [name] [--apply]` — move legacy top-level triggers/version
 * into the metadata namespace for store skills. Dry-run by default: prints
 * what would change; `--apply` writes (atomically) and refreshes the
 * provenance lock's content hash.
 */
export function cmdMigrate(args) {
  const apply = args.includes("--apply");
  const filter = args.find((a) => !a.startsWith("-"));
  const installed = listStore();
  const targets = filter
    ? installed.filter((s) => s.name === filter || s.dir === filter)
    : installed;
  if (filter && targets.length === 0) {
    console.error(c.red(`Not found in store: ${filter}`));
    process.exit(1);
  }

  let changed = 0;
  let conformant = 0;
  for (const s of targets) {
    const raw = readSkillMdBounded(s.path);
    if (raw == null) continue;
    const plan = planMigrate(raw);
    if (!plan.needs) {
      conformant++;
      console.log(c.green("✓") + ` ${s.name} — already conformant`);
      continue;
    }
    changed++;
    const what = plan.moves.join(" + ");
    if (!apply) {
      console.log(c.yellow("→") + ` ${s.name}: ${what} → metadata.${EXT_NS}.*`);
      continue;
    }
    atomicWrite(s.path, plan.next);
    if (readLock(s.dir)) {
      writeLock(path.dirname(s.path), readLock(s.dir)?.source);
    }
    console.log(
      c.green("✓") + ` ${s.name}: migrated ${what} → metadata.${EXT_NS}.*`,
    );
  }

  console.log();
  if (changed === 0) {
    console.log(
      c.gray(`All ${targets.length} skill(s) conformant — nothing to migrate.`),
    );
    return;
  }
  if (apply) {
    console.log(c.green(`✓ migrated ${changed} skill(s)`));
  } else {
    console.log(
      c.yellow(
        `dry run — ${changed} skill(s) would migrate. Re-run with --apply to write.`,
      ),
    );
  }
}
