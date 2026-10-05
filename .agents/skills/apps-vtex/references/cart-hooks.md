# Client hooks — the `createCart` factory

### Setup — `createCart`

Create the hooks once per site, inject the `invoke` proxy:

```ts
// src/hooks/cart.ts
import { createCart } from "@decocms/apps-vtex/hooks/createCart";
import { invoke } from "~/server/invoke"; // your generated TanStack / Next.js invoke

export const {
  useCart, useCartSummary, useAddToCart, useShipping, useGifts, useAttachments, resetCart,
} = createCart({ invoke });
```

Optional params:

```ts
createCart({
  invoke,
  orderFormCookieName?: string,   // default: "checkout.vtex.com__orderFormId"
  orderFormCookieMaxAge?: number,  // default: 7 days in seconds
});
```

Each call to `createCart` returns a **new module-singleton**: hooks returned from the same call share state, hooks from different calls are isolated. Call once per site.

---

### `useCartSummary()` — badge

Reads local state. **Never triggers a VTEX call by itself.**

```tsx
function CartBadge() {
  const { totalItems, loading } = useCartSummary();
  return <span>{loading ? "…" : totalItems}</span>;
}
```

---

### `useAddToCart(opts?)` — add to cart with built-in optimistic update

```tsx
function BuyButton({ id, seller }: { id: string; seller: string }) {
  const { add, loading } = useAddToCart();
  // default projection: "summary+items"

  return (
    <button disabled={loading} onClick={() => add({ id, seller, quantity: 1 })}>
      Add to cart
    </button>
  );
}
```

What happens on `add(...)`:
1. **Optimistic**: badge counter incremented immediately.
2. `ensureOrderFormId()` — checks cookie/state; calls `getOrCreateCartV2` only if no cart exists yet (lazy).
3. `addItemsToCartV2` called with `SECTIONS_MINIMAL` + the requested `projection`.
4. **Reconcile**: projected server response updates badge (or full minicart if `projection: "minicart"`).
5. On error: optimistic increment rolled back and the error re-thrown.

**`add()` returns the projected payload** — so you can drive a toast / analytics without a second fetch. With the default `summary+items`, the returned object is `{ totalItems, total, items: [slim] }`:

```tsx
const { add } = useAddToCart(); // default "summary+items"

async function onClick() {
  const res = await add({ id, seller }); // res: { totalItems, total, items: [{ item_name, image, price, item_variant, quantity }] }
  const added = res.items?.[0];
  if (added) toast(`Added: ${added.item_name}`, { image: added.image });
}
```

The drawer mutations (`updateQuantity`, `removeItem`, `addCoupon` on `useCart`) likewise return the projected `Minicart`.

**Custom projection:**

```ts
// Open the minicart drawer immediately after add — request full drawer data:
const { add } = useAddToCart({ projection: "minicart" });

// Pure optimistic, discard server data entirely:
const { add } = useAddToCart({ projection: "none" });
```

---

### `useCart(opts?)` — drawer / full cart

```tsx
function MiniCart({ open }: { open: boolean }) {
  const { minicart, summary, loading, updateQuantity, removeItem, addCoupon } = useCart({
    include: { full: open },   // only fetches the full cart when the drawer is open
    freeShippingTarget: 15000,
    locale: "pt-BR",
    checkoutHref: "/checkout",
    enableCoupon: true,
  });

  // ...
}
```

- `include.full: false` (default) — only summary is available; no VTEX call.
- `include.full: true` — triggers `cart/full` once (cancelled on unmount). Subsequent renders use cached `_minicart`.
- `updateQuantity(index, qty)` and `removeItem(index)` call `updateCartItemsV2` with `projection: "minicart"` and reconcile the drawer.
- `addCoupon(text)` calls `addCouponToCartV2` and reconciles.

---

### `useShipping()` — on-demand shipping estimate

```tsx
function ShippingEstimate() {
  const { estimate } = useShipping();

  async function handlePostalCode(postalCode: string) {
    const result = await estimate({ items, postalCode });
    setOptions(result.options);
  }
  // ...
}
```

---

### `useGifts()` — selectable gifts

```tsx
function GiftSelector() {
  const { load } = useGifts();
  useEffect(() => { load().then(setGifts); }, []);
  // ...
}
```

---

### `useAttachments()` — single-line attachments

On-demand read of one cart line's attachments + offered slots (engraving, gift wrap, …). Fetches only `["items"]`.

```tsx
function ItemCustomizer({ itemIndex }: { itemIndex: number }) {
  const { load } = useAttachments();
  useEffect(() => { load(itemIndex).then(setAttachments); }, [itemIndex]);
  // load(itemIndex) → { orderFormId, itemIndex, attachments, attachmentOfferings }
}
```

---

### `resetCart()` — after logout or order placed

```ts
import { resetCart } from "~/hooks/cart";
resetCart(); // clears module-singleton state + notifies all subscribers
```

---
