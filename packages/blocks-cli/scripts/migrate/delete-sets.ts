/**
 * The paths the migration deletes outright. Single source of truth: `decideAction`
 * (phase-analyze) decides with them, and `deco-reconcile` filters with them — an
 * upstream change to a file the migration deleted has no target equivalent, so
 * reporting it just makes the agent consider migrating a file that must not exist.
 *
 * Only the unambiguous sets live here. Rules that are conditional on context
 * (routes/ and apps/ are rescaffolded, root-level docs) stay in `decideAction`:
 * reconcile must stay conservative, since dropping a real upstream change is a
 * worse failure than showing one file too many.
 */

/** Files that are generated and should be deleted */
export const GENERATED_FILES = new Set([
  "fresh.gen.ts",
  "manifest.gen.ts",
  "fresh.config.ts",
]);

/** SDK files that have framework equivalents or are scaffolded fresh */
export const SDK_DELETE = new Set([
  "sdk/clx.ts",
  "sdk/useId.ts",
  // sdk/useOffer.ts — kept: sites often customize offer logic
  // sdk/useVariantPossiblities.ts — kept: sites often customize variant logic
  "sdk/usePlatform.tsx",
  "sdk/signal.ts",
  "sdk/format.ts",
]);

/** Component files that are scaffolded fresh (old versions must not overwrite) */
export const COMPONENT_DELETE = new Set([
  "components/ui/Image.tsx",
  "components/ui/Picture.tsx",
  "components/ui/Video.tsx",
]);

/** Loaders that depend on deleted admin tooling */
export const LOADER_DELETE = new Set([
  "loaders/availableIcons.ts",
  "loaders/icons.ts",
]);

/** Root config/infra files to delete */
export const ROOT_DELETE = new Set([
  "main.ts",
  "dev.ts",
  "deno.json",
  "deno.lock",
  "tailwind.css",
  "tailwind.config.ts",
  "runtime.ts",
  "constants.ts",
  "fresh.gen.ts",
  "manifest.gen.ts",
  "fresh.config.ts",
  "browserslist",
  "bw_stats.json",
  "islands.ts",
]);

/** Static files that are code/tooling, not assets — should be deleted */
export const STATIC_DELETE = new Set([
  "static/adminIcons.ts",
  "static/generate-icons.ts",
  "static/tailwind.css",
]);

/** True when the migration deletes this source path outright. */
export function isDeletedByMigration(relPath: string): boolean {
  return GENERATED_FILES.has(relPath) || ROOT_DELETE.has(relPath) ||
    SDK_DELETE.has(relPath) || COMPONENT_DELETE.has(relPath) ||
    LOADER_DELETE.has(relPath) || STATIC_DELETE.has(relPath) ||
    relPath.startsWith("sdk/cart/") || relPath.startsWith("apps/deco/");
}
