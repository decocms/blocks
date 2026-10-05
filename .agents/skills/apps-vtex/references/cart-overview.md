# VTEX Cart v2 — Modular, Granular, Framework-Agnostic

Contract types live in `@decocms/apps-commerce/types/cart`; loaders, `*V2` actions and hooks in `@decocms/apps-vtex`. Framework-agnostic: wiring covers TanStack Start (`@decocms/tanstack`, generated invoke) and Next.js (`@decocms/nextjs`, `handleInvoke`).

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

## Cart v2 references

| Reference | Load it when |
|---|---|
| [`cart-contract.md`](./cart-contract.md) | Choosing a `projection` or `sections` preset — the types, what each returns, the badge/toast/drawer rule of thumb |
| [`cart-loaders.md`](./cart-loaders.md) | Reading cart data: `cart/summary`, `cart/full`, `cart/shipping`, `cart/gifts`, `cart/attachments` — inputs, outputs, which sections each asks for |
| [`cart-actions.md`](./cart-actions.md) | Calling the `*V2` mutations directly — options and the server-side projection step |
| [`cart-hooks.md`](./cart-hooks.md) | Using `createCart` hooks (`useCartSummary`, `useAddToCart`, `useCart`, `useShipping`, `useGifts`, `useAttachments`, `resetCart`) and what `add()` does step by step |
| [`cart-react-query-adapter.md`](./cart-react-query-adapter.md) | The site already uses `@tanstack/react-query` and wants `createCartQuery` instead of the singleton factory |
| [`cart-wiring.md`](./cart-wiring.md) | Making `invoke.vtex.actions.*V2` and `invoke.vtex.loaders.cart.*` exist in a TanStack Start or Next.js site |
| [`cart-migrating-from-legacy.md`](./cart-migrating-from-legacy.md) | Moving a live site off `useCart`/`createUseCart` without a diverging badge |

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
| Shipping estimate (cache hit) | 0 | `{ postalCode, options }` — ~1 KB |

Shipping is cached at two layers: client-side, `createCartQuery`'s `useShipping` is keyed by `{ postalCode, items }` with a 5 min `staleTime`; server-side, `cart/shipping` goes through `getShippingSimulation` (`loaders/cart/shipping.ts`), which caches the simulation response body for 5 min keyed on `{account, salesChannel, items, postalCode, country}` (issue #373).

---

## Constraints and footguns

- **`vtexFetchWithCookies` is mandatory for all cart mutations.** `vtexFetch` / `vtexCachedFetch` must not be used — they do not rotate `checkout.vtex.com` / `CheckoutOrderFormOwnership` cookies, causing the storefront's cart to drift from VTEX's server-side state.
- **Shipping simulation has its own cache, not `vtexCachedFetch`.** `simulateCart` is a POST that rotates cookies, so `utils/simulationCache.ts` stores only the response body (never cookies) in an in-process Map (500 entries); sites can inject a shared Cloudflare Cache API / KV implementation via `setSimulationCache`. Done in [issue #373](https://github.com/decocms/blocks/issues/373).
- **`createCart` is a factory; call it once.** Each call produces an independent module-singleton. Calling it inside a component creates a new singleton per render — always call at module scope.
- **`projection: "none"` + `projection: "minicart"` in the same add**: pick one. `"none"` discards the server response; `"minicart"` uses it to populate the drawer. They cannot be combined.
- The legacy `useCart`, `createUseCart`, `loaders/cart.ts`, and `loaders/minicart.ts` are untouched. Cart v2 is additive — migrate gradually per component.
