/**
 * Standard Wake commerce loader map factory for CMS block resolution.
 *
 * Wraps the cacheable catalog loaders with `createCachedLoader` (single-flight
 * dedup + SWR + stale-if-error via the unified cache profiles), applies the
 * PDP slug fallback and PLP page-URL resolution, and registers both `.ts` and
 * `.ts`-less aliases.
 *
 * Sites call `createWakeCommerceLoaders()` and hand the result to
 * `registerCommerceLoaders(...)` instead of wiring each loader (and its cache
 * policy) by hand — mirroring `createVtexCommerceLoaders()`.
 *
 * User-specific loaders (cart/user/wishlist) are intentionally NOT included:
 * they are per-session and must not be cached; the app manifest registers them
 * uncached via `autoconfigApps`.
 */

import { createCachedLoader } from "@decocms/blocks/sdk/cachedLoader";
import type { CacheProfileName } from "@decocms/blocks/sdk/cacheHeaders";
import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import partnersLoader from "./loaders/partners";
import productDetailsPage from "./loaders/productDetailsPage";
import productList from "./loaders/productList";
import productListingPage from "./loaders/productListingPage";
import recommendations from "./loaders/recommendations";
import shopLoader from "./loaders/shop";
import suggestion from "./loaders/suggestion";

export type CommerceLoaderFn = (props: any) => Promise<any>;

export interface WakeCommerceLoadersOptions {
  /** Override cache profiles per loader type. */
  cacheProfiles?: {
    listing?: CacheProfileName;
    product?: CacheProfileName;
    search?: CacheProfileName;
    static?: CacheProfileName;
  };
  /** Additional loaders to merge into the map (site-specific). */
  extra?: Record<string, CommerceLoaderFn>;
}

const PAGE_URL_HEADER = "x-deco-page-url";

/**
 * Resolve the real page URL for the productListingPage loader. Wake's PLP reads
 * the URL from `props.pageHref`; the framework injects `__pageUrl`, but on CSR
 * home navigations that is unreliable, so an explicit `x-deco-page-url` header
 * (set by the site) wins, then `__pageUrl`, then the worker request URL.
 */
function resolvePageHref(props: any): string | undefined {
  try {
    const headerUrl = RequestContext.request.headers.get(PAGE_URL_HEADER);
    if (headerUrl) return new URL(headerUrl, "http://localhost").href;
  } catch {
    // RequestContext may be unavailable in isolated calls.
  }
  if (props?.__pageUrl) {
    try {
      return new URL(props.__pageUrl, "http://localhost").href;
    } catch {
      // ignore malformed injected URL
    }
  }
  try {
    return new URL(RequestContext.request.url).href;
  } catch {
    return props?.pageHref;
  }
}

/** Bridge `__pagePath` → `slug` when the CMS doesn't set slug explicitly. */
function pdpWithSlugFallback(props: any): Promise<any> {
  if ((!props.slug || props.slug.length === 0) && props.__pagePath) {
    props = { ...props, slug: props.__pagePath };
  }
  return productDetailsPage(props);
}

export function createWakeCommerceLoaders(
  options?: WakeCommerceLoadersOptions,
): Record<string, CommerceLoaderFn> {
  const profiles = {
    listing: options?.cacheProfiles?.listing ?? "listing",
    product: options?.cacheProfiles?.product ?? "product",
    search: options?.cacheProfiles?.search ?? "search",
    static: options?.cacheProfiles?.static ?? "static",
  };

  const cachedPDP = createCachedLoader(
    "wake/productDetailsPage",
    pdpWithSlugFallback,
    profiles.product,
  );
  const _cachedPLP = createCachedLoader(
    "wake/productListingPage",
    productListingPage,
    profiles.listing,
  );
  const cachedProductList = createCachedLoader("wake/productList", productList, profiles.listing);
  const cachedSuggestion = createCachedLoader("wake/suggestion", suggestion, profiles.search);
  const cachedRecommendations = createCachedLoader(
    "wake/recommendations",
    recommendations,
    profiles.product,
  );
  const cachedShop = createCachedLoader("wake/shop", shopLoader, profiles.static);
  const cachedPartners = createCachedLoader("wake/partners", partnersLoader, profiles.static);

  // PLP wrapper: forward the resolved page URL as `pageHref` before caching.
  const cachedPLP: CommerceLoaderFn = (props) =>
    _cachedPLP({ ...props, pageHref: resolvePageHref(props) ?? props?.pageHref });

  const loaders: Record<string, CommerceLoaderFn> = {
    "wake/loaders/productDetailsPage.ts": cachedPDP,
    "wake/loaders/productListingPage.ts": cachedPLP,
    "wake/loaders/productList.ts": cachedProductList,
    "wake/loaders/suggestion.ts": cachedSuggestion,
    "wake/loaders/recommendations.ts": cachedRecommendations,
    "wake/loaders/shop.ts": cachedShop,
    "wake/loaders/partners.ts": cachedPartners,
  };

  // Register .ts-less aliases for invoke compatibility.
  const withAliases: Record<string, CommerceLoaderFn> = { ...loaders };
  for (const key of Object.keys(loaders)) {
    if (key.endsWith(".ts")) {
      withAliases[key.slice(0, -3)] = loaders[key];
    }
  }

  if (options?.extra) {
    Object.assign(withAliases, options.extra);
  }

  return withAliases;
}
