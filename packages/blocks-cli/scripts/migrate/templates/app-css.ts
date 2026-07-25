import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext } from "../types";
import { log } from "../types";
import type { ExtractedTheme } from "../analyzers/theme-extractor";
import { fixOklchHexMismatches, isOklchCoordinates } from "../transforms/color-oklch";
import { transformCss } from "../transforms/css";
import { CLASS_RENAMES, DAISYUI_RENAMES } from "../transforms/tailwind-renames";

/**
 * Find the original site's custom CSS file.
 * Deco sites typically have their custom CSS in:
 * - tailwind.css (root level, combined directives + custom)
 * - static/tailwind.css (compiled output — skip this)
 * - static-{brand}/tailwind.css (compiled output — skip this)
 * - styles/*.css
 */
function findOriginalCss(ctx: MigrationContext): string | null {
  // Prefer root tailwind.css (has custom CSS + directives)
  const rootCss = path.join(ctx.sourceDir, "tailwind.css");
  if (fs.existsSync(rootCss)) {
    return fs.readFileSync(rootCss, "utf-8");
  }

  // Check for styles/ directory
  const stylesDir = path.join(ctx.sourceDir, "styles");
  if (fs.existsSync(stylesDir)) {
    for (const file of fs.readdirSync(stylesDir)) {
      if (file.endsWith(".css") && file !== "tailwind.css") {
        return fs.readFileSync(path.join(stylesDir, file), "utf-8");
      }
    }
  }

  return null;
}

/**
 * Extract custom CSS from the original site's CSS file.
 * Strips TW3 directives (@tailwind base/components/utilities) and
 * returns only the custom CSS (component overrides, @layer, @font-face, etc.)
 */
function extractCustomCss(rawCss: string): string {
  return rawCss
    // Remove Tailwind v3 directives (replaced by @import "tailwindcss")
    .replace(/^@tailwind\s+(?:base|components|utilities)\s*;\s*$/gm, "")
    // Remove empty lines left over
    .replace(/^\s*\n/gm, "")
    .trim();
}

/**
 * Transform @apply directives for TW3→TW4 compatibility.
 * The tailwind.ts transform handles className= attributes in JSX,
 * but @apply inside CSS also needs the same class renames — reuses the
 * single shared table (transforms/tailwind-renames.ts) so this never
 * drifts from the className= rewriter again.
 */
function transformApplyDirectives(css: string): string {
  return css.replace(/@apply\s+([^;]+);/g, (_match, classes: string) => {
    const fixed = classes
      .split(/\s+/)
      .filter(Boolean)
      .map((cls) => {
        if (CLASS_RENAMES[cls] !== undefined) return CLASS_RENAMES[cls];
        if (DAISYUI_RENAMES[cls] !== undefined) return DAISYUI_RENAMES[cls];
        return cls;
      })
      .filter(Boolean)
      .join(" ");
    return `@apply ${fixed};`;
  });
}

/**
 * Extract the primary font family from @font-face declarations in CSS.
 * Returns the first font-family name found, or null.
 */
function extractPrimaryFontFromCss(css: string): string | null {
  const fontFaceRe = /@font-face\s*\{[^}]*font-family:\s*["']?([^"';]+)["']?\s*;/g;
  const families = new Set<string>();
  let match;
  while ((match = fontFaceRe.exec(css)) !== null) {
    families.add(match[1].trim());
  }
  if (families.size === 0) return null;
  // Prefer non-icon fonts
  const nonIcon = [...families].filter(
    (f) => !/icon|awesome|material/i.test(f),
  );
  return nonIcon[0] || [...families][0];
}

export function generateAppCss(ctx: MigrationContext, theme?: ExtractedTheme): string {
  const sections: string[] = [];

  // ── DaisyUI theme plugin ──────────────────────────────────────────
  const daisyColors = theme?.daisyUiColors ?? {};
  const c = ctx.themeColors;

  const semanticColors: Record<string, string> = {
    "--color-primary": daisyColors["--color-primary"] || c["primary"] || "#B10200",
    "--color-secondary": daisyColors["--color-secondary"] || c["secondary"] || "#141414",
    "--color-accent": daisyColors["--color-accent"] || c["tertiary"] || "#FFF100",
    "--color-neutral": daisyColors["--color-neutral"] || c["neutral"] || "#393939",
    "--color-base-100": daisyColors["--color-base-100"] || c["base-100"] || "#FFFFFF",
    "--color-base-200": daisyColors["--color-base-200"] || c["base-200"] || "#F3F3F3",
    "--color-base-300": daisyColors["--color-base-300"] || c["base-300"] || "#868686",
    "--color-info": daisyColors["--color-info"] || c["info"] || "#006CA1",
    "--color-success": daisyColors["--color-success"] || c["success"] || "#007552",
    "--color-warning": daisyColors["--color-warning"] || c["warning"] || "#F8D13A",
    "--color-error": daisyColors["--color-error"] || c["error"] || "#CF040A",
  };

  const colorLines = Object.entries(semanticColors)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");

  sections.push(`@import "tailwindcss";
@plugin "daisyui";
@plugin "daisyui/theme" {
  name: "light";
  default: true;
  color-scheme: light;
${colorLines}
}`);

  // ── @theme block: Tailwind v3->v4 color migration ─────────────────
  // Determine font family from theme, context, or original CSS @font-face
  let fontFamily = theme?.fontFamily || ctx.fontFamily;
  if (!fontFamily) {
    const originalCssForFont = findOriginalCss(ctx);
    if (originalCssForFont) {
      const extracted = extractPrimaryFontFromCss(originalCssForFont);
      if (extracted) fontFamily = extracted;
    }
  }
  let fontLine = "";
  if (fontFamily) {
    const firstFont = fontFamily.split(",")[0].trim().replace(/['"]/g, "");
    fontLine = `\n  --font-sans: "${firstFont}", ui-sans-serif, system-ui, sans-serif;`;
  }

  let themeBlock = `/* Tailwind v4: reset default palette (old sites replaced it entirely via theme.colors)
   then re-add only the colors used by this site. */
@theme {
  --color-*: initial;

  --color-white: #fff;
  --color-black: #000;
  --color-transparent: transparent;
  --color-current: currentColor;
  --color-inherit: inherit;${fontLine}`;

  // Add extracted theme variables to @theme
  // Theme variables come from the CMS Theme section (.deco/blocks/Theme-*.json).
  // The CMS sets CSS custom properties on :root at runtime, so @theme entries
  // should reference var(--x) instead of hardcoding values. For oklch-formatted
  // values (space-separated numbers like "0.5 0.2 30"), wrap with oklch().
  const vars = theme?.variables ?? {};
  if (Object.keys(vars).length > 0) {
    themeBlock += `\n`;
    const grouped: Record<string, Array<[string, string]>> = {};
    for (const [k, v] of Object.entries(vars)) {
      const prefix = k.replace(/^--/, "").split("-").slice(0, 2).join("-");
      if (!grouped[prefix]) grouped[prefix] = [];
      grouped[prefix].push([k, v]);
    }

    for (const [prefix, entries] of Object.entries(grouped)) {
      themeBlock += `\n  /* ${prefix} */`;
      for (const [k, v] of entries) {
        if (!k.startsWith("--color-") && !k.startsWith("--font-") && !k.startsWith("--breakpoint-")) {
          const val = v.trim();
          const isColor = /^#[0-9a-fA-F]{3,8}$/.test(val) ||
            /^(rgb|hsl|oklch|oklab)\(/.test(val) ||
            /^(transparent|currentColor|inherit)$/.test(val) ||
            isOklchCoordinates(val);
          if (isColor) {
            const varName = k.replace(/^--/, "");
            const colorKey = `--color-${varName}`;
            if (isOklchCoordinates(val)) {
              themeBlock += `\n  ${colorKey}: oklch(var(${k}));`;
            } else {
              themeBlock += `\n  ${colorKey}: var(${k});`;
            }
          }
        }
      }
    }
  }

  // Port theme.extend.colors / theme.extend.fontFamily / theme.extend.screens
  // from the source site's tailwind.config.ts (extracted in phase-analyze
  // before that file is deleted — see analyzers/tailwind-config.ts). Without
  // this, custom brand palettes and named font stacks are silently dropped
  // and any class referencing them (`bg-perola`, `font-bebas-neue`) makes
  // Tailwind v4 throw "Cannot apply unknown utility class" (decocms/blocks#369).
  const twColors = ctx.tailwindConfig.colors;
  const twColorKeys = Object.keys(twColors).filter((k) => !(`--color-${k}` in semanticColors));
  if (twColorKeys.length > 0) {
    themeBlock += `\n\n  /* Custom colors ported from tailwind.config.ts */`;
    for (const key of twColorKeys) {
      themeBlock += `\n  --color-${key}: ${twColors[key]};`;
    }
  }

  const twFontFamily = ctx.tailwindConfig.fontFamily;
  const twFontKeys = Object.keys(twFontFamily);
  if (twFontKeys.length > 0) {
    themeBlock += `\n\n  /* Font stacks ported from tailwind.config.ts */`;
    for (const key of twFontKeys) {
      themeBlock += `\n  --font-${key}: ${twFontFamily[key]};`;
    }
  }

  const twScreens = ctx.tailwindConfig.screens;
  const twScreenKeys = Object.keys(twScreens);
  if (twScreenKeys.length > 0) {
    themeBlock += `\n\n  /* Custom breakpoints ported from tailwind.config.ts */`;
    for (const key of twScreenKeys) {
      themeBlock += `\n  --breakpoint-${key}: ${twScreens[key]};`;
    }
  }

  // Gray scale compat (Tailwind v3 had gray-50..gray-950 by default)
  themeBlock += `

  /* Gray scale (Tailwind v3 default, required for bg-gray-*, text-gray-*, etc.) */
  --color-gray-50: #f9fafb;
  --color-gray-100: #f3f4f6;
  --color-gray-200: #e5e7eb;
  --color-gray-300: #d1d5db;
  --color-gray-400: #9ca3af;
  --color-gray-500: #6b7280;
  --color-gray-600: #4b5563;
  --color-gray-700: #374151;
  --color-gray-800: #1f2937;
  --color-gray-900: #111827;
  --color-gray-950: #030712;
}`;
  sections.push(themeBlock);

  // ── DaisyUI v5 compat ─────────────────────────────────────────────
  sections.push(`/* DaisyUI v5: flatten depth/noise to match v4 look */
:root {
  --depth: 0;
  --noise: 0;
}`);

  // ── :root theme variables ─────────────────────────────────────────
  if (Object.keys(vars).length > 0) {
    let rootBlock = `:root {\n`;
    for (const [k, v] of Object.entries(vars)) {
      rootBlock += `  ${k}: ${v};\n`;
    }
    if (fontFamily) {
      const firstFont = fontFamily.split(",")[0].trim().replace(/['"]/g, "");
      rootBlock += `  --font-family: ${firstFont}, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;\n`;
    }
    rootBlock += `}`;
    sections.push(rootBlock);
  }

  // ── DaisyUI v5 carousel overflow fix ──────────────────────────────
  sections.push(`/* DaisyUI v5 removed carousel overflow — re-add for horizontal scroll */
.carousel {
  -webkit-overflow-scrolling: touch;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scroll-behavior: smooth;
}

.carousel > * {
  scroll-snap-align: start;
}

ul.carousel,
ol.carousel {
  list-style: none;
  padding: 0;
}`);

  // ── Container utility (v3 -> v4 migration) ────────────────────────
  sections.push(`/* Container: replaces Tailwind v3 container plugin config */
@utility container {
  margin-inline: auto;
  padding-inline: 1rem;
  width: 100%;

  @media (width >= 640px) { max-width: 640px; }
  @media (width >= 768px) { max-width: 768px; }
  @media (width >= 1024px) { max-width: 1024px; }
  @media (width >= 1280px) { max-width: 1280px; }
  @media (width >= 1536px) { max-width: 1536px; }
}`);

  // ── Deferred section visibility ───────────────────────────────────
  sections.push(`/* Deferred section visibility — reduces layout shift while loading */
section[data-deferred="true"] {
  content-visibility: auto;
  contain-intrinsic-size: auto 300px;
}

.deferred-section {
  content-visibility: auto;
  contain-intrinsic-size: auto 300px;
}`);

  // ── View transitions ──────────────────────────────────────────────
  sections.push(`@view-transition {
  navigation: auto;
}`);

  // ── Base layer resets ─────────────────────────────────────────────
  sections.push(`@layer base {
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  body {
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  img,
  picture,
  video,
  canvas,
  svg {
    display: block;
    max-width: 100%;
  }

  /* Drawer / modal scroll lock */
  body:has(dialog[open]),
  body:has(.drawer-toggle:checked) {
    overflow: hidden;
  }

  /* Tailwind v3 → v4 compat: restore the default cursor:pointer on interactive
     elements. Tailwind v4 dropped this from Preflight, leaving Fresh-era sites
     with hundreds of buttons looking unclickable. See:
     https://tailwindcss.com/docs/upgrade-guide#default-button-cursor */
  button:not(:disabled),
  [role="button"]:not([aria-disabled="true"]),
  label[for],
  summary {
    cursor: pointer;
  }
  button:disabled,
  [role="button"][aria-disabled="true"] {
    cursor: not-allowed;
  }
}`);

  // ── Scrollbar utility ─────────────────────────────────────────────
  sections.push(`.scrollbar-none {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.scrollbar-none::-webkit-scrollbar {
  display: none;
}`);

  // ── Safelist (tailwind.config.ts) ──────────────────────────────────
  // Tailwind v4 has no config-based safelist. Literal class names port
  // directly to `@source inline(...)`; regex patterns can't be converted
  // automatically and are flagged for manual review instead.
  const safelist = ctx.tailwindConfig.safelist;
  if (safelist.length > 0) {
    sections.push(`/* Safelist ported from tailwind.config.ts (Tailwind v4 has no config safelist) */
@source inline("${safelist.join(" ")}");`);
  }
  for (const pattern of ctx.tailwindConfig.safelistPatterns) {
    ctx.manualReviewItems.push({
      file: "src/styles/app.css",
      reason: `tailwind.config.ts safelist pattern ${pattern} cannot be auto-converted — add the matching classes via @source inline("...") manually (Tailwind v4 has no regex safelist)`,
      severity: "warning",
    });
  }

  // ── Incorporate original site's custom CSS ────────────────────
  // Instead of throwing away the site's CSS, we extract and append
  // all custom rules (component overrides, @layer base, @font-face,
  // typography utilities, feature-specific CSS, etc.)
  const originalCss = findOriginalCss(ctx);
  if (originalCss) {
    const customCss = extractCustomCss(originalCss);
    if (customCss) {
      let transformed = transformApplyDirectives(customCss);
      const cssFix = transformCss(transformed);
      transformed = cssFix.css;
      for (const note of cssFix.notes) {
        if (note.startsWith("MANUAL:")) {
          ctx.manualReviewItems.push({
            file: "src/styles/app.css",
            reason: note.replace(/^MANUAL:\s*/, ""),
            severity: "warning",
          });
        } else {
          log(ctx, `[app.css] ${note}`);
        }
      }
      sections.push(`/* ═══════════════════════════════════════════════════════════════
   Original site CSS (migrated from tailwind.css)
   ═══════════════════════════════════════════════════════════════ */

${transformed}`);
    }
  }

  const rawCss = sections.join("\n\n") + "\n";

  // Fix gotcha #43: `oklch(var(--x))` is emitted wherever a CMS theme var
  // looked like bare oklch coordinates, but if that var was actually
  // declared as hex elsewhere, the wrapper is invalid CSS (icons/fills
  // silently render black). Convert the hex declaration to an oklch triplet
  // so the wrapper stays valid.
  const { css: fixedCss, fixed, flagged } = fixOklchHexMismatches(rawCss);
  for (const note of fixed) {
    log(ctx, `[app.css] Fixed oklch/hex mismatch: ${note}`);
  }
  for (const note of flagged) {
    ctx.manualReviewItems.push({
      file: "src/styles/app.css",
      reason: note,
      severity: "warning",
    });
  }

  return fixedCss;
}
