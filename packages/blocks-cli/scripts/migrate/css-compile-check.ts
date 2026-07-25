/**
 * Real Tailwind v4 CSS compilation, run as part of phase-compile.
 *
 * Every other CSS-migration transform is a heuristic (regex renames,
 * static tailwind.config.ts extraction, best-effort oklch fixes). This is
 * the safety net: it actually compiles `src/styles/app.css` with the
 * site's own installed `tailwindcss` via the official `@tailwindcss/cli`,
 * so an unknown-utility-class error (the exact failure mode of
 * decocms/blocks#369 / skill gotcha #48) surfaces during migration instead
 * of at runtime in the browser.
 *
 * Uses the CLI (not `@tailwindcss/node`'s internal compile() API) on
 * purpose — it's the officially documented, version-stable entry point,
 * where the internal package APIs are not.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CompileRunResult } from "./phase-compile";
import type { MigrationContext } from "./types";

export interface CssCompileResult {
  ran: boolean;
  passed: boolean;
  output?: string;
  /** Best-effort warnings — classes used in src/ that don't appear as selectors in the compiled CSS. Never fails the build. */
  unmatchedClassWarnings: string[];
}

const APP_CSS_REL_PATH = "src/styles/app.css";

/**
 * Compile `src/styles/app.css` with the site's own Tailwind v4 install.
 * No-ops (ran: false) if the file or `@tailwindcss/cli` isn't present —
 * callers should treat that the same as "nothing to check", not a failure.
 */
export function checkCssCompiles(
  ctx: Pick<MigrationContext, "sourceDir">,
  runner: (cmd: string, cwd: string) => CompileRunResult,
): CssCompileResult {
  const cssPath = path.join(ctx.sourceDir, APP_CSS_REL_PATH);
  if (!fs.existsSync(cssPath)) {
    return { ran: false, passed: true, unmatchedClassWarnings: [] };
  }

  const outPath = path.join(
    os.tmpdir(),
    `deco-migrate-css-check-${process.pid}-${Date.now()}.css`,
  );

  try {
    const result = runner(
      `npx @tailwindcss/cli -i ${APP_CSS_REL_PATH} -o ${outPath}`,
      ctx.sourceDir,
    );

    if (!result.ok) {
      return { ran: true, passed: false, output: result.output, unmatchedClassWarnings: [] };
    }

    let unmatchedClassWarnings: string[] = [];
    try {
      const compiledCss = fs.readFileSync(outPath, "utf-8");
      unmatchedClassWarnings = scanUnmatchedUtilityClasses(ctx.sourceDir, compiledCss);
    } catch {
      // Coverage scan is best-effort only — never let it fail the check.
    }

    return { ran: true, passed: true, unmatchedClassWarnings };
  } finally {
    try {
      fs.rmSync(outPath, { force: true });
    } catch {
      // tmp cleanup best-effort
    }
  }
}

const CLASS_ATTR_RE = /(?:className|class)\s*=\s*"([^"]+)"/g;

/**
 * Best-effort cross-check: className tokens used in src/ that don't show
 * up as a CSS selector anywhere in the compiled output. Purely
 * informational — dynamic class construction (template literals, `clx()`
 * with variables, conditional classes) produces false positives here, so
 * this never fails the migration, only surfaces warnings for a human to
 * triage.
 */
function scanUnmatchedUtilityClasses(sourceDir: string, compiledCss: string): string[] {
  const srcDir = path.join(sourceDir, "src");
  if (!fs.existsSync(srcDir)) return [];

  const usedClasses = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(tsx|ts)$/.test(entry.name)) continue;
      const content = fs.readFileSync(full, "utf-8");
      let m: RegExpExecArray | null;
      const re = new RegExp(CLASS_ATTR_RE);
      while ((m = re.exec(content)) !== null) {
        for (const cls of m[1].split(/\s+/).filter(Boolean)) {
          usedClasses.add(cls);
        }
      }
    }
  };
  walk(srcDir);

  const warnings: string[] = [];
  for (const cls of usedClasses) {
    // Only cross-check plain word/hyphen tokens (no variants, arbitrary
    // values, opacity modifiers, or template-interpolated fragments) —
    // Tailwind v4 escapes those characters in the compiled selector
    // (`.hover\:underline`, `.bg-black\/20`), which would make a naive
    // string match unreliable. Plain tokens are exactly the case that
    // matters most here: a dropped custom color/font/component class
    // (e.g. `font-bebas-neue`, `container-pdp`) compiles to nothing,
    // silently, with no error from the CLI.
    if (/[:\[\]{}$/.]/.test(cls)) continue;
    const selectorRe = new RegExp(`\\.${cls}(?:[^\\w-]|$)`);
    if (!selectorRe.test(compiledCss)) {
      warnings.push(cls);
    }
  }

  return warnings.sort();
}
