# Read-path loaders (`vtex/loaders/cart/*`)

Five loaders, each requesting only the sections it needs. All registered in the app manifest (`vtex/loaders/cart/*`) and callable via `invoke` in both frameworks.

### `vtex/loaders/cart/summary` — badge

```ts
// Returns CartSummary: { orderFormId, totalItems, total }
// No VTEX call if there is no orderForm cookie.
await invoke.vtex.loaders.cart.summary({ data: { orderFormId?: string } });
```

Use case: SSR-hydrating the cart badge on first load. If the cookie is absent, returns `{ orderFormId: null, totalItems: 0, total: 0 }` without hitting VTEX.

### `vtex/loaders/cart/full` — drawer

```ts
// Returns Minicart<OrderForm | null>
// Requests SECTIONS_DRAWER only (9 sections, not 15).
await invoke.vtex.loaders.cart.full({
  data: {
    orderFormId?: string;
    freeShippingTarget?: number;
    locale?: string;
    checkoutHref?: string;
    enableCoupon?: boolean;
  }
});
```

### `vtex/loaders/cart/shipping` — shipping estimate for the drawer

```ts
// Returns CartShipping: { postalCode, options: ShippingOption[] }
// Prices in major units. SLAs deduplicated across all line items.
await invoke.vtex.loaders.cart.shipping({
  data: {
    items: Array<{ id: string | number; quantity: number; seller: string }>;
    postalCode: string;
    country?: string;
  }
});
```

> **Note on caching**: shipping options for a fixed `{ items, postalCode }` are not user-personalized, but `simulateCart` is a POST that rotates cookies. A bespoke cache layer is tracked at [GitHub issue #373](https://github.com/decocms/blocks/issues/373) — caching is not implemented yet.

### `vtex/loaders/cart/gifts` — selectable gifts / promotions

```ts
// Returns CartGifts: { orderFormId, selectableGifts, ratesAndBenefits }
// Requests only ["items", "ratesAndBenefitsData", "messages"].
await invoke.vtex.loaders.cart.gifts({ data: { orderFormId?: string } });
```

### `vtex/loaders/cart/attachments` — item attachments

```ts
// Returns CartItemAttachments: { orderFormId, itemIndex, attachments, attachmentOfferings }
// Requests only ["items"].
await invoke.vtex.loaders.cart.attachments({ data: { orderFormId?: string; itemIndex?: number } });
```
