# Wiring Cart v2 into a site (TanStack Start, Next.js)

## Wiring in TanStack Start

The four v2 actions (`getOrCreateCartV2`, `addItemsToCartV2`, `updateCartItemsV2`, `addCouponToCartV2`) are already declared in `packages/apps-vtex/src/invoke.ts`. After `bun link` / installing the package, run the generator to emit the site-local `createServerFn` bindings into `src/server/invoke.gen.ts`:

```bash
npm run generate
```

`npm run generate` is the `@decocms/blocks-cli` orchestrator (`scripts/generate.ts`); its invoke stage is `generate-invoke.ts`. Sites no longer scaffold a separate `generate:invoke` script (an earlier version of this doc showed one).

**The loaders are not generated.** `generate-invoke.ts` only emits `invoke.vtex.actions.*` — the generated `invoke` is `{ vtex: { actions: vtexActions } }`. `createCart({ invoke })` also calls `invoke.vtex.loaders.cart.{summary,full,shipping,gifts,attachments}` (see `CreateCartInvoke` in `packages/apps-vtex/src/hooks/createCart.ts`), so on TanStack the site's hand-written `src/server/invoke.ts` must add those five as top-level `createServerFn` declarations wrapping the default exports of `@decocms/apps-vtex/loaders/cart/*`, and merge them next to `vtexActions` (pattern: `deco-server-functions-invoke` → `references/architecture.md`, "Layer 3.5").

The generated handler automatically calls `forwardResponseCookies()`, so the VTEX `checkout.vtex.com` and `CheckoutOrderFormOwnership` cookies reach the browser — the cart stays linked to the right OrderForm.

## Wiring in Next.js

Loaders and actions are called through `handleInvoke` (mounted at `app/deco/[[...deco]]/route.ts`). No extra generator step: `invoke.vtex.loaders.cart.*` and `invoke.vtex.actions.*V2` resolve via the manifest registered in `setupApps`. Cookie forwarding is handled by `vtexFetchWithCookies` inside each action.
