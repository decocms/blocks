/**
 * Pre-wired instrumented fetch factory for Shopify.
 *
 * Mirrors `vtex/utils/instrumentedFetch.ts`. Bundles:
 *
 *   1. `createInstrumentedFetch` from `@decocms/start` (spans,
 *      traceparent, URL redaction).
 *   2. `shopifyOperationRouter` as the URL fallback for non-GraphQL
 *      and unnamed-GraphQL calls.
 *   3. An `onComplete` that records the canonical
 *      `http.client.request.duration` histogram (via the framework's
 *      `recordCommerceMetric(...)` helper) with `provider: "shopify"`.
 *
 * Sites do:
 *
 *   ```ts
 *   import { setShopifyFetch, createShopifyFetch } from "@decocms/apps/shopify";
 *   setShopifyFetch(createShopifyFetch());
 *   ```
 *
 * Per-call operation names come from `extractGraphqlOperationName`
 * (wired in `./graphql.ts`); the URL router fires only when the
 * extractor returns `undefined`.
 */

import type { FetchFn } from "@decocms/blocks/sdk/fetchTimeout";
import {
	createInstrumentedFetch,
	type InstrumentedFetch,
} from "@decocms/blocks/sdk/instrumentedFetch";
import { recordCommerceMetric } from "@decocms/blocks/sdk/observability";
import { shopifyOperationRouter } from "./operationRouter";

export interface CreateShopifyFetchOptions {
	baseFetch?: FetchFn;
	disableHistogram?: boolean;
}

export function createShopifyFetch(options: CreateShopifyFetchOptions = {}): InstrumentedFetch {
	const { baseFetch, disableHistogram = false } = options;
	return createInstrumentedFetch({
		name: "shopify",
		baseFetch,
		resolveOperation: shopifyOperationRouter,
		onComplete: disableHistogram
			? undefined
			: ({ operation, status, durationMs, cached }) => {
					recordCommerceMetric(durationMs, {
						provider: "shopify",
						operation,
						status_class: `${Math.floor(status / 100)}xx`,
						cached,
					});
				},
	});
}
