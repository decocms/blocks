---
name: deco-apps
description: "The thin upstream clients of @decocms/blocks 8: @decocms/apps-vtex, apps-shopify, apps-wake, apps-magento, apps-algolia, apps-resend and apps-sfmc-personalization. Covers creating and configuring each client (settings as arguments, credentials from the deploy platform's secrets), what each call returns and throws, retries and the circuit breaker (VTEX only), telemetry through createInstrumentedFetch, upstream caching through the site's own fetch, v7 app loaders vendored into src/vendor and moved onto a client, the schema.org commerce types and helpers in @decocms/compat-v7/commerce, and VTEX specifics: forwarding shopper cookies and Set-Cookie, VtexIdclientAutCookie and headless login hosts, sales channel and regionId, orderForm sections, Intelligent Search cookies, and caching only shopper-invariant responses. Load it when a site calls a commerce, search, email or personalization backend, when a cart, sign-in, price or region is wrong, or when porting a v7 loader to a v8 client."
---

# Upstream clients (`@decocms/apps-*`)

On v8 each backend has one thin client package. A client is a factory that takes its
settings as arguments and returns typed request functions. Every request goes through
`createInstrumentedFetch` from `@decocms/blocks/fetch`, so it is measured once and
reported to the CMS telemetry.

A client does **not** read environment variables, read the incoming request, cache,
convert to commerce types, or ship hooks, loaders or actions. Those are site code:

- `src/clients/<app>.ts` creates the client (the v7 → v8 migration script writes it).
- `src/vendor/<app>/…` holds the v7 loaders, actions and converters the content calls.
- Server functions or route handlers run the cart, session and sign-in calls, because
  they have the shopper's request.

Use this skill when the site talks to a backend. For wiring the binding, writing
sections or caching pages, see the skills listed at the end.

## The packages

| Package | Factory | Entry points | Retries and breaker |
|---|---|---|---|
| `@decocms/apps-vtex` | `createVtexClient(config)` | `.`, `/image` | On by default |
| `@decocms/apps-shopify` | `createShopifyClient(config, { fetch? })` | `.`, `/image` | Off |
| `@decocms/apps-wake` | `createWakeClient(config, { fetch? })` | `.`, `/storefront`, `/storefront/types` | Off |
| `@decocms/apps-magento` | `createMagentoClient(config, { fetch? })` | `.` | Off |
| `@decocms/apps-algolia` | `createAlgoliaClient(config, { fetch? })` | `.` | Off |
| `@decocms/apps-resend` | `createResendClient(config, { fetch? })` | `.` | Off |
| `@decocms/apps-sfmc-personalization` | `createSfmcPersonalizationClient(config, { fetch? })` | `.` | Off |

Each takes `@decocms/blocks` `^8.4.0` as a peer. All packages of this repo release in
lockstep at one version, so install the client at the same version as `@decocms/blocks`.
VTEX takes `fetch` inside its config; the others take it in a second argument.

## When to load what

| Reference | Load it when |
|---|---|
| [`references/instrumented-fetch.md`](./references/instrumented-fetch.md) | Errors you need to handle, retries, the circuit breaker, telemetry labels, adding an upstream cache, calling an endpoint no client covers |
| [`references/vendored-loaders.md`](./references/vendored-loaders.md) | After the migration script: `src/clients/<app>.ts`, `src/vendor/`, moving a v7 loader or action onto the v8 client, keeping v7's client instead |
| [`references/commerce-types.md`](./references/commerce-types.md) | Typing `Product`, `Offer`, `ProductListingPage`; `useOffer`, `formatPrice`, analytics mappers; mapping VTEX fields to schema.org |
| [`references/vtex.md`](./references/vtex.md) | Configuring `createVtexClient`, its operations, sales channel, `regionId`, locale, orderForm sections, Master Data, IO GraphQL, image URLs |
| [`references/vtex-cookies-auth.md`](./references/vtex-cookies-auth.md) | Empty cart after add-to-cart, lost session, sign-in loops, `VtexIdclientAutCookie`, Intelligent Search cookies, what may be cached |
| [`references/shopify.md`](./references/shopify.md) | Storefront or Admin GraphQL on Shopify, API version, `ShopifyError` codes |
| [`references/wake.md`](./references/wake.md) | Wake Storefront operations and types, `getLogin` |
| [`references/magento.md`](./references/magento.md) | Magento REST and GraphQL, bearer token, customer tokens, origin header |
| [`references/algolia.md`](./references/algolia.md) | Algolia multi-query search, API keys |
| [`references/messaging.md`](./references/messaging.md) | Sending email with Resend, Salesforce Marketing Cloud Personalization events |

## Rules that hold for every client

- **Create the client once per isolate, on first use** (`client ??= createVtexClient(…)`).
  The circuit breaker and its failure count live in the client instance. A client per
  request never opens its breaker.
- **Credentials come from the deploy platform's secrets**, read where the site creates
  the client (the Worker's `env` on TanStack Start, `process.env` on Next.js). Content
  holds no secrets on v8.
- **Call clients on the server only**: block functions, server functions, route
  handlers. A client carries app keys and tokens. Never import it into a client component.
- **Errors carry the operation and the status, never a body, URL, token or cookie.**
  Network failures and an open circuit are thrown as they are, not as the client's
  error class. See [`instrumented-fetch.md`](./references/instrumented-fetch.md).
- **Clients never cache.** The site caches, by passing its own `fetch`, and caches
  only responses that are the same for every shopper.
- **Shopper data is per request.** A block function gets only its inputs, with no
  request. Cart, session and profile calls need the shopper's `Cookie` header, so they
  run in a server function or route handler, and their responses are private.

## Related skills

- `deco-v7-to-v8-migration`: the script that writes `src/clients/` and `src/vendor/`.
- `deco-site-authoring`: block functions and loaders that call these clients.
- `deco-tanstack-site`, `deco-nextjs-site`: server functions, route handlers, the worker.
- `deco-storefront-caching`: page cache, segments, private responses.
- `deco-storefront-performance`: duplicate upstream calls, payload size.
- `deco-images-media`: the `/image` providers of apps-vtex and apps-shopify.
- `vtex-delivery-promise` (decocms/skills): delivery badges, regionalization, postal-code capture on VTEX.
