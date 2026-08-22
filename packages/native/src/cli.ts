#!/usr/bin/env -S npx tsx
/**
 * `deco-native` — the CLI half of the binding.
 *
 * Two commands, both thin on purpose:
 *   init      wire an existing Expo app to a Deco site
 *   generate  run the site's codegen with --platform native
 *
 * It deliberately does not scaffold an Expo app. `create-expo-app` does that
 * better, and an init that owns your app is an init you fight later.
 */

import { runNativeInit } from "./init";

function flag(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

const USAGE = `deco-native — Deco binding for React Native / Expo

Usage:
  deco-native init [--site ..] [--lib-dir lib] [--root .]
      Wire an existing Expo app to a Deco site. Never overwrites a file.

  deco-native generate [flags]
      Run the site's codegen with --platform native. Run this in the SITE,
      not the app. Forwards every @decocms/blocks-cli generate flag.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return 0;
  }

  if (command === "init") {
    const result = runNativeInit({
      root: flag(rest, "root"),
      site: flag(rest, "site"),
      libDir: flag(rest, "lib-dir"),
    });

    for (const file of result.created) console.log(`  created  ${file}`);
    for (const file of result.skipped) console.log(`  exists   ${file} (left alone)`);
    if (result.next.length > 0) {
      console.log("\nNext:");
      for (const item of result.next) console.log(`  - ${item}`);
    }
    return 0;
  }

  if (command === "generate") {
    // Imported lazily: blocks-cli is only needed for this command, and it is a
    // heavy ts-morph dependency.
    const { runGenerate } = await import("@decocms/blocks-cli/generate");
    const args = rest.includes("--platform") ? rest : ["--platform", "native", ...rest];
    return runGenerate(args);
  }

  console.error(`Unknown command: ${command}\n`);
  console.log(USAGE);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
