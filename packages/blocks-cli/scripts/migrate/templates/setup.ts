import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext } from "../types";

function discoverFonts(ctx: MigrationContext): string[] {
  // Check public/fonts (post-move)
  const fontsDir = path.join(ctx.sourceDir, "public", "fonts");
  if (fs.existsSync(fontsDir)) return scanFontDir(fontsDir);

  // Check static/fonts (pre-move)
  const staticFonts = path.join(ctx.sourceDir, "static", "fonts");
  if (fs.existsSync(staticFonts)) return scanFontDir(staticFonts);

  // Check static-*/fonts/ (multi-brand sites like casaevideo)
  try {
    const entries = fs.readdirSync(ctx.sourceDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith("static-")) {
        const brandFonts = path.join(ctx.sourceDir, e.name, "fonts");
        if (fs.existsSync(brandFonts)) return scanFontDir(brandFonts);
      }
    }
  } catch { /* ignore */ }

  return [];
}

function scanFontDir(dir: string): string[] {
  try {
    const allFonts = fs.readdirSync(dir)
      .filter((f) => /\.(woff2?|ttf|otf|eot)$/i.test(f));

    // Only preload the most critical fonts (Regular + Bold of the primary family).
    // All fonts are still available via @font-face in CSS — this just controls
    // which ones get <link rel="preload"> for faster rendering.
    const critical = allFonts.filter((f) =>
      /[-_](Regular|Bold)\.(woff2?|ttf|otf)$/i.test(f) &&
      !/Italic/i.test(f)
    );

    // If we found critical weights, use those; otherwise take first 2
    const toPreload = critical.length > 0
      ? critical.slice(0, 4) // max 4 preloads
      : allFonts.slice(0, 2);

    return toPreload.map((f) => `/fonts/${f}`);
  } catch {
    return [];
  }
}

function hasMatchers(ctx: MigrationContext): boolean {
  const matchersDir = path.join(ctx.sourceDir, "matchers");
  if (fs.existsSync(matchersDir)) return true;
  const srcMatchers = path.join(ctx.sourceDir, "src", "matchers");
  return fs.existsSync(srcMatchers);
}

export function generateSetup(ctx: MigrationContext): string {
  const isVtex = ctx.platform === "vtex";
  const siteName = ctx.siteName;
  const fonts = discoverFonts(ctx);
  const hasLocationMatcher = hasMatchers(ctx);

  // Build productionOrigins from known domain patterns
  const origins: string[] = [];
  // Check if source has productionOrigins in existing setup files
  const possibleDomains = [
    `www.${siteName}.com.br`,
    `${siteName}.com.br`,
  ];
  for (const domain of possibleDomains) {
    origins.push(`"https://${domain}"`);
  }

  const fontEntries = fonts.length > 0
    ? fonts.map((f) => `"${f}"`).join(", ")
    : "";

  return `/**
 * Site setup — orchestrator that wires framework, commerce, and sections.
 *
 * Actual logic lives in focused modules:
 *   setup/commerce-loaders.ts  — COMMERCE_LOADERS map (VTEX + site data fetchers)
 *   setup/commerce-init.ts     — server-only registration of COMMERCE_LOADERS +
 *                                invoke. Imported by worker-entry.ts, NOT here,
 *                                so the loader/action module graph (and any
 *                                credential in it) never enters the client bundle.
 *   setup/section-loaders.ts   — registerSectionLoaders (per-section prop enrichment)
 *
 * This file IS imported by router.tsx (client) for section registration/hydration,
 * so it must stay free of server-only imports (COMMERCE_LOADERS, invoke, secrets).
 *
 * Section metadata (eager, sync, layout, cache, LoadingFallback) is declared
 * in each section file and auto-extracted by generate-sections.ts.
 */

import "./cache-config";

import { applySectionConventions } from "@decocms/blocks/cms";
import { createSiteSetup } from "@decocms/blocks/setup";${isVtex ? `
import { createInstrumentedFetch } from "@decocms/blocks/sdk/instrumentedFetch";
import { initVtexFromBlocks, setVtexFetch } from "@decocms/apps-vtex";` : ""}${hasLocationMatcher ? `
import { registerLocationMatcher } from "./matchers/location";` : ""}
import { blocks as generatedBlocks } from "../.deco/blocks.gen";
import { sectionMeta, syncComponents, loadingFallbacks } from "../.deco/sections.gen";
import { PreviewProviders } from "@decocms/tanstack";
// @ts-ignore Vite ?url import
import appCss from "./styles/app.css?url";

import "./setup/section-loaders";

// -- Framework setup --
createSiteSetup({
  sections: import.meta.glob("./sections/**/*.tsx") as Record<string, () => Promise<any>>,
  blocks: generatedBlocks,
  meta: () => import("../.deco/meta.gen.json").then((m) => m.default),
  css: appCss,
  fonts: [${fontEntries}],
  productionOrigins: [
    ${origins.join(",\n    ")},
  ],
  previewWrapper: PreviewProviders,${hasLocationMatcher ? `
  customMatchers: [registerLocationMatcher],` : ""}${isVtex ? `
  initPlatform: (blocks) => initVtexFromBlocks(blocks),` : ""}
  onResolveError: (error, resolveType, context) => {
    console.error(\`[CMS-DEBUG] \${context} "\${resolveType}" failed:\`, error);
  },
  onDanglingReference: (resolveType) => {
    console.warn(\`[CMS-DEBUG] Dangling reference: \${resolveType}\`);
    return null;
  },
});
${isVtex ? `
// -- VTEX wiring --
setVtexFetch(createInstrumentedFetch("vtex"));
` : ""}
// -- Convention-driven section registration --
applySectionConventions({
  meta: sectionMeta,
  syncComponents,
  loadingFallbacks,
  sectionGlob: import.meta.glob("./sections/**/*.tsx") as Record<string, () => Promise<any>>,
});

// -- Commerce + invoke --
// Registration lives in setup/commerce-init.ts, imported ONLY by
// src/worker-entry.ts (server). Importing it here would drag COMMERCE_LOADERS —
// and every site loader/action module it references — into the client bundle.
`;
}
