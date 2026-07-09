#!/usr/bin/env node
// scripts/migrate-apps-import.mjs
// Rewrites @decocms/start/* imports to the correct new package per the
// proven mapping in docs/apps-monorepo-migration-plan.md's Global
// Constraints. Usage: node scripts/migrate-apps-import.mjs <dir>
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const MAPPING = [
  ["@decocms/start/cms", "@decocms/blocks/cms"], // client usages fixed up by hand per Global Constraints
  ["@decocms/start/sdk/cachedLoader", "@decocms/blocks/sdk/cachedLoader"],
  ["@decocms/start/sdk/cacheHeaders", "@decocms/blocks/sdk/cacheHeaders"],
  ["@decocms/start/sdk/cookie", "@decocms/blocks/sdk/cookie"],
  ["@decocms/start/sdk/crypto", "@decocms/blocks/sdk/crypto"],
  ["@decocms/start/sdk/instrumentedFetch", "@decocms/blocks/sdk/instrumentedFetch"],
  ["@decocms/start/sdk/invoke", "@decocms/blocks/sdk/invoke"],
  ["@decocms/start/sdk/observability", "@decocms/blocks/sdk/observability"],
  ["@decocms/start/sdk/requestContext", "@decocms/blocks/sdk/requestContext"],
  ["@decocms/start/sdk/retry", "@decocms/blocks/sdk/retry"],
  ["@decocms/start/sdk/signal", "@decocms/blocks/sdk/signal"],
  ["@decocms/start/sdk/useDevice", "@decocms/blocks/sdk/useDevice"],
  ["@decocms/start/sdk/useId", "@decocms/blocks/sdk/useId"],
  ["@decocms/start/sdk/useScript", "@decocms/blocks/sdk/useScript"],
  ["@decocms/start/sdk/useSuggestions", "@decocms/blocks/sdk/useSuggestions"],
  ["@decocms/start/sdk/clx", "@decocms/blocks/sdk/clx"],
  ["@decocms/start/sdk/router", "@decocms/tanstack"],
  ["@decocms/start/routes", "@decocms/tanstack"],
  ["@decocms/start/scripts/generate-invoke", "@decocms/blocks-cli/scripts/generate-invoke"],
];

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node scripts/migrate-apps-import.mjs <dir>");
  process.exit(1);
}

function walk(d) {
  for (const entry of readdirSync(d)) {
    const p = join(d, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      walk(p);
    } else if ([".ts", ".tsx"].includes(extname(p))) {
      let content = readFileSync(p, "utf8");
      let changed = false;
      for (const [oldPath, newPath] of MAPPING) {
        // Match the old specifier only when followed by a non-identifier
        // char (quote, slash) so e.g. "@decocms/start/cms" doesn't
        // false-positive-match inside "@decocms/start/cmsFoo".
        const re = new RegExp(
          oldPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + String.raw`(['"/])`,
          "g",
        );
        if (re.test(content)) {
          content = content.replace(re, `${newPath}$1`);
          changed = true;
        }
      }
      if (changed) {
        writeFileSync(p, content);
        console.log(`rewrote: ${p}`);
      }
    }
  }
}

walk(dir);
console.log("Done. Now grep for any remaining @decocms/start references and fix by hand:");
console.log(`  grep -rn "@decocms/start" ${dir}`);
