#!/usr/bin/env tsx
/**
 * Upgrade a site off the frozen pre-split `@decocms/start@6.30.0` /
 * `@decocms/apps@5.4.0` packages onto the current 7.x split
 * (`@decocms/tanstack` + `@decocms/blocks` + `@decocms/blocks-admin` +
 * `@decocms/apps-*`). See #367.
 *
 * This is NOT the Fresh→TanStack migrator (`deco-migrate`) — it assumes the
 * site is already on TanStack Start and only needs its package dependency
 * moved to the current split. Rewrites import specifiers (including the
 * `@decocms/start/routes` / `@decocms/start/hooks` symbol fan-out and the
 * `decoMetaRoute`/`RenderSection` renames — see scripts/lib/upgrade-6-to-7.ts
 * for the full mapping) and updates package.json dependencies.
 *
 * Usage (from the site root):
 *   # dry-run (default): prints every file that would change, no writes
 *   npx -p @decocms/blocks-cli deco-upgrade-6-to-7
 *   # apply:
 *   npx -p @decocms/blocks-cli deco-upgrade-6-to-7 --write
 *
 * Options:
 *   --src-dir <dir>   Source dir to scan (default: src)
 *   --write           Apply changes (otherwise dry-run, exit 0)
 *   --help, -h        Show this help
 *
 * Exit codes: 0 ok / dry-run; 2 error (bad dir)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { upgradeFileToV7 } from "./lib/upgrade-6-to-7";

const FRAMEWORK_DEPS = [
  "@decocms/blocks",
  "@decocms/blocks-admin",
  "@decocms/tanstack",
  "@decocms/apps-commerce",
];
const PLATFORM_APPS_PREFIX = "@decocms/apps-";

function parseArgs(argv: string[]) {
  const has = (f: string) => argv.includes(f);
  const val = (f: string, d: string) => {
    const i = argv.indexOf(f);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  return {
    help: has("--help") || has("-h"),
    write: has("--write"),
    srcDir: val("--src-dir", "src"),
  };
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walkTsFiles(full, out);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Removes @decocms/start and @decocms/apps (bare, monolith) from a deps
 * object, and ensures the current split packages are present. Site- and
 * platform-specific version pins are left to `bun install`/`npm install`
 * against the fallback "latest" this writes — sites should pin exact
 * versions afterward the same way the scaffolder does. */
function upgradeDeps(deps: Record<string, string> | undefined): {
  next: Record<string, string>;
  removed: string[];
  added: string[];
} {
  const next: Record<string, string> = { ...(deps ?? {}) };
  const removed: string[] = [];
  for (const key of Object.keys(next)) {
    if (key === "@decocms/start" || key === "@decocms/apps") {
      delete next[key];
      removed.push(key);
    }
  }
  const added: string[] = [];
  if (removed.length > 0) {
    for (const dep of FRAMEWORK_DEPS) {
      if (!next[dep]) {
        next[dep] = "latest";
        added.push(dep);
      }
    }
  }
  return { next, removed, added };
}

function upgradePackageJson(pkgPath: string, write: boolean): void {
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

  const depsResult = upgradeDeps(pkg.dependencies);
  const devDepsResult = upgradeDeps(pkg.devDependencies);

  const removed = [...depsResult.removed, ...devDepsResult.removed];
  if (removed.length === 0) return;

  console.log(`  package.json: removing ${removed.join(", ")}`);
  const added = [...new Set([...depsResult.added, ...devDepsResult.added])];
  if (added.length > 0) {
    console.log(`  package.json: adding ${added.join(", ")} at "latest" — pin exact versions after install`);
  }

  if (!write) return;
  pkg.dependencies = depsResult.next;
  pkg.devDependencies = devDepsResult.next;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: deco-upgrade-6-to-7 [--src-dir <dir>] [--write]\n\n" +
        "Upgrades a site off @decocms/start@6.30.0 / @decocms/apps@5.4.0 onto the\n" +
        "current 7.x split. Dry-run by default; pass --write to apply.",
    );
    return;
  }

  const cwd = process.cwd();
  const srcDir = path.resolve(cwd, args.srcDir);
  if (!fs.existsSync(srcDir)) {
    console.error(`Source dir not found: ${srcDir}`);
    process.exitCode = 2;
    return;
  }

  const files = walkTsFiles(srcDir);
  let changedCount = 0;
  const allNotes: Array<{ file: string; note: string }> = [];

  for (const abs of files) {
    const content = fs.readFileSync(abs, "utf-8");
    const result = upgradeFileToV7(content);
    if (!result.changed) continue;

    changedCount++;
    const rel = path.relative(cwd, abs);
    console.log(`${args.write ? "upgraded" : "would upgrade"}: ${rel}`);
    for (const note of result.notes) allNotes.push({ file: rel, note });

    if (args.write) fs.writeFileSync(abs, result.content);
  }

  upgradePackageJson(path.join(cwd, "package.json"), args.write);

  if (allNotes.length > 0) {
    console.log("\nManual review needed:");
    for (const { file, note } of allNotes) console.log(`  [${file}] ${note}`);
  }

  console.log(
    `\n${args.write ? "Upgraded" : "Would upgrade"} ${changedCount} file(s).` +
      (args.write ? "" : " Re-run with --write to apply."),
  );
}

main();
