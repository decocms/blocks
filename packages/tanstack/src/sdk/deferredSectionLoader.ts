/**
 * Pre-wrapped deferred section loader for IntersectionObserver-based
 * rendering.
 *
 * Convenience wrapper around `loadDeferredSection` (the POST server
 * function defined in `../routes/cmsRoute.ts`) that matches the
 * `loadDeferredSectionFn` prop signature of `DecoPageRenderer`.
 *
 * Pass this directly to
 * `<DecoPageRenderer loadDeferredSectionFn={deferredSectionLoader} />`
 * to enable IntersectionObserver-based lazy loading of deferred sections.
 *
 * Publicly exported at `@decocms/tanstack/sdk/deferredSectionLoader`.
 * Before 7.7 this wrapper existed only inside the package (exported from
 * the internal `./routes` barrel but reachable from no public subpath), so
 * migrated sites each carried a byte-identical local shim re-implementing
 * it against the public `loadDeferredSection` export. Those shims can be
 * deleted in favor of this subpath.
 *
 * @example Site's `src/routes/$.tsx`:
 * ```tsx
 * import { deferredSectionLoader } from "@decocms/tanstack/sdk/deferredSectionLoader";
 *
 * <DecoPageRenderer loadDeferredSectionFn={deferredSectionLoader} />
 * ```
 */
import type { ResolvedSection } from "@decocms/blocks/cms";
import { loadDeferredSection } from "../routes/cmsRoute";

export const deferredSectionLoader = async ({
  component,
  rawProps,
  pagePath,
  pageUrl,
  index,
}: {
  component: string;
  rawProps?: Record<string, unknown>;
  pagePath: string;
  pageUrl?: string;
  index?: number;
}): Promise<ResolvedSection | null> => {
  return loadDeferredSection({
    data: { component, rawProps, pagePath, pageUrl, index },
  });
};
