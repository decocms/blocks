import type { MigrationContext } from "../types";

export function generateCacheConfig(ctx: MigrationContext): string {
  if (ctx.platform !== "vtex") {
    return `/**
 * Cache configuration — customize edge cache profiles per route type.
 * See @decocms/blocks/sdk/cacheHeaders for available profiles.
 */
// import { setCacheProfile } from "@decocms/blocks/sdk/cacheHeaders";
// setCacheProfile("product", { sMaxAge: 300, staleWhileRevalidate: 600 });
`;
  }

  return `/**
 * Cache configuration for VTEX storefront.
 * Overrides default cache profiles from @decocms/blocks/sdk/cacheHeaders.
 */
// import { setCacheProfile } from "@decocms/blocks/sdk/cacheHeaders";

// Uncomment and adjust as needed:
// setCacheProfile("product", { sMaxAge: 300, staleWhileRevalidate: 600 });
// setCacheProfile("listing", { sMaxAge: 120, staleWhileRevalidate: 300 });
// setCacheProfile("search", { sMaxAge: 60, staleWhileRevalidate: 120 });
// setCacheProfile("static", { sMaxAge: 86400, staleWhileRevalidate: 172800 });
`;
}
