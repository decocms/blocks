import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSectionConventions } from "./config";
import type { MigrationContext, TransformResult, SectionMeta } from "./types";
import { log, logPhase } from "./types";
import { transformImports } from "./transforms/imports";
import { transformJsx } from "./transforms/jsx";
import { transformFreshApis } from "./transforms/fresh-apis";
import { transformCtxCompat } from "./transforms/ctx-compat";
import { transformDenoIsms } from "./transforms/deno-isms";
import { transformTailwind } from "./transforms/tailwind";
import { transformDeadCode } from "./transforms/dead-code";
import { transformHtmxOnEvents } from "./transforms/htmx-on-events";
import { createSectionConventionsTransform } from "./transforms/section-conventions";

/** Map of section path → metadata, populated per-run */
let sectionMetaMap: Map<string, SectionMeta> | null = null;

function getSectionMeta(ctx: MigrationContext, relPath: string): SectionMeta | undefined {
  if (!sectionMetaMap) {
    sectionMetaMap = new Map();
    for (const m of ctx.sectionMetas) {
      sectionMetaMap.set(m.path, m);
    }
  }
  return sectionMetaMap.get(relPath);
}

/**
 * Cached per-run section-conventions closure. Built once from the
 * resolved config sets (`ctx.config.sectionConventions`), so casaevideo
 * defaults still apply when no config file exists.
 */
let cachedSectionTransform:
  | ReturnType<typeof createSectionConventionsTransform>
  | null = null;

function getSectionConventionsTransform(ctx: MigrationContext) {
  if (cachedSectionTransform) return cachedSectionTransform;
  const sets = resolveSectionConventions(ctx.config ?? null);
  cachedSectionTransform = createSectionConventionsTransform(sets);
  return cachedSectionTransform;
}

/**
 * Apply all transforms to a file's content in the correct order.
 */
function applyTransforms(content: string, filePath: string, ctx?: MigrationContext, relPath?: string): TransformResult {
  const allNotes: string[] = [];
  let currentContent = content;
  let anyChanged = false;

  // Only transform code files
  const ext = path.extname(filePath);
  if (![".ts", ".tsx"].includes(ext)) {
    return { content, changed: false, notes: [] };
  }

  // Pipeline: imports → jsx → htmx-on-events → fresh-apis → ctx-compat → dead-code → deno-isms → tailwind
  // htmx-on-events runs after jsx (which renames class/onChange) and
  // before fresh-apis (which removes useScript imports the htmx
  // codemod's TODO might still reference). The codemod is a no-op on
  // files without hx-on, so it never adds latency to non-htmx sites.
  // ctx-compat runs after fresh-apis so it sees the settled loader body; it's
  // a no-op on files without a `loader` export (#305).
  const pipeline: Array<{ name: string; fn: (content: string) => TransformResult }> = [
    { name: "imports", fn: (c) => transformImports(c, ctx?.islandWrapperTargets) },
    { name: "jsx", fn: transformJsx },
    { name: "htmx-on-events", fn: transformHtmxOnEvents },
    { name: "fresh-apis", fn: transformFreshApis },
    { name: "ctx-compat", fn: transformCtxCompat },
    { name: "dead-code", fn: (c) => transformDeadCode(c, ctx?.platform) },
    { name: "deno-isms", fn: transformDenoIsms },
    { name: "tailwind", fn: transformTailwind },
  ];

  for (const step of pipeline) {
    const result = step.fn(currentContent);
    if (result.changed) {
      anyChanged = true;
      currentContent = result.content;
      allNotes.push(...result.notes.map((n) => `[${step.name}] ${n}`));
    }
  }

  // Section conventions (sync/eager/layout/cache) — only for section files
  if (ctx && relPath && relPath.startsWith("sections/")) {
    const meta = getSectionMeta(ctx, relPath);
    // Build the closure once per ctx, cache it on the context.
    const sectionTransform = getSectionConventionsTransform(ctx);
    const result = sectionTransform(currentContent, meta);
    if (result.changed) {
      anyChanged = true;
      currentContent = result.content;
      allNotes.push(...result.notes.map((n) => `[section-conventions] ${n}`));
    }
  }

  return { content: currentContent, changed: anyChanged, notes: allNotes };
}

export function transform(ctx: MigrationContext): void {
  logPhase("Transform");

  const toTransform = ctx.files.filter((f) => f.action === "transform");
  console.log(`  Files to transform: ${toTransform.length}`);

  for (const record of toTransform) {
    const { absPath, targetPath } = record;
    if (!targetPath) continue;

    // Read source
    const content = fs.readFileSync(absPath, "utf-8");

    // Apply transforms
    const result = applyTransforms(content, absPath, ctx, record.path);

    // Fix section re-exports from wrapper islands — point to the wrapped component
    const resolvedTarget = (record as any).__resolvedReExportTarget;
    if (resolvedTarget && result.content.includes("~/components/")) {
      // The import transform rewrote $store/islands/X → ~/components/X
      // but for wrapper islands, the actual component is at a different path
      const reExportRe = /from\s+"~\/components\/[^"]+"/g;
      result.content = result.content.replace(reExportRe, `from "${resolvedTarget}"`);
      result.notes.push(`Re-export resolved to wrapper target: ${resolvedTarget}`);
      result.changed = true;
    }

    // Add manual review items
    for (const note of result.notes) {
      if (note.startsWith("[") && note.includes("MANUAL:")) {
        ctx.manualReviewItems.push({
          file: targetPath,
          reason: note,
          severity: "warning",
        });
      }
    }

    // Flag files with HTMX patterns for manual React migration
    if (/\bhx-(?:get|post|put|delete|trigger|target|swap|on|indicator|sync|select)\b/.test(result.content)) {
      ctx.manualReviewItems.push({
        file: targetPath,
        reason: "HTMX attributes (hx-*) found — needs manual migration to React state/effects. HTMX server-side rendering (hx-get/hx-post with useSection) must be converted to React components with useState/useEffect or server functions.",
        severity: "warning",
      });
    }

    // Flag usePartialSection (Fresh load-more / "Ver mais" pattern) with an
    // actionable useLoadMore recipe instead of a generic HTMX warning.
    if (/usePartialSection/.test(result.content)) {
      const hasAppend = /mode\s*:\s*["']append["']/.test(result.content);
      ctx.manualReviewItems.push({
        file: targetPath,
        reason:
          `usePartialSection${hasAppend ? " (mode:append)" : ""} detected — ` +
          "this is the Fresh load-more / \"Ver mais\" pagination pattern. " +
          "In TanStack it is a no-op stub; the button navigates replacing all products instead of appending. " +
          "Convert to useLoadMore from @decocms/blocks/hooks:\n\n" +
          '  import { useLoadMore } from "@decocms/blocks/hooks"\n\n' +
          '  // At the top of your component (must be "use client"):\n' +
          "  const { pages, loadMore, loading, hasMore } = useLoadMore(\n" +
          "    props.page ?? { products: [], pageInfo: {} },\n" +
          '    "LOADER_KEY" // replace with your loader path, e.g.\n' +
          '    // "apps/vtex.ts/loaders/intelligentSearch/productListingPage.ts"\n' +
          "  )\n" +
          "  const allProducts = pages.flatMap(p => p.products ?? [])\n\n" +
          "  // Replace the usePartialSection anchor/button with:\n" +
          "  {hasMore && (\n" +
          '    <button onClick={loadMore} disabled={loading}>\n' +
          '      {loading ? "Carregando..." : "Ver mais"}\n' +
          "    </button>\n" +
          "  )}\n\n" +
          "Add \"use client\" to the top of the file. " +
          "See deco-to-tanstack-migration skill, 'Ver mais / Load More' section.",
        severity: "warning",
      });
    }

    // Flag files with hx-on:click that use useScript (simpler pattern)
    if (/hx-on:click=\{useScript/.test(result.content)) {
      ctx.manualReviewItems.push({
        file: targetPath,
        reason: "hx-on:click with useScript found — convert to onClick with React event handler. The useScript serialization won't work as onClick value.",
        severity: "warning",
      });
    }

    // Flag the legacy sections/Component.tsx dynamic-section loader.
    // This file uses Deno-specific APIs (toFileUrl, import.meta.resolve)
    // and the HTMX-driven `useComponent(component, props)` pattern, which
    // do not run on Cloudflare Workers and have no equivalent in
    // @decocms/blocks. The whole file must be deleted.
    if (
      /sections\/Component\.tsx?$/.test(record.path) ||
      /sections\/Component\.tsx?$/.test(targetPath)
    ) {
      ctx.manualReviewItems.push({
        file: targetPath,
        reason:
          "sections/Component.tsx (Deno HTMX dynamic-section loader) is incompatible with TanStack Start / Cloudflare Workers. " +
          "DELETE this file and migrate every `useComponent(...)` call site to one of: " +
          "(a) local React state for client-side toggles, " +
          "(b) `createServerFn` + `useMutation` for server actions, or " +
          "(c) a direct `invoke` call (`~/server/invoke`) for ad-hoc loaders. " +
          "See: deco-to-tanstack-migration skill, 'useComponent / partial sections' section.",
        severity: "error",
      });
    }

    // Flag any import of useComponent — typically `import { useComponent } from "site/sections/Component.tsx"`.
    // We also catch `from "../../sections/Component"` and similar relative variants.
    if (
      /\buseComponent\b/.test(result.content) &&
      /from\s+["'][^"']*sections\/Component(?:\.tsx?)?["']/.test(result.content)
    ) {
      ctx.manualReviewItems.push({
        file: targetPath,
        reason:
          "useComponent({ ... }) call site detected. This is the HTMX-style dynamic-section render pattern " +
          "that ships HTML fragments and swaps them client-side. It does not work on TanStack Start. " +
          "Recipes: " +
          "(1) Self-contained UI toggles → keep state in React (`useState` + event handlers); " +
          "(2) Form submissions / mutations → `createServerFn` + `useMutation` (see casaevideo-storefront for canonical examples); " +
          "(3) Ad-hoc data fetches → call the loader/action via `~/server/invoke` and store results in `useState`. " +
          "Remove the import after refactoring, then delete `src/sections/Component.tsx`.",
        severity: "error",
      });
    }

    if (ctx.dryRun) {
      if (result.changed) {
        log(ctx, `[DRY] Would transform: ${record.path} → ${targetPath}`);
        for (const note of result.notes) {
          log(ctx, `       ${note}`);
        }
      }
      ctx.transformedFiles.push(targetPath);
      continue;
    }

    // Write to target path
    const fullTargetPath = path.join(ctx.sourceDir, targetPath);
    const dir = path.dirname(fullTargetPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullTargetPath, result.content, "utf-8");

    ctx.transformedFiles.push(targetPath);
    if (result.changed) {
      log(
        ctx,
        `Transformed: ${record.path} → ${targetPath} (${result.notes.length} changes)`,
      );
    } else {
      log(ctx, `Copied: ${record.path} → ${targetPath}`);
    }
  }

  console.log(`  Transformed ${ctx.transformedFiles.length} files`);

  // Post-transform: resolve ~/islands/ imports to actual file locations.
  // Islands are moved to src/sections/ during migration, but components
  // import them via ~/islands/X which no longer exists. Scan src/ for
  // the actual file and rewrite the import.
  if (!ctx.dryRun) {
    fixIslandImports(ctx);
    reconcileIconCasing(ctx);
  }
}

/**
 * `<Icon id="close">` → `<Icon id="Close">`. Deco-fresh (Deno) didn't strictly
 * typecheck, so sites often used lowercase icon ids that don't match their own
 * PascalCase `AvailableIcons` union — the stricter TanStack typecheck then fails
 * ("Type '\"close\"' is not assignable to type 'AvailableIcons'"). This
 * case-corrects any `<Icon id="X">` whose name matches an AvailableIcons entry
 * case-insensitively. Names with NO match (a genuinely missing icon) are left
 * as-is and flagged for manual review — adding them to the type + sprite is a
 * design decision, not a rename.
 */
export function reconcileIconCasing(ctx: MigrationContext): void {
  const srcDir = path.join(ctx.sourceDir, "src");
  if (!fs.existsSync(srcDir)) return;

  const walk = (dir: string, visit: (file: string, content: string) => void) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(path.join(dir, entry.name), visit);
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        visit(path.join(dir, entry.name), fs.readFileSync(path.join(dir, entry.name), "utf-8"));
      }
    }
  };

  // 1. Canonical icon names from the declared `AvailableIcons` union (if any).
  const canonical = new Map<string, string>(); // lowercased → canonical casing
  walk(srcDir, (_file, content) => {
    const m = content.match(/export type AvailableIcons\s*=\s*([\s\S]*?);/);
    if (m) for (const n of m[1].matchAll(/["']([A-Za-z0-9_-]+)["']/g)) canonical.set(n[1].toLowerCase(), n[1]);
  });
  if (canonical.size === 0) return;

  // 2. Case-correct `<Icon id="X">` usages; flag unmatched names once per file.
  const iconIdRe = /(<Icon\b[^>]*?\bid=["'])([A-Za-z0-9_-]+)(["'])/g;
  let corrected = 0;
  walk(srcDir, (file, content) => {
    let modified = false;
    const flagged = new Set<string>();
    const next = content.replace(iconIdRe, (whole, pre, name, post) => {
      const canon = canonical.get(name.toLowerCase());
      if (canon) {
        if (canon !== name) {
          modified = true;
          corrected++;
          return `${pre}${canon}${post}`;
        }
        return whole;
      }
      if (!flagged.has(name)) {
        flagged.add(name);
        ctx.manualReviewItems.push({
          file: path.relative(ctx.sourceDir, file).replace(/\\/g, "/"),
          reason: `<Icon id="${name}"> is not in AvailableIcons — add it to the type in Icon.tsx and the sprite, or the icon renders blank.`,
          severity: "warning",
        });
      }
      return whole;
    });
    if (modified) fs.writeFileSync(file, next, "utf-8");
  });

  if (corrected > 0) {
    console.log(`  Icon casing: corrected ${corrected} <Icon id> to match AvailableIcons`);
  }
}

/**
 * Scan all transformed files for ~/islands/ imports and rewrite them
 * to the actual path where the file was placed (sections/, components/, etc.).
 */
function fixIslandImports(ctx: MigrationContext): void {
  const srcDir = path.join(ctx.sourceDir, "src");
  if (!fs.existsSync(srcDir)) return;

  // Build a lookup: filename → relative path from src/
  const fileLookup = new Map<string, string[]>();
  function scanDir(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        scanDir(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        const relPath = path.relative(srcDir, path.join(dir, entry.name)).replace(/\\/g, "/");
        const base = entry.name.replace(/\.tsx?$/, "");
        if (!fileLookup.has(base)) fileLookup.set(base, []);
        fileLookup.get(base)!.push(relPath);
      }
    }
  }
  scanDir(srcDir);

  // Scan all .ts/.tsx files in src/ for ~/islands/ imports
  const islandImportRe = /from\s+["'](~\/islands\/([^"']+))["']/g;
  let fixCount = 0;

  function walkAndFix(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walkAndFix(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        const filePath = path.join(dir, entry.name);
        let content = fs.readFileSync(filePath, "utf-8");
        let modified = false;

        content = content.replace(islandImportRe, (match, fullImport, islandPath) => {
          // islandPath = "Cart/Indicator" or "SliderJS" or "Searchbar"
          const basename = islandPath.replace(/\.tsx?$/, "").split("/").pop()!;

          // Try to find the file — prefer components/ over sections/
          const candidates = fileLookup.get(basename) || [];
          // Exclude islands/ paths themselves and routes/
          const valid = candidates.filter(
            (c) => !c.startsWith("islands/") && !c.startsWith("routes/"),
          );

          if (valid.length === 0) return match; // can't resolve, leave as-is

          // Prefer components/ over sections/
          const preferred =
            valid.find((c) => c.startsWith("components/")) ??
            valid.find((c) => c.startsWith("sections/")) ??
            valid[0];

          const newPath = "~/" + preferred.replace(/\.tsx?$/, "");
          modified = true;
          return match.replace(fullImport, newPath);
        });

        if (modified) {
          fs.writeFileSync(filePath, content, "utf-8");
          fixCount++;
        }
      }
    }
  }

  walkAndFix(srcDir);
  if (fixCount > 0) {
    console.log(`  Fixed ~/islands/ imports in ${fixCount} files`);
  }
}
