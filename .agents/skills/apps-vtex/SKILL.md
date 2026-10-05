---
name: apps-vtex
description: "@decocms/apps-vtex (packages/apps-vtex): the VTEX commerce app — client (vtexFetch, vtexFetchWithCookies, vtexCachedFetch, intelligentSearch), checkout/session/auth actions, catalog/IS/legacy/cart loaders, useCart/useUser/useWishlist and the Cart v2 hooks (createCart, createCartQuery). Use when code mentions orderForm, expectedOrderFormSections, *V2 cart actions, invoke.vtex.*, VtexIdclientAutCookie/buildAuthCookieHeader, salesChannel/sc, vtex_segment, fetchWithCache; or when the cart empties after add-to-cart, logged-in calls 401/403, prices are wrong per sales channel, orderForm sections are missing, a minicart/add-to-cart makes too many VTEX cart API calls, or VTEX responses look stale. Also for apps-vtex PR reviews. Repeated calls across navigations or edge/route/layout caching are deco-caching, not this."
---

# @decocms/apps-vtex

The VTEX integration as a framework-agnostic package (port of deco-cx/apps
`vtex/`, formerly the `vtex/` folder of `@decocms/apps-start`). Source:
`packages/apps-vtex/src/`. `client.ts` is the HTTP layer — `vtexFetch`,
`vtexFetchWithCookies` (forwards the browser `Cookie` and pushes upstream
`Set-Cookie` into `RequestContext`), `vtexCachedFetch` / `intelligentSearch`
(SWR cache via `utils/fetchCache.ts`), `vtexIOGraphQL`. `actions/` holds the
mutations (`checkout.ts` incl. the Cart v2 `*V2` actions, `auth`, `session`,
`profile`, `wishlist`, `masterData`…), `loaders/` the reads (`catalog`,
`intelligentSearch/`, `legacy/`, `cart/` for Cart v2, `workflow/`, `minicart`…),
`hooks/` the client hooks (legacy `useCart`/`createUseCart`, `useUser`,
`useWishlist`, Cart v2 `createCart` and `cartQuery`), `utils/` the shared pieces
(`transform.ts` schema.org mapping, `vtexId.ts`, `segment.ts`,
`constants.ts` + `resilience.ts` + `instrumentedFetch.ts`, `simulationCache.ts`).
`middleware.ts` extracts VTEX request context and IS cookies; `invoke.ts`
declares the actions `blocks-cli`'s generate-invoke turns into server functions.
Public entry points are the `package.json` `exports` map (`./client`,
`./actions/*`, `./loaders/*`, `./hooks/*`, `./utils/*`, `./inline-loaders/*`
aliases…).

## When to load what

| Symptom / task | Load |
|---|---|
| Cart empties after add-to-cart, `/checkout` opens a fresh order, only one comma-joined `Set-Cookie` in DevTools | [`audit-cookie-propagation.md`](./references/audit-cookie-propagation.md) |
| Logged-in call 401/403, hardcoded `VtexIdclientAutCookie`, client reading the HttpOnly auth cookie | [`audit-auth-cookies.md`](./references/audit-auth-cookies.md) |
| OrderForm missing totals/shipping/etc. (`expectedOrderFormSections`) | [`audit-expected-order-form-sections.md`](./references/audit-expected-order-form-sections.md) |
| Wrong prices, ORD027, products invisible for a sales channel (`sc`) | [`audit-sales-channel.md`](./references/audit-sales-channel.md) |
| Intelligent Search results/personalization off (`vtex_is_session`) | [`audit-intelligent-search-cookies.md`](./references/audit-intelligent-search-cookies.md) |
| Checking hooks / `transform.ts` / PDP-PLP shapes against deco-cx/apps | [`audit-deco-cx-apps-parity.md`](./references/audit-deco-cx-apps-parity.md) |
| Reviewing an apps-vtex PR or porting code — file map, full checklist, validation greps | [`audit-checklist.md`](./references/audit-checklist.md) |
| Building a minicart / badge / add-to-cart, cutting cart traffic, why Cart v2 exists | [`cart-overview.md`](./references/cart-overview.md) |
| Choosing a `projection` or `sections` preset | [`cart-contract.md`](./references/cart-contract.md) |
| Reading cart data: `cart/summary`, `full`, `shipping`, `gifts`, `attachments` | [`cart-loaders.md`](./references/cart-loaders.md) |
| Calling the `*V2` mutations directly | [`cart-actions.md`](./references/cart-actions.md) |
| Using `createCart` hooks (`useCartSummary`, `useAddToCart`, `useCart`, …) | [`cart-hooks.md`](./references/cart-hooks.md) |
| Site already on `@tanstack/react-query` — `createCartQuery` | [`cart-react-query-adapter.md`](./references/cart-react-query-adapter.md) |
| `invoke.vtex.actions.*V2` / `invoke.vtex.loaders.cart.*` missing in a site | [`cart-wiring.md`](./references/cart-wiring.md) |
| Moving a live site off legacy `useCart`/`createUseCart` | [`cart-migrating-from-legacy.md`](./references/cart-migrating-from-legacy.md) |
| Stale VTEX responses, adding cache to a VTEX endpoint, cache tuning knobs | [`fetch-cache.md`](./references/fetch-cache.md) |

Generic SWR / `createFetchCache` / edge-cache mechanics are not VTEX-specific —
see the `deco-caching` skill.

## Invariants worth knowing before you open a reference

- Anything that mutates cart/session/auth goes through `vtexFetchWithCookies`, never `vtexFetch` / `vtexCachedFetch` — the cached path drops `Set-Cookie` and the cart drifts from VTEX.
- `Set-Cookie` is copied onto the HTTP response with `Headers.getSetCookie()`, never `entries()`/`forEach` (they collapse N cookies into one the browser discards).
- The `VtexIdclientAutCookie` constant lives in `utils/vtexId.ts`; `utils/cookieSanitizer.ts` (forwarding allowlist), `utils/cookies.ts` and `utils/authHelpers.ts` (parsers) also match the name — change them together. It is HttpOnly, so auth status comes from `/api/sessions`, not `document.cookie`.
- Only cache responses that are identical for every shopper given the URL.
