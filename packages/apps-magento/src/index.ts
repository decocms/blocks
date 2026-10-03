// v8: the thin Magento client (see /next/upstream-clients).

// v7 (kept for v7 consumers until the v7 modules are dropped)
/**
 * Magento app entry point for @decocms/apps.
 * Re-exports client config + initializer.
 *
 * For actions/loaders/utils, use sub-path imports:
 *   import { features }     from "@decocms/apps/magento/loaders/features"
 *   import { cart }         from "@decocms/apps/magento/loaders/cart"
 *   import { magentoFetch } from "@decocms/apps/magento/client"
 */
export * from "./client";
export {
  createMagentoClient,
  type MagentoClient,
  type MagentoClientConfig,
  type MagentoClientOptions,
  MagentoError,
  type MagentoRequestInit,
} from "./magentoClient";
export type { MagentoCart } from "./types";
export {
  clearFetchCache,
  type FetchCacheOptions,
  getFetchCacheStats,
  magentoCachedFetch,
} from "./utils/fetchCache";
// Observability wiring — sites call `setMagentoFetch(createMagentoFetch())` at
// boot to route every Magento egress call through the instrumented fetch
// (upstream latency/status), and use `magentoCachedFetch` for cacheable GETs
// (SWR hit/miss → `deco.cache.requests{layer="swr",profile="magento"}`).
export {
  type CreateMagentoFetchOptions,
  createMagentoFetch,
} from "./utils/instrumentedFetch";
