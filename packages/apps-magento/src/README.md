# Magento app — initial scaffold

This folder ports the Magento integration from `deco-cx/apps/magento`
(Fresh/Deno) to `@decocms/apps/magento` (TanStack Start/Node), following
the same shape as the existing `vtex/` and `shopify/` packages.

## Status

**Initial scaffold** — covers the configure/client surface and 2 reference
loaders (`features`, `cart`) so that downstream sites can wire magento at
all. The remaining 20+ loaders/actions exist as production-grade code in
the original deco-cx/apps repo and need adaptation passes (Deno → Node,
ctx-based to client-based state access, cookie helpers from
`@decocms/start/sdk/cookie`).

A real-world consumer (deco-sites/granadobr-tanstack) is wiring magento
in-site today using a thin adapter that wraps the legacy `magento/mod.ts`
shape. Their adapter is the migration target — once this package covers
the surface area they need, the in-site copy goes away.

## What's here

- `client.ts` — `configureMagento({ baseUrl, apiKey, storeId, ... })` +
  `getMagentoConfig()` global accessor. Mirrors the `configureVtex`
  pattern.
- `types.ts` — request/response shapes shared between loaders.
- `loaders/features.ts` — returns the feature flags block. The simplest
  loader, used as a smoke test.
- `loaders/cart.ts` — fetches the customer's active cart by cookie.
  Pulls cookies via `@decocms/start/sdk/cookie`.
- `middleware.ts` — passthrough today; real-world cart-id reconciliation
  lives in the consumer site for now.
- `index.ts` — re-export entry.

## Pending port (PR follow-ups)

| Path | Original location |
|---|---|
| `loaders/product/{detailsPage,detailsPageGQL,listingPage,list,relatedProducts}.ts` | `deco-cx/apps/magento/loaders/product/*` |
| `loaders/{proxy,user,wishlist}.ts` | `deco-cx/apps/magento/loaders/*` |
| `loaders/routes/getRouteType.ts` | idem |
| `actions/cart/{addCoupon,addItem,removeCoupon,removeItem,setSimulation,simulation,updateItem}.ts` | `deco-cx/apps/magento/actions/cart/*` |
| `actions/newsletter/subscribe.ts` | idem |
| `actions/product/stockAlert.ts` | idem |
| `actions/wishlist/{addItem,removeItem}.ts` | idem |
| `utils/{clientGraphql,client,transform,cache,graphql,cart}.ts` | `deco-cx/apps/magento/utils/*` |
| `hooks/{useCart,useUser,useWishlist}.ts` | `deco-cx/apps/magento/hooks/*` (refactor to react-query, like `vtex/hooks/`) |
| `inline-loaders/*` | new, follow `vtex/inline-loaders/` shape |

**Site-specific extensions (Livelo, Amasty)** in the deco-cx/apps repo
should stay out of this package — they belong in consumer sites via the
`ExtensionOf` pattern. Preserving that pattern in the generic loaders
above is a hard requirement of this port.

## Why a stub now

The deco-sites/granadobr-tanstack migration hit a HIGH parity finding:

```
invoke(magento/loaders/features) failed: handler not found
```

…because no `@decocms/apps/magento/*` resolver existed. The site is
working around it locally; this PR begins the upstream fix so future
magento sites don't have to repeat the in-site adapter.
