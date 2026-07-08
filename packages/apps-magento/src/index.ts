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
export type { MagentoCart } from "./types";
