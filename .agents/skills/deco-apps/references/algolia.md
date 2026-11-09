# `@decocms/apps-algolia`

A client for Algolia's Search REST API. It calls the REST API directly, not through the
`algoliasearch` SDK, so every request is measured like any other client's.

## Configure

```ts
import { createAlgoliaClient } from "@decocms/apps-algolia";

export const algolia = createAlgoliaClient(
  { applicationId: "APP123", apiKey: secrets.ALGOLIA_SEARCH_KEY },
  { fetch: cachedFetch }, // optional
);
```

- `applicationId` must be letters and digits only, or the factory throws
  `"algolia: invalid applicationId"`. It becomes part of the host
  (`https://{applicationId}-dsn.algolia.net`), so nothing else is accepted.
- Use a **search-only** API key. The client runs on the server, but a key that can write
  to indices has no business in a storefront.
- Exports: `createAlgoliaClient`, `AlgoliaClient`, `AlgoliaClientConfig`,
  `AlgoliaSearchRequest`, `AlgoliaSearchResponse`, `AlgoliaHit`, `AlgoliaError`.

## Search

```ts
const { results } = await algolia.search<ProductRecord>([
  { indexName: "products", query: "linen shirt", hitsPerPage: 12, filters: "inStock:true" },
  { indexName: "products_suggestions", query: "linen", hitsPerPage: 5 },
]);
```

- `search(requests)` posts all queries in one request to `/1/indexes/*/queries` and
  returns `{ results }`, one `AlgoliaSearchResponse` per query, in order.
- Each request is `indexName` plus search parameters as the REST API names them
  (`query`, `hitsPerPage`, `page`, `filters`, `facets`…). The client passes them through.
- Each hit is your record type plus `objectID`.
- It is the only operation; the telemetry label is `search`. Batch a page's queries
  into one call instead of several.

## Errors and caching

`AlgoliaError` has `operation` and `status`. No retries or circuit breaker: one attempt.

A search with the same parameters returns the same result for every shopper, so it can
be cached by the site, keyed on the request body (every query and parameter):
[`instrumented-fetch.md`](./instrumented-fetch.md).

No converter to commerce types ships with it. Map hits to `Product` in site code, keeping
the rules in [`commerce-types.md`](./commerce-types.md).
