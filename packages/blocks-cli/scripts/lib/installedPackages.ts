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
