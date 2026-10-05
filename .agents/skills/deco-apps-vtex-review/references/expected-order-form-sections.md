# Audit 3 — `expectedOrderFormSections`

VTEX Checkout API returns incomplete OrderForm without explicit sections. Every POST to `/api/checkout/pub/orderForm` must include:

```typescript
import { DEFAULT_EXPECTED_SECTIONS } from "../actions/checkout";

body: JSON.stringify({ expectedOrderFormSections: DEFAULT_EXPECTED_SECTIONS })
```

**Full list** — `DEFAULT_EXPECTED_SECTIONS` in `actions/checkout.ts` is now an alias of `SECTIONS_FULL` from `@decocms/apps-commerce/types` (the "which sections" list lives there, alongside the smaller `SECTIONS_MINIMAL` / `SECTIONS_DRAWER` presets that Cart v2 uses — see the `vtex-cart-v2` skill). The values are unchanged:

```typescript
export const DEFAULT_EXPECTED_SECTIONS = [
  "items",
  "totalizers",
  "clientProfileData",
  "shippingData",
  "paymentData",
  "sellers",
  "messages",
  "marketingData",
  "clientPreferencesData",
  "storePreferencesData",
  "giftRegistryData",
  "ratesAndBenefitsData",
  "openTextField",
  "commercialConditionData",
  "customData",
];
```

**Audit**: Check `loaders/cart.ts` and `hooks/useCart.ts` — both must send this body. Also used in `actions/checkout.ts` (all cart mutations). Note `hooks/useCart.ts` keeps its own local copy of the list (it's client code and doesn't import `actions/checkout`) — check it hasn't drifted from `SECTIONS_FULL`. The Cart v2 actions (`*V2`) intentionally send fewer sections; that's not this bug.


## Fix: Missing expectedOrderFormSections

```typescript
// Before
await vtexFetch<OrderForm>(`/api/checkout/pub/orderForm`, { method: "POST", headers });
// After
import { DEFAULT_EXPECTED_SECTIONS } from "../actions/checkout";
await vtexFetch<OrderForm>(`/api/checkout/pub/orderForm`, {
  method: "POST", headers,
  body: JSON.stringify({ expectedOrderFormSections: DEFAULT_EXPECTED_SECTIONS }),
});
```
