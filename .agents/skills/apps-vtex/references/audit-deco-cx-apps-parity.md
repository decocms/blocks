# Audits 7–9 — parity with deco-cx/apps (hooks, transform.ts, schema.org pages)

## Hooks Completeness

Compare with original `deco-cx/apps` hooks:

| Hook | Must Have |
|------|-----------|
| `useCart` | `addItems`, `updateQuantity`, `removeItem`, `addCoupons`, `fetchCart` |
| `useUser` | Server-side session check via `/api/sessions` |
| `useWishlist` | `add`, `remove`, `toggle`, `isInWishlist` |


## transform.ts Parity

All exported functions must match the original:

```
toProduct, toProductPage, pickSku, aggregateOffers, forceHttpsOnAssets,
sortProducts, filtersFromURL, mergeFacets, legacyFacetToFilter,
toFilter, categoryTreeToNavbar, toBrand, toReview, toInventories,
toPlace, toPostalAddress, parsePageType, normalizeFacet
```

Critical: `seller: sellerId` (not `sellerName`) in `buildOffer`.


## Page Structure (schema.org)

| Page | Required Structure |
|------|--------------------|
| PDP | `ProductDetailsPage` with `breadcrumbList` + `product` (via `toProductPage`) + `seo` |
| PLP | `ProductListingPage` with `BreadcrumbList` + `filters` + `products` + `pageInfo` + `sortOptions` + `seo` |
