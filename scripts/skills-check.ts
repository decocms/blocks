#!/usr/bin/env bun
/**
 * skills-check.ts — the gate that keeps a skills repo from rotting.
 *
 * Written to be repo-agnostic on purpose: this repo is meant to be the pattern
 * other skill repos copy, so nothing here knows what a "migration" is. Point it
 * at any tree of `<skill>/SKILL.md` and it works.
 *
 * The failure this exists to prevent is not an invalid file — it is a skill that
 * grew until no agent can afford to load it. Two real examples, both live when
 * this was written: a `SKILL.md` of 23.4KB (the index that loads first, holding
 * the whole body), and a `references/gotchas.md` of 34.5KB that accumulated 45
 * unrelated items by append, to the point of repeating its own numbering twice.
 * Neither is invalid. Both are unusable. Size is the check nobody writes.
 *
 * Checks:
 *   1. frontmatter: valid, expected keys only, name matches dir, description ≤1024
 *   2. exactly one SKILL.md per skill (nested ones are rejected on upload anyway)
 *   3. size budget: SKILL.md ≤ 10KB, any other .md ≤ 15KB
 *   4. dead refs: every `](./x.md)` resolves next to the file that has it
 *
 * Usage: bun run skills:check
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Copied from decocms/migrations scripts/skills-check.ts — keep in sync there.
const root = new URL("../.agents/skills/", import.meta.url).pathname;

/**
 * Floor on discovery. A scan that finds nothing satisfies every check below
 * having examined nothing, and would print a green "0 skills ok". A gate that
 * cannot fire is worse than no gate, because it gets cited as coverage — move
 * this script one directory and the tick keeps arriving.
 *
 * Set to 1 rather than a headcount: this repo starts nearly empty and grows,
 * so any higher floor would just be a number to bump. One is enough to catch
 * the failure that actually happens (wrong root, empty checkout).
 */
const MIN_SKILLS = 1;

/** Budgets. Past these, the file stops being loadable and has to be split. */
const SKILL_MAX = 10 * 1024;
const REF_MAX = 15 * 1024;

const ALLOWED_KEYS = new Set(["name", "description", "license", "allowed-tools", "compatibility"]);
const SKIP_DIRS = new Set([".git", "node_modules", "scripts", ".github"]);

/** Every `<dir>/SKILL.md` in the tree, as repo-relative dirs. */
function findSkills(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.name === "SKILL.md") {
        out.push(relative(root, dir) || ".");
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Minimal frontmatter reader. Deliberately not a YAML parser: skill frontmatter
 * is flat `key: value`, and a real parser is a dependency for four assertions.
 * Anything it cannot read confidently is reported as a failure rather than
 * skipped — an unparseable header must not sail through as "no problems found".
 */
function readFrontmatter(text: string): { data: Record<string, string> } | { error: string } {
  if (!text.startsWith("---\n")) return { error: "no YAML frontmatter (file must start with `---`)" };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { error: "frontmatter opened with `---` but never closed" };

  const data: Record<string, string> = {};
  let key: string | null = null;
  for (const raw of text.slice(4, end).split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const m = raw.match(/^([A-Za-z][\w-]*):\s?(.*)$/);
    if (m) {
      key = m[1];
      const raw = m[2].trim();
      // Local addition (not in decocms/migrations): an unquoted value starting
      // with `@`/backtick or containing `: ` is invalid YAML. Claude Code
      // tolerates it; stricter agents drop the skill silently.
      if (!/^["']/.test(raw) && (/^[@`]/.test(raw) || raw.includes(": ")))
        return { error: `\`${key}\` must be quoted — unquoted it is invalid YAML (leading @/backtick or ": ")` };
      data[key] = raw.replace(/^["']|["']$/g, "");
    } else if (key && /^\s+\S/.test(raw)) {
      data[key] += ` ${raw.trim()}`; // folded continuation
    } else {
      return { error: `cannot parse frontmatter line: ${raw.slice(0, 60)}` };
    }
  }
  return { data };
}

const problems: string[] = [];
const skills = findSkills();

if (skills.length < MIN_SKILLS) {
  console.error(
    `found ${skills.length} skill(s) — expected at least ${MIN_SKILLS}. Nothing was checked; treat this as a failure, not a pass.`,
  );
  process.exit(1);
}

let filesChecked = 0;

for (const skill of skills) {
  const dir = join(root, skill);

  // 1 + 3: the SKILL.md itself
  const skillMd = join(dir, "SKILL.md");
  const size = statSync(skillMd).size;
  filesChecked++;
  if (size > SKILL_MAX) {
    problems.push(
      `${skill}/SKILL.md is ${(size / 1024).toFixed(1)}KB (max ${SKILL_MAX / 1024}KB) — SKILL.md is the index that loads first; move the body into references/<subject>.md`,
    );
  }

  const text = readFileSync(skillMd, "utf8");
  const fm = readFrontmatter(text);
  if ("error" in fm) {
    problems.push(`${skill}/SKILL.md: ${fm.error}`);
  } else {
    const { data } = fm;
    for (const k of Object.keys(data)) {
      if (!ALLOWED_KEYS.has(k)) problems.push(`${skill}/SKILL.md: unexpected frontmatter key \`${k}\``);
    }
    // A skill's name is its path with `/` → `-`. Skill names are a flat global
    // namespace once installed (`~/.claude/skills/<name>`), so a nested layout
    // cannot name a skill by its leaf alone: `source/deco-fresh` installed as
    // `deco-fresh` would collide with the next repo that has one.
    const expected = skill.replace(/\//g, "-");
    if (!data.name) problems.push(`${skill}/SKILL.md: missing \`name\``);
    else if (data.name !== expected)
      problems.push(
        `${skill}/SKILL.md: \`name: ${data.name}\` should be \`${expected}\` — a skill's name is its path with \`/\` replaced by \`-\``,
      );
    if (!data.description) problems.push(`${skill}/SKILL.md: missing \`description\``);
    else if (data.description.length > 1024)
      problems.push(`${skill}/SKILL.md: description is ${data.description.length} chars (max 1024)`);
  }

  // 2 + 3 + 4: everything else under the skill
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
        continue;
      }
      if (!e.name.endsWith(".md")) continue;
      const rel = relative(root, p);

      if (e.name === "SKILL.md" && p !== skillMd) {
        problems.push(
          `${rel}: nested SKILL.md — a skill must have exactly one, at <skill>/SKILL.md. Rename it to references/<topic>.md, or make it its own skill.`,
        );
        continue;
      }
      if (p === skillMd) continue;

      filesChecked++;
      const s = statSync(p).size;
      if (s > REF_MAX) {
        problems.push(
          `${rel} is ${(s / 1024).toFixed(1)}KB (max ${REF_MAX / 1024}KB) — split it by subject into its own folder with a README.md`,
        );
      }

      for (const match of readFileSync(p, "utf8").match(/\]\((\.\/[A-Za-z0-9._-]+\.md)\)/g) ?? []) {
        const target = join(dirname(p), match.slice(2, -1));
        if (!existsSync(target)) problems.push(`${rel}: relative link does not resolve → ${match.slice(2, -1)}`);
      }
    }
  };
  walk(dir);
}

if (problems.length) {
  const unique = [...new Set(problems)];
  console.error(`${unique.length} problem(s) across ${skills.length} skill(s):\n`);
  for (const p of unique) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`skills ok — ${skills.length} skill(s), ${filesChecked} markdown file(s), all within budget`);
