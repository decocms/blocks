/**
 * VTEX app entry point.
 *
 * Next major: `createVtexClient` is the thin, instrumented VTEX client
 * (see ./vtexClient.ts and /next/upstream-clients). Everything else below is
 * the v7 app surface, kept exported for v7 consumers until v7 is dropped.
 *
 * v7: re-exports client config + initializer + app contract.
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
export {
	createVtexClient,
	VTEX_DEFAULT_CIRCUIT_BREAKER,
	VTEX_DEFAULT_RETRY,
	type VtexCatalogSearchArgs,
	type VtexClient,
	type VtexClientConfig,
	VtexError,
	type VtexRequestOptions,
	type VtexResponse,
	type VtexSearchArgs,
} from "./vtexClient";
