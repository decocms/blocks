/**
 * The native sibling of `cmsRouteConfig` (`@decocms/tanstack`).
 *
 * `cmsRouteConfig` returns a TanStack **Router** route object whose `loader`
 * calls a server function. Neither exists on a device, so mirroring its literal
 * type would produce a config nobody can spread into anything. What survives
 * the move is the *ergonomics*: a plain options object you spread, with the
 * same option names and the same cache defaults.
 *
 * So this returns TanStack **Query** options. Query is the part of the TanStack
 * stack that runs natively, and the site already depends on it.
 *
 * Dropped on purpose, because they only exist to feed `buildHead`:
 * `siteName`, `defaultTitle`, `defaultDescription`, `head`, `headers`,
 * `validateSearch`, `ssr`.
 */

import type { CacheProfileName } from "@decocms/blocks/sdk/cacheHeaders";
import { routeCacheDefaults } from "@decocms/blocks/sdk/cacheHeaders";
import type { RenderJsonClient, RenderJsonPage } from "./renderJson";

export interface CmsScreenOptions {
  /** Client built by `createRenderJsonClient`. */
  client: RenderJsonClient;
  /** Page path on the site, e.g. `/` or `/products/dad-hat-4438`. */
  path?: string;
  /**
   * Search params excluded from the query key, so changing them does not
   * refetch. Defaults to `["skuId"]` — the same default the site uses, because
   * variant selection is resolved client-side.
   */
  ignoreSearchParams?: string[];
  /**
   * Cache profile driving `staleTime`/`gcTime`. Same source as the site's route
   * config (`routeCacheDefaults`), so a page does not go stale on the device at
   * a different rate than on the web.
   *
   * @default "product"
   */
  cacheProfile?: CacheProfileName;
}

export interface CmsScreenConfig {
  queryKey: readonly unknown[];
  queryFn: () => Promise<RenderJsonPage>;
  staleTime: number;
  gcTime: number;
  /**
   * Keeps the previous page on screen while the next one loads.
   *
   * The query key carries the search params, so applying a filter or changing
   * the sort is a NEW key with no cached data — and without this the screen
   * falls back to its loading state and the whole list unmounts and remounts.
   * On a device that reads as a fresh sheet sliding in, not as a list updating.
   *
   * This is the native equivalent of the site's `export const eager = true` on
   * SearchResult: keep the section mounted across URL changes so filters and
   * sort stay put, and only the grid swaps.
   */
  placeholderData: (previous: RenderJsonPage | undefined) => RenderJsonPage | undefined;
}

/** Strips ignored params so `?skuId=` changes do not produce a new query key. */
function stableKeyFor(path: string, ignore: string[]): string {
  const [pathname, search] = path.split("?");
  if (!search) return pathname;
  const params = new URLSearchParams(search);
  for (const key of ignore) params.delete(key);
  params.sort();
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

export function cmsScreenConfig(options: CmsScreenOptions): CmsScreenConfig {
  const { client, path = "/", ignoreSearchParams = ["skuId"], cacheProfile = "product" } = options;

  const key = stableKeyFor(path, ignoreSearchParams);
  const { staleTime, gcTime } = routeCacheDefaults(cacheProfile);

  return {
    queryKey: ["deco", "page", key],
    queryFn: () => client.fetchPage(path),
    staleTime,
    gcTime,
    // Identity instead of importing `keepPreviousData` — same behaviour, and
    // it keeps @tanstack/react-query out of this package's dependencies.
    placeholderData: (previous) => previous,
  };
}

/** Query options for one deferred section, keyed by its opaque `lazyUrl`. */
export function deferredSectionConfig(client: RenderJsonClient, lazyUrl: string) {
  return {
    queryKey: ["deco", "section", lazyUrl] as const,
    queryFn: () => client.fetchSection(lazyUrl),
    // A deferred section is part of the page it came from; the page's own
    // staleTime governs when the whole thing is refetched.
    staleTime: Number.POSITIVE_INFINITY,
    // A filter change gives every deferred section a new `lazyUrl`, so each one
    // would blank out on its own. Holding the previous render means the grid
    // greys out in place instead of the page collapsing to a skeleton.
    placeholderData: (previous: { component: string; props: Record<string, unknown> } | undefined) => previous,
  };
}
