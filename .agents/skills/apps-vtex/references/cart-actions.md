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
  sections?: CartSection[];      // default: defaultSectionsFor(projection)
  projection?: CartProjection;   // default: "summary+items"
  minicartOptions?: ProjectOrderFormOptions; // freeShippingTarget, locale, etc.
}
```

Omitting `sections` resolves them from the projection (`defaultSectionsFor`): `SECTIONS_MINIMAL` for `none` / `summary` / `summary+items`, `SECTIONS_DRAWER` for `minicart`, `SECTIONS_FULL` for `raw`. Don't pass `SECTIONS_MINIMAL` explicitly with `projection: "minicart"` or `"raw"` — the projection would be built from an incomplete OrderForm.

VTEX always returns an OrderForm from mutation endpoints. The action sends `expectedOrderFormSections` to limit what VTEX computes, then calls `projectOrderForm` server-side before returning to the browser. The browser never sees raw VTEX data unless `projection: "raw"` is requested.
