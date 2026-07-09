#!/usr/bin/env node
// Release-time helper: writes ${VERSION} into every packages/*/package.json,
// rewriting "workspace:*" dependencies to the concrete version so `npm publish`
// (run per-package, outside the workspace context) resolves correctly.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.env.VERSION;
if (!version) {
  console.error("VERSION env var required");
  process.exit(1);
}

const packagesDir = join(import.meta.dirname, "..", "packages");
const packageNames = new Set(
  readdirSync(packagesDir).map((dir) => {
    const pkg = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
    return pkg.name;
  }),
);

for (const dir of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  for (const depField of ["dependencies", "peerDependencies", "devDependencies"]) {
    if (!pkg[depField]) continue;
    for (const dep of Object.keys(pkg[depField])) {
      if (packageNames.has(dep) && pkg[depField][dep] === "workspace:*") {
        pkg[depField][dep] = version;
      }
    }
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

console.log(`Synced version ${version} across ${packageNames.size} packages`);
