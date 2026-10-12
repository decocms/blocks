#!/usr/bin/env node
// Runs the TypeScript 7 native compiler (`typescript7`, an npm alias of
// typescript@7 in the root devDependencies) with the given arguments.
//
// The alias exists because the plain `typescript` name has to stay on 5.x in
// this workspace: TypeScript 7 ships no JavaScript compiler API, and
// `deco schema` (plus Next's type-check and a few conformance tests) load the
// app's `typescript` through that API. Builds and type-checks run on 7;
// whatever imports "typescript" keeps getting 5.x.
//
// `--clean <dir>` removes <dir> first, so a build never ships output for a
// source file that was deleted or renamed.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const clean = args.indexOf("--clean");
if (clean !== -1) {
  rmSync(args[clean + 1], { recursive: true, force: true });
  args.splice(clean, 2);
}

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript7/package.json")), "bin/tsc");
const result = spawnSync(process.execPath, [tsc, ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
