/**
 * `@decocms/apps-wake/storefront`: Wake's Storefront GraphQL operations, to
 * pass to `createWakeClient`'s `graphql`. Their generated request and response
 * types are in `@decocms/apps-wake/storefront/types`:
 *
 * ```ts
 * import { GetProduct } from "@decocms/apps-wake/storefront";
 * import type { GetProductQuery, GetProductQueryVariables } from "@decocms/apps-wake/storefront/types";
 *
 * const data = await wake.graphql<GetProductQuery, GetProductQueryVariables>(GetProduct, { productId: 1 });
 * ```
 */
export * from "./utils/graphql/queries.ts";
