#!/usr/bin/env tsx
/**
 * `deco-eitri` — CLI for producing a Studio-ready `.deco` from an Eitri app.
 *
 *   deco-eitri init [--root <dir>]
 *       Scaffold tsconfig.json (+ src/eitri-env.d.ts shim). Idempotent.
 *
 *   deco-eitri generate [--root <dir>] [--force] [any generate flags]
 *       Run the blocks-cli orchestrator with --platform eitri: emits a
 *       self-contained .deco/meta.gen.json + the .deco/blocks.gen.json
 *       snapshot, skipping the React-runtime generators.
 *
 * `generate` forwards every flag through to @decocms/blocks-cli's `generate`
 * (see `deco-eitri generate --help`), only ensuring --platform eitri is set.
 */
import { runGenerate } from "@decocms/blocks-cli/generate";
import { runEitriInit } from "./init";

const USAGE = `\
deco-eitri — produce a Studio-ready .deco for an Eitri app

Usage:
  deco-eitri init [--root <dir>]
      Scaffold tsconfig.json (extends @decocms/eitri/tsconfig) and a
      src/eitri-env.d.ts shim. Never overwrites existing files.

  deco-eitri generate [--root <dir>] [--force] [...generate flags]
      Generate .deco (self-contained meta.gen.json + blocks.gen.json snapshot)
      with --platform eitri. All @decocms/blocks-cli generate flags are
      forwarded; run \`deco-eitri generate --help\` for the full list.
`;

/** Pull `--root <dir>` out of an argv slice (used by init). */
function valueFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  if (command === "init") {
    const { created, skipped } = runEitriInit({ root: valueFlag(rest, "--root") });
    for (const f of created) console.log(`[deco-eitri] created ${f}`);
    for (const f of skipped) console.log(`[deco-eitri] skipped ${f} (already exists)`);
    console.log(
      created.length
        ? "[deco-eitri] init done — run `deco-eitri generate` to produce .deco"
        : "[deco-eitri] init: nothing to do (already set up)",
    );
    return 0;
  }

  if (command === "generate") {
    // Forward everything to the orchestrator, guaranteeing --platform eitri.
    const args = rest.includes("--platform") ? rest : ["--platform", "eitri", ...rest];
    return runGenerate(args);
  }

  console.error(`[deco-eitri] unknown command "${command}"\n`);
  console.error(USAGE);
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
