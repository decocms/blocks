#!/usr/bin/env node
// Release-time helper (.releaserc.json prepareCmd): writes ${VERSION} into
// every packages/*/package.json, so all the packages publish in lockstep.
//
// Ranges between the packages:
// - A package that builds on @decocms/blocks takes it as a peer dependency
//   with a caret range ("^8.3.0"), so a site has one blocks copy and a blocks
//   patch release never installs a second one next to an app or a binding.
//   The range is written by hand and left as is here: raise its floor when a
//   package starts using a newer blocks API.
// - "workspace:" ranges are for the workspace only. They are allowed in
//   devDependencies (rewritten to the release version, since npm cannot read
//   them) and refused in dependencies and peerDependencies, where an exact
//   pin would reach the sites.
//
// PACKAGES_DIR overrides the packages folder (the release test runs this on
// a copy of the manifests).
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const version = process.env.VERSION;
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`VERSION env var required (a semver version), got ${JSON.stringify(version)}`);
  process.exit(1);
}

const packagesDir = process.env.PACKAGES_DIR ?? join(import.meta.dirname, "..", "packages");
const dirs = readdirSync(packagesDir).filter((dir) =>
  existsSync(join(packagesDir, dir, "package.json")),
);
const manifests = dirs.map((dir) => {
  const path = join(packagesDir, dir, "package.json");
  return { dir, path, pkg: JSON.parse(readFileSync(path, "utf8")) };
});
const packageNames = new Set(manifests.map(({ pkg }) => pkg.name));

const [major, minor, patch] = version.split(/[.-]/).map(Number);
const floorAbove = (range) => {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!m) return true; // not a plain caret range: refused below
  const [a, b, c] = m.slice(1).map(Number);
  if (a !== major) return true;
  return b > minor || (b === minor && c > patch);
};

const errors = [];
for (const { dir, pkg } of manifests) {
  pkg.version = version;
  for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (!packageNames.has(dep)) continue;
      if (field === "devDependencies") {
        if (range.startsWith("workspace:")) pkg[field][dep] = version;
        continue;
      }
      if (field === "dependencies") {
        errors.push(`${dir}: ${dep} must be a peer dependency, not a dependency (${range})`);
      } else if (floorAbove(range)) {
        errors.push(
          `${dir}: peer ${dep} "${range}" must be a caret range in major ${major} whose floor is at most ${version}`,
        );
      }
    }
  }
}
if (errors.length) {
  console.error(`sync-versions: refusing to release ${version}:\n  ${errors.join("\n  ")}`);
  process.exit(1);
}

for (const { path, pkg } of manifests) writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Synced version ${version} across ${packageNames.size} packages`);
