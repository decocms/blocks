#!/usr/bin/env node
// Release-time publisher (.releaserc.json publishCmd): publishes each package
// of the lockstep release to npm, in the order given, and survives a
// transient registry error.
//
//   node scripts/publish.mjs --version 8.5.1 --tag latest blocks tanstack ...
//
// Why: semantic-release tags the release before it publishes, so a run that
// fails halfway can't be re-run (the tag exists, nothing is released) and the
// packages it missed stay missing until the next release. blocks-v8.5.0 lost
// @decocms/tanstack to one 502 from Sigstore while npm signed its provenance.
//
// For each package:
// - skip it when name@version is already on the registry (a re-run, or a
//   publish whose response was lost);
// - otherwise `npm publish --access public --tag <tag>` from packages/<dir>,
//   up to 4 attempts with increasing backoff (--backoff, seconds between
//   attempts, default 15,30,60); after a failed attempt, check the registry
//   first, since the version may have landed anyway;
// - a package still missing after every attempt prints
//   `::error::npm publish failed for packages/<dir>`, the others go on, and
//   the script exits 1 at the end.
//
// Everything comes from the arguments: --packages-dir (default: this repo's
// packages/) is where each <dir>/package.json is, and its version must be
// --version (prepareCmd's sync-versions.mjs wrote it).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

function parseArgs(argv) {
  const opts = {
    version: undefined,
    tag: undefined,
    backoff: [15, 30, 60],
    packagesDir: join(import.meta.dirname, "..", "packages"),
    dirs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };
    if (arg === "--version") opts.version = value();
    else if (arg === "--tag") opts.tag = value();
    else if (arg === "--packages-dir") opts.packagesDir = resolve(value());
    else if (arg === "--backoff") {
      opts.backoff = value()
        .split(",")
        .map((s) => Number(s));
      if (opts.backoff.some((n) => !Number.isFinite(n) || n < 0)) {
        fail(`--backoff takes comma-separated seconds, got ${JSON.stringify(argv[i])}`);
      }
    } else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
    else opts.dirs.push(arg);
  }
  if (!opts.version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(opts.version)) {
    fail(`--version must be a semver version, got ${JSON.stringify(opts.version)}`);
  }
  if (!opts.tag) fail("--tag is required");
  if (opts.dirs.length === 0) fail("no packages given");
  return opts;
}

function fail(message) {
  console.error(`publish: ${message}`);
  process.exit(1);
}

/** Whether name@version is on the registry: `npm view` prints the version only if it is. */
function isPublished(spec, version) {
  const r = spawnSync("npm", ["view", spec, "version", "--prefer-online"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return r.status === 0 && r.stdout.trim().split(/\s+/).includes(version);
}

const opts = parseArgs(process.argv.slice(2));
const attempts = opts.backoff.length + 1;
const missing = [];

for (const dir of opts.dirs) {
  const cwd = join(opts.packagesDir, dir);
  const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  if (manifest.version !== opts.version) {
    console.error(
      `::error::packages/${dir} is at ${manifest.version}, not ${opts.version}; npm publish failed for packages/${dir}`,
    );
    missing.push(dir);
    continue;
  }
  const spec = `${manifest.name}@${opts.version}`;
  if (isPublished(spec, opts.version)) {
    console.log(`${spec} is already on npm, skipping`);
    continue;
  }

  let done = false;
  for (let attempt = 1; attempt <= attempts && !done; attempt++) {
    console.log(`Publishing ${spec} (attempt ${attempt}/${attempts})`);
    const r = spawnSync("npm", ["publish", "--access", "public", "--tag", opts.tag], {
      cwd,
      stdio: "inherit",
    });
    if (r.status === 0) {
      done = true;
    } else if (isPublished(spec, opts.version)) {
      console.log(`${spec} is on npm although npm publish failed (lost response)`);
      done = true;
    } else if (attempt < attempts) {
      const seconds = opts.backoff[attempt - 1];
      console.log(`::warning::npm publish of ${spec} failed; retrying in ${seconds}s`);
      await sleep(seconds * 1000);
    }
  }
  if (!done) {
    console.log(`::error::npm publish failed for packages/${dir}`);
    missing.push(dir);
  }
}

if (missing.length > 0) {
  console.error(`publish: not on npm at ${opts.version}: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`Published ${opts.version} for: ${opts.dirs.join(" ")}`);
