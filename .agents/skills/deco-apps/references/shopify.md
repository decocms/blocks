# `@decocms/apps-shopify`

A client for Shopify's Storefront and Admin GraphQL APIs, and nothing else. Converters,
cart and customer flows are site code.

## Configure

```ts
import { createShopifyClient } from "@decocms/apps-shopify";

export const shopify = createShopifyClient(
  {
    storeName: "acme",                       // acme.myshopify.com
    storefrontAccessToken: secrets.SHOPIFY_STOREFRONT_TOKEN,
    adminAccessToken: secrets.SHOPIFY_ADMIN_TOKEN, // optional; enables `admin`
    apiVersion: "2026-07",                   // required, no default
  },
  { fetch: cachedFetch },                    // optional
);
```

- `apiVersion` has no default on purpose: the site owns it, so it never goes stale
  inside the package. A migrated site starts with the version its v7 app used.
- Requests go to `https://{storeName}.myshopify.com/api/{apiVersion}/graphql.json`
  (header `X-Shopify-Storefront-Access-Token`) and
  `/admin/api/{apiVersion}/graphql.json` (header `X-Shopify-Access-Token`).
- Without `adminAccessToken`, `admin.query` rejects with
  `"shopify admin: pass adminAccessToken to createShopifyClient"`. Never use the Admin
  API from code a shopper's request can steer without checking the input.
- Exports: `createShopifyClient`, `ShopifyClient`, `ShopifyClientConfig`, `ShopifyError`.

## Query

```ts
const data = await shopify.storefront.query<ProductByHandleQuery, { handle: string }>(
  `query ProductByHandle($handle: String!) { product(handle: $handle) { id title } }`,
  { handle },
  { headers: { "Shopify-Storefront-Buyer-IP": buyerIp }, signal },
);
```

- `query(document, variables?, { headers?, signal? })` returns `data`.
- The telemetry label is the document's operation name (`ProductByHandle`). An unnamed
  document is labeled `storefront.graphql` or `admin.graphql`; name every operation.
- Extra `headers` can't override the access token.

## Errors

`ShopifyError` has `operation`, `status` and `codes`:

| Case | `codes` |
|---|---|
| HTTP error | `[]` |
| GraphQL `errors` | recognized `extensions.code` values, or `UNKNOWN`, deduplicated |
| No `data` | `["MISSING_DATA"]` |
| Body isn't JSON (an HTML error page) | `["INVALID_JSON"]` |
| Invalid GraphQL envelope or non-object `data` | `["INVALID_RESPONSE"]` |

HTTP failures use the shared fetch logs. HTTP-success GraphQL failures emit one
sampled log before rejecting: internal, unknown and malformed responses are ERROR;
throttling, access, inactive-shop and recognized query-validation failures are WARN.
Messages, variables, tokens and arbitrary upstream codes are never included. Both
levels follow the CMS's `errorSampleRate` and telemetry enable switch.

Mutation `userErrors`, `customerUserErrors` and cart warnings inside `data` are
returned unchanged and do not emit a log. Sites own their validation and UX.

A response with both `data` and `errors` is rejected as a whole. The client doesn't
guess which fields are still trustworthy. If a query can partly fail and you still want
the rest, split it into separate queries.

No retries and no circuit breaker. Caching is the site's: see
[`instrumented-fetch.md`](./instrumented-fetch.md).

## Images

`@decocms/apps-shopify/image` exports `shopifyCdn()`, an `ImageProvider` for
`https://cdn.shopify.com` URLs (sets `width`, `height` when given, and `crop=center`).
List it before `decoCdn`; see `deco-images-media`.
