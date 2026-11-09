#!/usr/bin/env node
// Copies the repo's agent skills into @decocms/blocks, so the package ships
// them and `deco skills install` copies the ones of the installed version
// into a site, offline. Part of packages/blocks' `build` (which `prepack`,
// the release's prepareCmd and `bun install` run).
//
//   node scripts/pack-skills.mjs [--from <dir>] [--to <dir>]
//
// --from (default: this repo's .agents/skills) holds one folder per skill;
// only folders with a SKILL.md are skills. --to (default:
// packages/blocks/skills, git-ignored) is removed first, so a deleted skill or
// file never ships. Tests, fixtures and node_modules stay out.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const repo = join(import.meta.dirname, "..");
let from = join(repo, ".agents", "skills");
let to = join(repo, "packages", "blocks", "skills");

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const value = argv[++i];
  if (value === undefined) fail(`${arg} needs a value`);
  if (arg === "--from") from = resolve(value);
  else if (arg === "--to") to = resolve(value);
  else fail(`unknown option ${arg}`);
}

function fail(message) {
  console.error(`pack-skills: ${message}`);
  process.exit(1);
}

/** What stays out of the package: tests and their fixtures, installed dependencies. */
function shipped(path) {
  const name = basename(path);
  return !(
    /\.test\.tsx?$/.test(name) ||
    /^__(tests|fixtures|conformance)__$/.test(name) ||
    name === "node_modules"
  );
}

if (!existsSync(from)) fail(`no skills folder at ${from}`);
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
const skills = readdirSync(from, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(from, entry.name, "SKILL.md")))
  .map((entry) => entry.name)
  .sort();
for (const name of skills) {
  cpSync(join(from, name), join(to, name), { recursive: true, filter: shipped });
}
console.log(`pack-skills: ${skills.length} skill(s) into ${to}: ${skills.join(", ")}`);
