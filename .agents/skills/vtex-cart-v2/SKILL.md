---
name: vtex-cart-v2
description: Cart v2 for VTEX storefronts — modular, granular, framework-agnostic. Explains the thesis (reduce cart API traffic, lazy cart creation, projection/sections fragmentation), the available hooks and loaders, and how to wire them in a Next.js or TanStack Start site.
---

# VTEX Cart v2 — Modular, Granular, Framework-Agnostic

## The problem with the legacy cart

The legacy VTEX cart (`loaders/cart.ts`, `hooks/useCart.ts`, `hooks/createUseCart.ts`) has three structural inefficiencies:

1. **Every mutation returns the full OrderForm.** All 15 `expectedOrderFormSections` are hardcoded. Adding one item, changing a quantity, or applying a coupon all return the same ~40 KB payload — even when the UI only needs to update a badge number.

2. **Cart created on page load for every visitor.** `createUseCart` calls `getOrCreateCart` inside a `useEffect` on mount. A VTEX OrderForm is provisioned for ~70–90% of visitors who never click "add to cart". This is a real cost: the VTEX Checkout API creates a session, writes to their order-management store, and starts tracking an order — for a user who is just browsing.

3. **No granularity, no cache opportunity.** There is no way to ask "just the gifts", "just the drawer shipping options", or "just the coupon fields". Because all data is fetched together and from the browser (with `credentials: "include"`), there is no server-side projection layer and nothing to cache.

## The Cart v2 thesis

**Two independent knobs per operation:**

- **`sections`** — what you ask VTEX to compute (`expectedOrderFormSections`). Fewer sections = smaller VTEX payload + less server-side compute.
- **`projection`** — what the server sends to the browser. Independent of `sections`. You can request a full VTEX OrderForm and project only the badge totals, or request `SECTIONS_MINIMAL` and project the full drawer.

**Default: the minimum.** Every hook and loader defaults to the cheapest option. Requesting more is always explicit (opt-in, not opt-out).

**Lazy cart creation.** No OrderForm is provisioned until the first add-to-cart. A visitor reading product pages generates exactly zero calls to `/api/checkout/pub/orderForm`.

**Optimistic updates + reconciliation in the hook.** The storefront never re-implements debounce, rollback, or server-reconciliation. The badge increments immediately and reconciles from the projected server response.

---

## Contract (platform-agnostic, in `@decocms/apps-commerce`)

```ts
import type { CartProjection, CartSection, CartSummary, CartSummaryWithItems, CartOk, CartItemSlim } from "@decocms/apps-commerce/types/cart";
import { SECTIONS_MINIMAL, SECTIONS_DRAWER, SECTIONS_FULL, defaultSectionsFor } from "@decocms/apps-commerce/types/cart";
```

### `CartProjection`

| Value | What goes to the browser | When to use |
|---|---|---|
| `"none"` | `{ ok: true }` | Pure optimistic update, zero reconciliation data needed |
| `"summary"` | `{ orderFormId, totalItems, total }` | Badge-only refresh |
| `"summary+items"` | summary + slim line items | **Default for add-to-cart** |
| `"minicart"` | Full canonical `Minicart` | Opening the drawer |
| `"raw"` | Untouched VTEX OrderForm | GTM, pixels, custom integrations |

### `CartSection` presets

| Preset | Sections | Use |
|---|---|---|
| `SECTIONS_MINIMAL` | `items, totalizers, messages` | All mutations by default |
| `SECTIONS_DRAWER` | 9 sections (+ sellers, marketing, shipping…) | `cart/full` loader |
| `SECTIONS_FULL` | All 15 | Legacy parity / `projection: "raw"` |

`defaultSectionsFor(projection)` returns the right preset if you don't specify sections explicitly.

### Choosing the projection

The projection is a latency-vs-data trade-off. Pick the cheapest one that carries what the UI actually renders — the whole point is not shipping data you won't use.

| I want to… | `projection` | Why |
|---|---|---|
| Just update the badge number | `"summary"` | Smallest payload that still carries the count |
| Show a toast "added: `<product>`" | `"summary+items"` *(default)* | Slim item (name/image/price/variant) already comes back from `add()` — no second fetch |
| Open the drawer right after add | `"minicart"` | Populates the drawer from the same response — avoids a follow-up `cart/full` round-trip |
| 100% optimistic UI, no confirmation | `"none"` | Discards the payload server-side; zero reconciliation |
| Feed GTM / a pixel / a custom integration | `"raw"` | Untouched OrderForm — you map it yourself |

Rule of thumb: **badge → `summary`, toast → `summary+items`, drawer → `minicart`.** Only reach for `raw` when a third-party integration needs the native VTEX shape.

---

## Loaders (read-path)

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

---

## Actions v2 (write-path)

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

---

## Hooks (client-side factory)

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

## Optional: TanStack Query adapter

For sites already using `@tanstack/react-query`, the factory-less adapter provides the same API wired into a QueryClient:

```ts
import { createCartQuery } from "@decocms/apps-vtex/hooks/cartQuery";
import { invoke } from "~/server/invoke";

export const {
  useCartSummary, useCartFull, useAddToCart, useShipping, useGifts, useAttachments,
} = createCartQuery({ invoke });
```

Full parity with the factory — six hooks. Key differences vs `createCart`:
- `useCartSummary`, `useCartFull`, `useGifts`, `useAttachments(itemIndex)` return standard `useQuery` results with `enabled: false` by default — lazy, opt-in per call.
- `useShipping({ items, postalCode })` is a `useQuery` **keyed by `{ postalCode, items }`** with a 5 min `staleTime`. Because shipping options are not user-personalized, this gives you client-side cache + dedupe for free — the caching the server-side loader can't do yet (see [issue #373](https://github.com/decocms/blocks/issues/373)). `enabled` turns on automatically when a postal code + items are present.
- `useAddToCart` returns a standard `useMutation` with `onMutate` optimistic bump + `onError` rollback + `onSuccess` reconciliation (badge, or `FULL_KEY` cache when `projection: "minicart"`).
- Requires `QueryClientProvider` in the tree.

Import this adapter only if you have `@tanstack/react-query` in your site — it is declared as an optional peer dependency in `@decocms/apps-vtex`.

---

## Wiring in TanStack Start

The four v2 actions (`getOrCreateCartV2`, `addItemsToCartV2`, `updateCartItemsV2`, `addCouponToCartV2`) are already declared in `packages/apps-vtex/src/invoke.ts`. After `bun link` / installing the package, run the invoke generator to emit the site-local `createServerFn` bindings:

```bash
npm run generate:invoke
# or, if using the unified orchestrator:
npm run generate
```

The generated handler automatically calls `forwardResponseCookies()`, so the VTEX `checkout.vtex.com` and `CheckoutOrderFormOwnership` cookies reach the browser — the cart stays linked to the right OrderForm.

## Wiring in Next.js

Loaders and actions are called through `handleInvoke` (mounted at `app/deco/[[...deco]]/route.ts`). No extra generator step: `invoke.vtex.loaders.cart.*` and `invoke.vtex.actions.*V2` resolve via the manifest registered in `setupApps`. Cookie forwarding is handled by `vtexFetchWithCookies` inside each action.

---

## Migrating gradually from the legacy cart

Cart v2 is **additive** — the legacy `useCart` / `createUseCart` keep working untouched. But the two systems hold **independent state**: `createCart` is its own module-singleton and does not share the badge count, cart cookie read timing, or listeners with `createUseCart`. During the transition, keep **one source of truth for the badge** — don't let a v1 badge and a v2 badge run side by side, or they will diverge (v1 creates a cart on mount and counts eagerly; v2 is lazy).

Recommended order, component by component:

1. **Badge + add-to-cart together** → `useCartSummary` + `useAddToCart`. Migrate these as a pair: the badge's source of truth must be the same singleton that `add()` reconciles into. This is also where you get the biggest win — the eager on-mount cart creation disappears.
2. **Drawer** → `useCart({ include: { full: open } })`. Replace the legacy drawer's `fetchCart`/`getOrCreateCart` reads. `updateQuantity` / `removeItem` / `addCoupon` return the projected `Minicart`.
3. **On-demand extras** → `useShipping`, `useGifts`, `useAttachments`. These had no legacy equivalent as separate reads; wire them where the drawer previously pulled everything at once.

Until every add-to-cart entry point is on v2, do not delete the legacy hooks — a mixed page (v1 PDP button + v2 badge) will show a stale count because the two singletons don't notify each other.

---

## Traffic impact summary

| Scenario (legacy) | VTEX API calls | Payload |
|---|---|---|
| Visitor lands, no add | 1 `getOrCreateCart` on mount | ~40 KB OrderForm |
| Add to cart | 1 `addItems` with 15 sections | ~40 KB OrderForm |
| Open drawer | 1 `getCartFull` with 15 sections | ~40 KB OrderForm |

| Scenario (Cart v2) | VTEX API calls | Payload to browser |
|---|---|---|
| Visitor lands, no add | **0** | 0 |
| Add to cart (default) | 1 `addItemsToCartV2` with **3 sections** | `{ totalItems, total, items:[slim] }` — ~1 KB |
| Open drawer | 1 `cart/full` with **9 sections** | Full Minicart — ~10 KB |
| Shipping estimate (after caching) | 0 (cache hit) | `{ postalCode, options }` — ~1 KB |

---

## Constraints and footguns

- **`vtexFetchWithCookies` is mandatory for all cart mutations.** `vtexFetch` / `vtexCachedFetch` must not be used — they do not rotate `checkout.vtex.com` / `CheckoutOrderFormOwnership` cookies, causing the storefront's cart to drift from VTEX's server-side state.
- **Shipping simulation is not cached yet.** `simulateCart` is a POST that rotates cookies — a bespoke cache layer is required. Tracked at [issue #373](https://github.com/decocms/blocks/issues/373).
- **`createCart` is a factory; call it once.** Each call produces an independent module-singleton. Calling it inside a component creates a new singleton per render — always call at module scope.
- **`projection: "none"` + `projection: "minicart"` in the same add**: pick one. `"none"` discards the server response; `"minicart"` uses it to populate the drawer. They cannot be combined.
- The legacy `useCart`, `createUseCart`, `loaders/cart.ts`, and `loaders/minicart.ts` are untouched. Cart v2 is additive — migrate gradually per component.
