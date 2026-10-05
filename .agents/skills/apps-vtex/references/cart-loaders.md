# Read-path loaders (`vtex/loaders/cart/*`)

Five loaders, each requesting only the sections it needs. All registered in the app manifest (`vtex/loaders/cart/*`) and callable via `invoke` in both frameworks.

### `vtex/loaders/cart/summary` — badge

```ts
// Returns CartSummary: { orderFormId, totalItems, total }
// No VTEX call if there is no orderForm cookie.
// data: { orderFormId?: string } — omit it to read the request cookie
await invoke.vtex.loaders.cart.summary({ data: {} });
```

Use case: SSR-hydrating the cart badge on first load. If the cookie is absent, returns `{ orderFormId: null, totalItems: 0, total: 0 }` without hitting VTEX.

### `vtex/loaders/cart/full` — drawer

```ts
// Returns Minicart<OrderForm | null>
// Requests SECTIONS_DRAWER only (9 sections, not 15).
// data (all optional): { orderFormId, freeShippingTarget, locale, checkoutHref, enableCoupon }
await invoke.vtex.loaders.cart.full({
  data: { freeShippingTarget: 15000, locale: "pt-BR", checkoutHref: "/checkout", enableCoupon: true },
});
```

### `vtex/loaders/cart/shipping` — shipping estimate for the drawer

```ts
// Returns CartShipping: { postalCode, options: ShippingOption[] }
// Prices in major units. SLAs deduplicated across all line items.
// data: { items: Array<{ id: string | number; quantity: number; seller: string }>; postalCode: string; country?: string }
await invoke.vtex.loaders.cart.shipping({
  data: { items: [{ id: "123", quantity: 1, seller: "1" }], postalCode: "01310-100", country: "BRA" },
});
```

> **Note on caching**: shipping options for a fixed `{ items, postalCode }` are not user-personalized, but `simulateCart` is a POST that rotates cookies, so it can't go through `vtexCachedFetch`. The bespoke layer from [GitHub issue #373](https://github.com/decocms/blocks/issues/373) is implemented: the loader runs `getShippingSimulation`, which caches only the response body (5 min default, `ttlSeconds` overrides) keyed on `{account, salesChannel, items, postalCode, country}` via `utils/simulationCache.ts` (in-process by default; inject a shared one with `setSimulationCache`). See [`fetch-cache.md`](./fetch-cache.md).

### `vtex/loaders/cart/gifts` — selectable gifts / promotions

```ts
// Returns CartGifts: { orderFormId, selectableGifts, ratesAndBenefits }
// Requests only ["items", "ratesAndBenefitsData", "messages"].
// data: { orderFormId?: string }
await invoke.vtex.loaders.cart.gifts({ data: {} });
```

### `vtex/loaders/cart/attachments` — item attachments

```ts
// Returns CartItemAttachments: { orderFormId, itemIndex, attachments, attachmentOfferings }
// Requests only ["items"].
// data: { orderFormId?: string; itemIndex: number } — itemIndex is required (selects the line)
await invoke.vtex.loaders.cart.attachments({ data: { itemIndex: 0 } });
```
