import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Search from the consuming site, including ancestor node_modules directories
 * used by workspace hoisting. Directory lookup also works with source-only
 * checkouts and packages whose exports expose neither the root nor package.json. */
function moduleDirectories(cwd: string, name: string): string[] {
  return createRequire(path.resolve(cwd, "package.json")).resolve.paths(name) ?? [];
}

export function resolvePackageDirectory(cwd: string, name: string): string | null {
  for (const modules of moduleDirectories(cwd, name)) {
    const dir = path.join(modules, name);
    if (fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return dir;
  }
  return null;
}

interface SectionPackage {
  namespace: string;
  sectionsDir: string;
}

/** Packages whose `src/sections/**` the site exposes as CMS sections, read from
 * the site's package.json: `"deco": { "sectionPackages": { "ui": "@acme/ui" } }`.
 * Section keys become `<namespace>/sections/<path>`. The node_modules path
 * (not the realpath) is kept so generated imports stay stable whether the
 * package is a symlink (dev) or a copy (CI). Throws when a declared package is
 * missing, because skipping it would silently drop its sections from the admin. */
export function readSectionPackages(cwd: string): SectionPackage[] {
  let pkg: { deco?: { sectionPackages?: Record<string, string> } };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  } catch {
    return [];
  }
  return Object.entries(pkg.deco?.sectionPackages ?? {}).map(([namespace, name]) => {
    if (namespace === "site") {
      throw new Error(
        `deco.sectionPackages: namespace "site" is reserved for the site's own sections (${name})`,
      );
    }
    const dir = resolvePackageDirectory(cwd, name);
    if (!dir) {
      throw new Error(
        `deco.sectionPackages: "${name}" is not installed. If it is a git submodule, ` +
          "run `git submodule update --init` and reinstall dependencies.",
      );
    }
    return { namespace, sectionsDir: path.join(dir, "src", "sections") };
  });
}

/** Installed packages in a scope, keyed by full package name. The nearest
 * copy wins, matching resolvePackageDirectory even with mixed local/hoisted
 * installs; shadowed ancestor copies must not enter codegen fingerprints. */
export function listScopedPackages(cwd: string, scope: string): Map<string, string> {
  const packages = new Map<string, string>();
  for (const modules of moduleDirectories(cwd, `${scope}/_`)) {
    const scopeDir = path.join(modules, scope);
    let names: string[];
    try {
      names = fs.readdirSync(scopeDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const fullName = `${scope}/${name}`;
      const dir = path.join(scopeDir, name);
      if (!packages.has(fullName) && fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
        packages.set(fullName, dir);
      }
    }
  }
  return new Map([...packages].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
