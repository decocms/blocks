/**
 * VTEX app entry point for @decocms/apps.
 * Re-exports client config + initializer + app contract.
 *
 * For actions/loaders/utils, use sub-path imports:
 *   import { addItemsToCart } from "@decocms/apps/vtex/actions/checkout"
 *   import { searchProducts }  from "@decocms/apps/vtex/loaders/catalog"
 *   import { slugify }         from "@decocms/apps/vtex/utils/slugify"
 *
 * Or barrel imports:
 *   import { addItemsToCart } from "@decocms/apps/vtex/actions"
 *   import { searchProducts }  from "@decocms/apps/vtex/loaders"
 */
export * from "./client";
export { configure, type VtexState } from "./mod";
export { type CreateVtexFetchOptions, createVtexFetch } from "./utils/instrumentedFetch";
export { vtexOperationRouter } from "./utils/operationRouter";
