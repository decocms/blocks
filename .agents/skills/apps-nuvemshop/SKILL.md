---
name: apps-nuvemshop
description: "@decocms/apps-nuvemshop (packages/apps-nuvemshop): the Nuvemshop/Tiendanube commerce app over the headless Storefront API (storefront-api.tiendanube.com v2026-11) plus the store's own session endpoints and the Admin API. Use when touching nuvemshopGet/nuvemshopPost, PRODUCT_FIELDS/CATEGORY_FIELDS, productListingPage facets/sort (applyListing, sort_by, ?Cor=A|B), toProduct/variant prices, relatedProducts, the account actions (login/logout/register, user loader, store_session_payload cookie, adminToken, Turnstile), nuvemshopSitemap, createCheckout, or the deco-nuvemshop block; or when products come back with only id/name/handle, a category tree is flat, filters/sorts don't match the theme, links redirect (trailing slash), registration fails silently (reCAPTCHA), login says 'Valide seu e-mail', or add-to-cart (/comprar/) returns 403."
---

# @decocms/apps-nuvemshop

Nuvemshop as a framework-agnostic package. Source: `packages/apps-nuvemshop/src/`.
Three upstreams, each covering what the others can't:

| Upstream | Client | Used for |
|---|---|---|
| Storefront API (`storefront-api.tiendanube.com/v2026-11/stores/<id>`) | `client.ts` (`nuvemshopGet` cached, `nuvemshopPost`) | catalog, search, categories, single-variant shipping, `POST /checkouts` |
| The store's own domain (`storeUrl`) | `store.ts` (`storeFetch`, cookie bridge) | login, logout, logged-in account page |
| Admin API (`api.nuvemshop.com.br/v1/<id>`) | `admin.ts` (`nuvemshopAdmin`, `adminToken`) | customer registration (no captcha), customer profile |

Everything egresses through `createNuvemshopFetch` by default (no `setXFetch`
wiring needed); Storefront GETs go through `createFetchCache`.

## When to load what

| Symptom / task | Load |
|---|---|
| Products/categories missing fields, 401 with a token, rate limits, what the API can't do | [`api.md`](./references/api.md) |
| PLP filters, sort, pagination, related products, colors, URLs that redirect | [`listing.md`](./references/listing.md) |
| Login/logout/register/user, cookies, `adminToken`, Turnstile | [`account.md`](./references/account.md) |
| Cart, add-to-cart 403, checkout (API vs classic), checkout proxy | [`cart-and-checkout.md`](./references/cart-and-checkout.md) |

## Rules that the code alone doesn't show

- **Always send `fields=`.** The API's default selection is `id,name,handle`
  for products *and* categories; without `parent` the category tree goes flat.
  The client adds `PRODUCT_FIELDS`/`CATEGORY_FIELDS` per route — don't bypass it.
- **URLs have no trailing slash.** `createDecoRouter` strips it, so
  `/produtos/x/` would answer with a redirect and a canonical that never 200s.
  Loaders still accept slashed paths (old Nuvemshop links).
- **Tests are written against captured API responses** (`src/__fixtures__`)
  typed with the API types: a response-shape drift fails `tsc`. Re-capture
  instead of hand-editing fixtures; anonymize third-party stores.
- **No customer data or real tokens in this repo** — fixtures come from the
  demo store; tokens live in site secrets.
