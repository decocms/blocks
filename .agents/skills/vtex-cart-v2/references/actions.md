# Write-path actions v2 (`@decocms/apps-vtex/actions/checkout`)

Four cart actions with explicit `sections` + `projection` params, exported alongside the legacy v1 actions (zero breaking changes).

```ts
import {
  getOrCreateCartV2,
  addItemsToCartV2,
  updateCartItemsV2,
  addCouponToCartV2,
} from "@decocms/apps-vtex/actions/checkout";
```

Each accepts:

```ts
interface CartV2Options {
  sections?: CartSection[];      // default: SECTIONS_MINIMAL
  projection?: CartProjection;   // default: "summary+items"
  minicartOptions?: ProjectOrderFormOptions; // freeShippingTarget, locale, etc.
}
```

VTEX always returns an OrderForm from mutation endpoints. The action sends `expectedOrderFormSections` to limit what VTEX computes, then calls `projectOrderForm` server-side before returning to the browser. The browser never sees raw VTEX data unless `projection: "raw"` is requested.
