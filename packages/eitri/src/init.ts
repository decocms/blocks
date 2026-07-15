/**
 * `deco-eitri init` — scaffold the two files an Eitri app needs to generate a
 * `.deco`, without touching anything that already exists (idempotent):
 *
 *   1. `tsconfig.json` extending `@decocms/eitri/tsconfig` — required by
 *      generate-schema (ts-morph needs a tsconfig to build the program).
 *   2. `src/eitri-env.d.ts` — a copy of the eitri-luminus/bifrost ambient
 *      shims, dropped inside `src/` so the app's `include: ["src"]` picks it up
 *      with no node_modules path gymnastics. Purely editor/tsc ergonomics —
 *      generation works without it.
 *
 * Never overwrites an existing file, so it's safe to re-run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface EitriInitOptions {
  /** App root to scaffold into. Defaults to process.cwd(). */
  root?: string;
}

export interface EitriInitResult {
  /** Files created this run (relative to root). */
  created: string[];
  /** Files that already existed and were left untouched (relative to root). */
  skipped: string[];
}

const APP_TSCONFIG = `${JSON.stringify(
  {
    extends: "@decocms/eitri/tsconfig",
    include: ["src"],
  },
  null,
  2,
)}\n`;

/** Absolute path to the packaged ambient shim (../types/eitri-luminus.d.ts). */
function packagedShimPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "types", "eitri-luminus.d.ts");
}

export function runEitriInit(opts: EitriInitOptions = {}): EitriInitResult {
  const root = path.resolve(opts.root ?? process.cwd());
  const created: string[] = [];
  const skipped: string[] = [];

  const write = (rel: string, contents: string) => {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) {
      skipped.push(rel);
      return;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
    created.push(rel);
  };

  write("tsconfig.json", APP_TSCONFIG);

  // Copy the shim content (not a reference) so the app file is self-contained
  // and immune to node_modules path resolution quirks.
  const shim = fs.readFileSync(packagedShimPath(), "utf-8");
  write(path.join("src", "eitri-env.d.ts"), shim);

  return { created, skipped };
}
