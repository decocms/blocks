# Cookie forwarding — cart "forgets" items

## Symptom: cart "forgets" items between requests / /checkout opens empty after addItemToCart

**Symptom**: `invoke.vtex.actions.addItemsToCart(...)` succeeds (returns an `OrderForm` with items), but the next page load — or clicking the cart icon — shows an empty cart, and `/checkout` lands on a fresh empty order. Sometimes the orderFormId is different from the one just returned.

**Root cause**: The VTEX cart cookies (`checkout.vtex.com__orderFormId`, `segment`, `sc`, `vtex_session`) never reach the browser because somewhere in the chain, multiple `Set-Cookie` headers got collapsed into a single comma-joined string. Browsers silently discard malformed `Set-Cookie` values, so every subsequent request hits VTEX without authentication and gets a new empty orderForm.

**Two places this can break**:

1. **`src/server/invoke.gen.ts` missing or stale**. This is the TanStack RPC path. Each action must call `forwardResponseCookies()` after awaiting the underlying VTEX call. The helper uses `Headers.getSetCookie()` (not `entries()`!) to read the un-collapsed list and writes each value to TanStack's response via `setResponseHeader("set-cookie", [...])`. If the file doesn't exist, the site falls back to the `/deco/invoke/...` proxy. If you hand-wrote a cookie-mutating action in the site's `src/server/invoke.ts` composition file instead of going through the generator (see `generator.md`'s "Site-Local Composition"), it needs the same forwarding — via the public `forwardResponseCookies(cookies)` from `@decocms/tanstack/sdk/cookiePassthrough`, since the generated helper is private to `invoke.gen.ts` (snippet in `architecture.md`'s "Layer 3.5") — it's easy to miss because the `deco-to-tanstack-migration` skill's `references/server-functions/README.md` (lives in decocms/migrations), which documents that hand-written pattern, doesn't mention it.

2. **`/deco/invoke/...` HTTP proxy** (`~/runtime.ts` pattern). The framework's admin handler — now `packages/blocks-admin/src/admin/invoke.ts` (published as part of `@decocms/blocks-admin`; this file lived at `@decocms/start/src/admin/invoke.ts` before the package split) — used to iterate `RequestContext.responseHeaders.entries()` which collapses Set-Cookie. Fixed by switching to `getSetCookie()` + a `forwardCtxHeadersTo()` helper applied on both single and batch paths (`packages/blocks-admin/src/admin/invoke.ts` — search the file to confirm both handlers call it on your checkout).

**Diagnosis**: Open DevTools → Network → response to the cart action. You should see **multiple distinct** `Set-Cookie:` rows. If you see a single `Set-Cookie: foo=1, bar=2; Path=/, baz=3` line, that's the collapse bug.

**Fix**:
1. Make sure the linked `@decocms/blocks-admin` checkout has `forwardCtxHeadersTo` in `src/admin/invoke.ts` (search the file — both single and batch handlers should call it).
2. Run `npm run generate` (the orchestrator; its invoke stage is `generate-invoke.ts`) to regenerate `src/server/invoke.gen.ts`. Verify it has `function forwardResponseCookies()` and that every emitted handler calls it.
3. Make sure `useCart` (and other VTEX hooks) imports `invoke` from `~/server/invoke` — the hand-written composition file that merges `vtexActions` from `invoke.gen.ts` (see `architecture.md`'s "Layer 3.5") — not from `~/runtime`.
4. The migration script (`scripts/migrate.ts` bootstrap) runs `generate-invoke.ts` automatically on freshly-migrated sites — if a site was migrated before that, run the generator manually.

**Client-side workaround** (defense-in-depth, removable): some sites manually `document.cookie = "checkout.vtex.com__orderFormId=..."` inside `useCart`. That only patches one cookie of many. With the server-side fix in place, the workaround is harmless but no longer load-bearing — some production sites still carry it in `src/hooks/useCart.ts`.

