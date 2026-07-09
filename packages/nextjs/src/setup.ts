/**
 * One-call site bootstrap for Next.js — the App Router sibling of the
 * Vite flow (`createSiteSetup` + `createAdminSetup` + import.meta.glob).
 * Next has no import.meta.glob and no Vite plugin, so this composes the
 * same framework pieces from a generated section registry
 * (`generate-sections --registry`) and a filesystem decofile directory.
 *
 * ROUTE-HANDLER-SAFE: this module (and everything it imports eagerly) must
 * never reach module-scope client-React — it is imported by route files
 * via the site's setup module. Admin setters are imported lazily for the
 * same reason createAdminSetup keeps meta lazy: they're only needed when
 * an admin request actually arrives... and because @decocms/blocks-admin
 * is a heavier graph than the CMS core.
 *
 * @example site's `src/deco/setup.ts`
 * ```ts
 * import { createNextSetup } from "@decocms/nextjs/setup";
 * // Generators default to `.deco/`; `deco/*` is a tsconfig path alias for
 * // `.deco/*` (see the package README) since `src/deco/setup.ts` isn't
 * // adjacent to the site-root `.deco/` directory.
 * import { sectionImports, sectionMeta, syncComponents } from "deco/sections.gen";
 *
 * export const ensureSetup = createNextSetup({
 *   sections: sectionImports,
 *   conventions: { meta: sectionMeta, syncComponents },
 *   meta: () => import("deco/meta.gen.json").then((m) => m.default),
 * });
 * ```
 */
import type { ApplySectionConventionsInput } from "@decocms/blocks/cms";
import { applySectionConventions, loadBlocks } from "@decocms/blocks/cms";
import { loadDecofileDirectory } from "@decocms/blocks/cms/loadDecofileDirectory";
import { createSiteSetup, type SiteSetupOptions } from "@decocms/blocks/setup";

export interface NextSetupOptions {
  /**
   * Directory of decofile JSON snapshots, relative to the site root.
   * Pass `false` to skip filesystem loading (blocks come from `blocks`).
   * @default ".deco/blocks"
   */
  blocksDir?: string | false;

  /** Extra/override blocks, merged OVER the directory's blocks. */
  blocks?: Record<string, unknown>;

  /**
   * Lazy section registry — `sectionImports` from
   * `generate-sections --registry` (keys `./sections/X.tsx`).
   */
  sections: Record<string, () => Promise<any>>;

  /** `{ meta: sectionMeta, syncComponents, loadingFallbacks }` from sections.gen.ts (`.deco/sections.gen.ts` by default). */
  conventions?: Omit<ApplySectionConventionsInput, "sectionGlob">;

  /** Lazy admin meta schema: `() => import("deco/meta.gen.json").then(m => m.default)` (`.deco/meta.gen.json` by default). */
  meta?: () => Promise<unknown>;

  /** Admin preview shell (CSS/font URLs) — see blocks-admin setRenderShell. */
  renderShell?: { css?: string; fonts?: string[] };

  /** Admin preview wrapper component. */
  previewWrapper?: React.ComponentType<any>;

  productionOrigins?: SiteSetupOptions["productionOrigins"];
  customMatchers?: SiteSetupOptions["customMatchers"];
  onResolveError?: SiteSetupOptions["onResolveError"];
  onDanglingReference?: SiteSetupOptions["onDanglingReference"];

  /**
   * Site-specific wiring that must run after the core setup (section
   * loaders, SEO keys for legacy decofiles, curated post-processing).
   * Receives the loaded blocks.
   */
  extend?: (blocks: Record<string, unknown>) => void | Promise<void>;
}

/**
 * Returns a memoized `ensureSetup` function. A successful bootstrap is
 * cached for the lifetime of the module (warm serverless instance); a
 * *rejected* bootstrap is NOT cached — the memo is cleared on failure so
 * the next call retries from scratch, while the triggering call still
 * rejects with the original error.
 */
export function createNextSetup(options: NextSetupOptions): () => Promise<void> {
  let setupPromise: Promise<void> | null = null;

  return function ensureSetup(): Promise<void> {
    setupPromise ??= (async () => {
      const dirBlocks =
        options.blocksDir === false
          ? {}
          : await loadDecofileDirectory(options.blocksDir ?? ".deco/blocks");
      const blocks = { ...dirBlocks, ...options.blocks };

      createSiteSetup({
        sections: options.sections,
        blocks,
        productionOrigins: options.productionOrigins,
        customMatchers: options.customMatchers,
        onResolveError: options.onResolveError,
        onDanglingReference: options.onDanglingReference,
      });

      if (options.conventions) {
        applySectionConventions({
          ...options.conventions,
          sectionGlob: options.sections,
        });
      }

      if (options.meta || options.renderShell || options.previewWrapper) {
        const admin = await import("@decocms/blocks-admin");
        if (options.meta) admin.setMetaData((await options.meta()) as never);
        if (options.renderShell) admin.setRenderShell(options.renderShell);
        if (options.previewWrapper) admin.setPreviewWrapper(options.previewWrapper);
      }

      await options.extend?.(loadBlocks());
    })().catch((error) => {
      // A failed bootstrap must not poison the warm instance: clear the memo
      // so the next request retries (transient fs/fetch failures are the
      // common case in serverless cold starts). The error still propagates
      // to THIS caller so the triggering request fails loudly.
      setupPromise = null;
      throw error;
    });
    return setupPromise;
  };
}
