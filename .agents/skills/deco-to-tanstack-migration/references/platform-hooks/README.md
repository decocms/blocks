# Platform Hooks Migration (legacy reference)

> **This document describes the pre-Wave-12 manual approach.** New
> migrations should follow
> [`platform-hooks-factories.md`](../platform-hooks-factories.md), which
> covers the `createUseCart` / `createUseUser` / `createUseWishlist`
> factories from `@decocms/apps/vtex/hooks`. The factories collapse
> everything below into a 5-line site shim per hook.
>
> This file is kept for sites that scaffolded before the factories
> existed — typically sites with `src/lib/vtex-cart-server.ts` or
> hand-rolled `createServerFn` calls to VTEX endpoints inside
> `src/hooks/useCart.ts`. See the **"Migrating off the manual approach"**
> section in the new doc for the cleanup playbook.

---

## Strategy (legacy)

All hooks are **site-local**. No Vite alias tricks. No compat layers.

- Active platform hooks (VTEX for this store) → `~/hooks/useCart.ts` with real implementation
- Inactive platform hooks (Wake, Shopify, etc.) → `~/hooks/platform/{name}.ts` with no-op stubs
- Auth hooks → `~/hooks/useUser.ts`, `~/hooks/useWishlist.ts`

## VTEX useCart (Manual Implementation)

### Why Server Functions Are Required

The storefront domain (e.g., `my-store.deco.site`) differs from the VTEX checkout domain (`account.vtexcommercestable.com.br`). Direct browser `fetch()` calls are blocked by CORS. Additionally, VTEX API credentials (`AppKey`/`AppToken`) must stay server-side.

Use TanStack Start `createServerFn` to create server-side proxy functions that the client hook calls transparently.

### Server Functions (`~/lib/vtex-cart-server.ts`)

```typescript
import { createServerFn } from "@tanstack/react-start";

const ACCOUNT = "myaccount";
const API_KEY = process.env.VTEX_APP_KEY!;
const API_TOKEN = process.env.VTEX_APP_TOKEN!;

export const getOrCreateCart = createServerFn({ method: "GET" })
  .validator((orderFormId: string) => orderFormId)
  .handler(async ({ data: orderFormId }) => {
    const url = orderFormId
      ? `https://${ACCOUNT}.vtexcommercestable.com.br/api/checkout/pub/orderForm/${orderFormId}`
      : `https://${ACCOUNT}.vtexcommercestable.com.br/api/checkout/pub/orderForm`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VTEX-API-AppKey": API_KEY,
        "X-VTEX-API-AppToken": API_TOKEN,
      },
      body: JSON.stringify({
        expectedOrderFormSections: [
          "items",
          "totalizers",
          "shippingData",
          "clientPreferencesData",
          "storePreferencesData",
          "marketingData",
        ],
      }),
    });
    return res.json();
  });
```

> **Don't write code like this in new sites.** The factories already wrap
> all canonical VTEX action endpoints (cart, session, masterdata,
> newsletter, checkout) in `@decocms/apps/vtex/actions/*`. The migration
> template scaffolds `src/server/invoke.gen.ts` which exposes them as
> typed server functions; `~/server/invoke.ts` then re-exports them
> under `invoke.vtex.actions.*`. The factory consumes that surface and
> returns the legacy hook shape.

### Hook (`~/hooks/useCart.ts`)

Key design decisions of the legacy manual hook:
- **Module-level singleton state** shared across all component instances
- **Pub/sub pattern** (`_listeners` Set) for notifying React components of changes
- **Cookie-based session**: reads/writes `checkout.vtex.com__orderFormId` on the **client** side
- Returns `cart` and `loading` with `.value` getter/setter for backward compat with Preact-era components
- Lazy initialization: cart is fetched on first component mount, not on module load
- Exports `itemToAnalyticsItem` for cart-specific analytics mapping

The factory in `@decocms/apps/vtex/hooks/createUseCart` ships *exactly*
these semantics — that's the implementation behind the new shim. If your
site needs to extend behaviour (e.g. extra analytics events, custom
post-add hooks), prefer wrapping the factory's exports rather than
forking back to a manual hook; the factory leaves space for that
without giving up the upgrade path.

### Cross-Domain Checkout

The minicart's "Finalizar Compra" button must link to the VTEX checkout domain with the `orderFormId` as a query parameter — the VTEX domain can't read the storefront's cookies:

```typescript
const checkoutUrl = `https://secure.${STORE_DOMAIN}/checkout/?orderFormId=${orderFormId}`;
```

This pattern is unchanged by the factory — it's a UI concern, not a hook
concern. Implement it in your minicart component as before.

## Inactive Platform Stubs

For non-VTEX platforms, create minimal no-op files:

```typescript
// ~/hooks/platform/wake.ts
export function useCart() {
  return {
    cart: { value: null },
    loading: { value: false },
    addItem: async (_params: any) => {},
    updateItems: async (_params: any) => {},
    removeItem: async (_index: any) => {},
  };
}

export function useUser() {
  return {
    user: { value: null as { email?: string; name?: string } | null },
    loading: { value: false },
  };
}

export function useWishlist() {
  return {
    loading: { value: false },
    addItem: async (_props: any) => {},
    removeItem: async (_props: any) => {},
    getItem: (_props: any) => undefined as any,
  };
}
```

Create similar stubs for: `shopify.ts`, `linx.ts`, `vnda.ts`, `nuvemshop.ts`. Match the return shape to what each platform's AddToCartButton expects (some use `addItem`, others `addItems`).

The factory equivalent for non-VTEX sites is documented in
[`platform-hooks-factories.md` § "Non-VTEX platforms"](../platform-hooks-factories.md#non-vtex-platforms).
Until each platform has its own factory in `@decocms/apps`, the stub
shape above is still correct — but use `@decocms/start/sdk/signal`
instead of hand-rolled `{ value: ... }` objects.

## Import Rewrites

```bash
sed -i '' 's|from "apps/vtex/hooks/useCart.ts"|from "~/hooks/useCart"|g'
sed -i '' 's|from "apps/vtex/hooks/useUser.ts"|from "~/hooks/useUser"|g'
sed -i '' 's|from "apps/vtex/hooks/useWishlist.ts"|from "~/hooks/useWishlist"|g'
sed -i '' 's|from "apps/vtex/utils/types.ts"|from "~/types/vtex"|g'
sed -i '' 's|from "apps/shopify/hooks/useCart.ts"|from "~/hooks/platform/shopify"|g'
sed -i '' 's|from "apps/wake/hooks/useCart.ts"|from "~/hooks/platform/wake"|g'
```

## Verification

```bash
grep -r 'from "apps/' src/ --include='*.ts' --include='*.tsx'
# Should return ZERO matches
```
