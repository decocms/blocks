# Errors, retries, telemetry and upstream caching

Every `@decocms/apps-*` client sends its requests through `createInstrumentedFetch`
from `@decocms/blocks/fetch`. The client never calls `fetch` directly; a guardrail test
in the repo enforces it. This file covers what that layer does and what it means for
the site.

## What a request goes through

```ts
createInstrumentedFetch({
  provider: "vtex",          // the provider label
  fetch?,                    // the fetch underneath; default globalThis.fetch
  retry?: { attempts, backoffMs? },        // off unless set
  circuitBreaker?: { failures, cooldownMs } // off unless set
})
```

The returned function takes `(input, init & { operation? })`. `operation` is the label
of the call (`"unknown"` when missing).

### Retries

- Only for idempotent methods: `GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`. A `POST` is
  never retried, so a checkout call is never sent twice.
- Retried on HTTP 429, 502, 503, 504 and on network errors. An abort or timeout
  (`AbortError`, `TimeoutError`) is not retried.
- Backoff is `backoffMs * 2^n` (default `backoffMs` 100).
- Only the VTEX client turns retries on: 2 retries, 150 ms base. Pass `retry: false` in
  its config to turn them off, or `{ attempts, backoffMs }` to change them.

### Circuit breaker

- After `failures` consecutive failures, every call fails fast for `cooldownMs`. A
  failure is a network error or a status of 500 or more.
- The count lives in the client instance and covers **every operation** of that
  client. If one VTEX endpoint keeps returning 5xx, search calls fail fast too until
  the cooldown ends.
- Only the VTEX client turns it on: 5 failures, 5 s cooldown. Pass
  `circuitBreaker: false` to turn it off.
- Create the client once per isolate. A new client per request starts at zero failures
  every time, so the breaker never opens.

## Errors

Each client throws its own error class on a non-2xx response. It carries the operation
and the status and nothing from the response, so it is safe to log.

| Client | Class | Fields | Also thrown when |
|---|---|---|---|
| VTEX | `VtexError` | `operation`, `status` | `io.graphql` returns `errors` (status 200) |
| Shopify | `ShopifyError` | `operation`, `status`, `codes` | GraphQL `errors`, no `data`, or a body that isn't JSON |
| Wake | `WakeError` | `operation`, `status`, `graphqlErrors` | GraphQL `errors`, or no `data` |
| Magento | `MagentoError` | `operation`, `status`, `graphqlErrors` | GraphQL `errors`, or no `data` |
| Algolia | `AlgoliaError` | `operation`, `status` | |
| Resend | `ResendError` | `operation`, `status` | |
| SFMC Personalization | `SfmcPersonalizationError` | `operation`, `status` | |

Two failures don't use these classes:

- **Network errors** (DNS, reset, abort) are rethrown as the underlying `fetch` threw them.
- **An open circuit** throws a plain `Error`: `"<provider> <operation>: circuit open after N failures"`.

So a loader that wants to show a fallback catches all errors, not only the client's
class. Checking `error instanceof VtexError && error.status === 404` is fine for "not
found"; anything else is an outage.

## Telemetry

Each request is measured once, however many retries it took, as
`http.client.request.duration` (seconds) with these labels:

| Label | Value |
|---|---|
| `provider` | `vtex`, `shopify`, `wake`, `magento`, `algolia`, `resend`, `sfmc-personalization` |
| `operation` | The call's label (see below) |
| `status_class` | `2xx`, `4xx`, `5xx`, or `error` when there was no response |
| `cached` | `true` when the response has `x-cache: HIT` |
| `retries` | How many retries it took |

A request with no response also logs an error with code `FETCH_FAILED`. Sampled
requests produce a client span named `<provider> <operation>`. Nothing about the
request body, headers or query string is recorded. With no telemetry destination
configured on the CMS, nothing is recorded.

How each client names `operation`:

- **VTEX**: from the URL path, by an internal router (`intelligent-search.product_search`,
  `checkout.orderform.items.add`, `catalog.pagetype`, `masterdata.<entity>`, `io.graphql`…).
  A path the router doesn't know is `unknown`.
- **Shopify, Wake**: the GraphQL operation's name (`query ProductByHandle { … }` →
  `ProductByHandle`). An unnamed document is `storefront.graphql` / `admin.graphql`
  (Shopify) or `graphql` (Wake). **Name your GraphQL operations**, or every call shares
  one label.
- **Magento**: the `operation` you pass to `request`/`rest`, and `operationName` for
  `graphql`. Use the API's name for the call, never a URL.
- **Algolia**: `search`. **Resend**: `sendEmail`. **SFMC**: `sendEvent`.

## Upstream caching

Clients never cache. To cache upstream responses, pass your own `fetch`:

```ts
import { createVtexClient } from "@decocms/apps-vtex";

const vtex = createVtexClient({
  account: "mystore",
  fetch: cachedFetch, // your function with fetch's signature
});
```

- Your `fetch` gets the final URL and `RequestInit` (headers included). Its cache key
  must include everything the response depends on: the full URL with its query
  (`sc`, `regionId`, `locale`, page, facets) and any header that changes the answer.
- Set `x-cache: HIT` on a response served from the cache. Telemetry then counts it as
  `cached=true`.
- Cache only shopper-invariant responses: requests sent **without** a `cookie` and
  without a per-customer `Authorization`. Never cache checkout, session, profile or
  Master Data writes. VTEX rules: [`vtex-cookies-auth.md`](./vtex-cookies-auth.md).
- Retries run around your `fetch`, and a cache hit counts as a success for the breaker.

How the site caches pages (the page cache, segments, private responses) is in the
`deco-storefront-caching` skill.

## Calling an endpoint no client covers

The clients cover a fixed set of operations. For anything else, build your own
instrumented fetch in the site so it is still measured:

```ts
import { createInstrumentedFetch } from "@decocms/blocks/fetch";

const vtexFetch = createInstrumentedFetch({ provider: "vtex" });

const response = await vtexFetch(`https://${account}.vtexcommercestable.com.br/api/…`, {
  operation: "wishlist.get", // low-cardinality: no ids, slugs or search terms
  headers: { cookie },
});
```

You then own what the client did for you: credentials, cookie sanitizing
([`vtex-cookies-auth.md`](./vtex-cookies-auth.md)), path encoding, error handling, and
not logging bodies. VTEX's operation router is internal to `@decocms/apps-vtex`, so
pass `operation` yourself.
