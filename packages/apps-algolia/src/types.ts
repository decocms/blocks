/**
 * Shared Algolia types.
 *
 * Kept as a separate module so consumers can import types without
 * pulling in the `algoliasearch` runtime (which is only needed by the
 * client/loader code).
 */

/**
 * Subset of the storefront-shaped Algolia config the app boots from.
 * Mirrors the original `apps/algolia/mod.ts` props shape so existing
 * CMS blocks (`{__resolveType: "site/apps/deco/algolia.ts", ...}`)
 * keep working byte-for-byte during the migration.
 */
export interface AlgoliaConfig {
	/**
	 * Algolia application ID. Find it under
	 * https://dashboard.algolia.com/account/api-keys/all
	 */
	applicationId: string;
	/**
	 * Search-only API key — safe to ship to the browser. Used by the
	 * client-side search proxy and SSR loaders that don't need writes.
	 */
	searchApiKey: string;
	/**
	 * Admin API key (NEVER ship to the browser). Used by the SDK
	 * instance because some operations (indexing, settings) require
	 * admin scope. Server-side only.
	 */
	adminApiKey: string;
}

/**
 * Canonical Algolia index slugs used by Deco storefronts. Stays here
 * so loaders share the same type without each one redeclaring the
 * union. Sites with custom index names just pass strings (loaders
 * accept `string`, this constant union is for autocomplete).
 */
export type Indices =
	| "products"
	| "products_price_asc"
	| "products_price_desc"
	| "products_query_suggestions";
