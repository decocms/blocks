import { createGraphqlClient, type GraphQLClient } from "./utils/graphql";

export interface ShopifyConfig {
	storeName: string;
	storefrontAccessToken: string;
	publicUrl?: string;
}

let _client: GraphQLClient | null = null;
let _config: ShopifyConfig | null = null;
let _fetch: typeof fetch | undefined;

/**
 * Override the fetch function used by the Shopify GraphQL client.
 * Use this to plug in instrumented fetch for logging/tracing.
 *
 * @example
 * ```ts
 * import { createInstrumentedFetch } from "@decocms/blocks/sdk/instrumentedFetch";
 * import { setShopifyFetch } from "@decocms/apps/shopify";
 * setShopifyFetch(createInstrumentedFetch("shopify"));
 * ```
 */
export function setShopifyFetch(fetchFn: typeof fetch) {
	_fetch = fetchFn;
	if (_config) configureShopify(_config);
}

export function configureShopify(config: ShopifyConfig) {
	_config = config;
	_client = createGraphqlClient(
		`https://${config.storeName}.myshopify.com/api/2025-04/graphql.json`,
		{
			"X-Shopify-Storefront-Access-Token": config.storefrontAccessToken,
		},
		_fetch,
	);
}

export function getShopifyClient(): GraphQLClient {
	if (!_client || !_config) {
		throw new Error(
			"Shopify not configured. Call configureShopify() first or check deco-shopify.json block.",
		);
	}
	return _client;
}

export function getShopifyConfig(): ShopifyConfig {
	if (!_config) {
		throw new Error("Shopify not configured.");
	}
	return _config;
}

export function getBaseUrl(): string {
	return _config?.publicUrl || "";
}
