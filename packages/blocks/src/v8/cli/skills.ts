/**
 * `deco skills install`: copies the agent skills this package ships (its
 * `skills/` folder, which scripts/pack-skills.mjs fills from the repo's
 * `.agents/skills` at build) into a site, so coding agents load the skills of
 * the installed version. No network.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./root.ts";

/** Where skills go when `--dir` isn't given, relative to the site's root. */
export const DEFAULT_SKILLS_DIR = ".claude/skills";

/** The package's `skills/` folder: dist/v8/cli (or src/v8/cli) → ../../../skills. */
export function shippedSkillsDir(): string {
  return fileURLToPath(new URL("../../../skills/", import.meta.url));
}

export interface InstallSkillsOptions {
  /** The site's root (the folder that contains `.deco/`). */
  root: string;
  /** Where to install, relative to `root` or absolute. Default `.claude/skills`. */
  dir?: string;
  /** Where the shipped skills are. Default: the package's `skills/` folder. */
  from?: string;
}

export interface InstalledSkills {
  /** The folder the skills went into, absolute. */
  dir: string;
  /** The skills installed, by name, sorted. */
  skills: string[];
}

/** The skills in a folder: its subfolders with a SKILL.md, sorted. */
function listSkills(from: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(from, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) => entry.isDirectory() && fs.existsSync(path.join(from, entry.name, "SKILL.md")),
    )
    .map((entry) => entry.name)
    .sort();
}

/** A path with its symlinks resolved; the path itself when it doesn't exist yet. */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Copy every shipped skill into `<root>/<dir>/<skill>/`. A skill's folder is
 * replaced as a whole, so a file an older version shipped doesn't linger;
 * any other folder in `dir` (a skill this package doesn't ship) is left alone.
 */
export function installSkills(options: InstallSkillsOptions): InstalledSkills {
  const from = options.from ?? shippedSkillsDir();
  const skills = listSkills(from);
  if (skills.length === 0) {
    throw new CliError(
      `no skills in ${from}; this @decocms/blocks was built without them (in a checkout, run bun run build)`,
    );
  }
  const dir = path.resolve(options.root, options.dir ?? DEFAULT_SKILLS_DIR);
  // Replacing a skill deletes its folder first: never when that folder is (or,
  // through a symlink, leads to) the copy the package ships.
  if (realPath(dir) === realPath(from)) {
    throw new CliError(`${dir} is where @decocms/blocks keeps its skills; pass another --dir`);
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of skills) {
      const target = path.join(dir, name);
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(path.join(from, name), target, { recursive: true });
    }
  } catch (error) {
    throw new CliError(`can't install the skills into ${dir}: ${(error as Error).message}`);
  }
  return { dir, skills };
}
