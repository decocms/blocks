# Client files and vendored loaders

v8 apps ship no loaders, actions, hooks or converters. A migrated site keeps the ones its
content uses as its own code, and calls the thin client from them. The
`deco-v7-to-v8-migration` skill's script does the copy; this file covers what it
leaves you and how to move that code onto the v8 client.

## What the migration script writes

**`src/clients/<app>.ts`**, one per v7 app block the content has (`deco-vtex`,
`deco-shopify`, `deco-wake`, `deco-resend`). Each exports a function that creates the
client on first use:

```ts
// src/clients/vtex.ts (shape of the generated file, TanStack Start)
import { createVtexClient, type VtexClient } from "@decocms/apps-vtex";
import { env } from "cloudflare:workers";

const variable = (name: string) =>
  (env as unknown as Record<string, string | undefined>)[name] || undefined;

export const vtexSettings = { publicUrl: "…", country: "…", invalidPageNotFound: false } as const;

let client: VtexClient | undefined;

export function vtexClient(): VtexClient {
  client ??= createVtexClient({
    account: "mystore",
    salesChannel: "1",
    appKey: variable("VTEX_APP_KEY"),
    appToken: variable("VTEX_APP_TOKEN"),
  });
  return client;
}
```

- Settings come from the saved block, with v7's defaults: VTEX sales channel `"1"`,
  Wake checkout `https://<account>.checkout.fbits.store`, and for Shopify the
  Storefront API version the installed v7 app used.
- A credential that was encrypted in content is read from the variable v7 fell back
  to: `VTEX_APP_KEY`, `VTEX_APP_TOKEN`, `SHOPIFY_STOREFRONT_TOKEN`, `WAKE_TOKEN`,
  `RESEND_API_KEY`. Set them in the deploy platform's secrets (on Workers,
  `wrangler secret put`). On Next.js the file reads `process.env`.
- What v7 kept beside the client (VTEX's `publicUrl`, Resend's sender) is an exported
  `<app>Settings` constant.
- The saved app block stays until the variables are set. Then delete it: `deco check`
  rejects it.

**`src/vendor/<app>/<path>`**: every app loader and action the content calls, copied
from the installed v7 package with the modules it imports from that package. Imports
of the package by name become relative imports. The block map registers each one
under its v7 type name, so saved content keeps resolving.

**`src/server/invoke.functions.ts`** (TanStack) or **`invoke.actions.ts`** (Next.js):
one server function per `/deco/invoke` key the site called. With
`--vtex-invoke v8`, the VTEX cart keys go to `src/server/vtex-invoke.server.ts` over
`vtexClient()`. Details are in `deco-v7-to-v8-migration`.

## Keep v7's client, or move to the v8 one

A vendored loader may still call v7's own fetch code, copied along with it. That keeps
every upstream request identical to v7, so recorded upstream fixtures still replay in
a parity run. It also keeps v7's in-memory fetch cache, which v8 doesn't have.

- **Keep it** while you prove parity. Drop the v8 `@decocms/apps-<platform>` dependency
  if nothing imports it, and list the move to the v8 client as a follow-up.
- **Move to the v8 client** to get telemetry, retries, the circuit breaker and cookie
  sanitizing, and to delete v7 code. Do it loader by loader, after parity.

## Moving a vendored loader onto the client

1. **One argument.** A block function gets its inputs and nothing else: no `req`, no
   `ctx`. Remove the second and third parameters. A value the loader read from the
   request (a cookie, the URL) must come in as an input, or the call belongs in a
   server function. See `deco-site-authoring` for loaders.
2. **Replace the fetch with a client call.** `vtexClient().search.products({…})` instead
   of a hand-built Intelligent Search URL. The table below maps v7's VTEX calls.
3. **Keep the converter.** The client returns VTEX's own types. The vendored
   `transform` code that builds `Product`, `ProductListingPage` and the rest stays in
   `src/vendor`. Import the commerce types from `@decocms/compat-v7/commerce/types`
   ([`commerce-types.md`](./commerce-types.md)).
4. **Remove `ctx.invoke`.** Call the other handler module directly, or the client.
   `src/migration-stubs.ts` stubs (`unportedInvoke`, `appState`) reject or throw at run time
   until replaced.
5. **Actions are not block functions.** A cart or session mutation runs in a server
   function (TanStack) or a route handler or server action (Next.js), with the shopper's
   request. Forward VTEX's cookies there: [`vtex-cookies-auth.md`](./vtex-cookies-auth.md).

### v7 VTEX calls and the v8 operation

| v7 call | v8 client |
|---|---|
| Intelligent Search `product_search` | `vtex.search.products(args)` |
| Intelligent Search `facets` | `vtex.search.facets(args)` |
| `search_suggestions`, `autocomplete_suggestions`, `top_searches` | `vtex.search.suggestions`, `.autocomplete`, `.topSearches` |
| `/api/catalog_system/pub/products/search` | `vtex.catalog.products({ term, ft, fq, from, to, sort })` |
| `/pub/portal/pagetype/<path>` | `vtex.catalog.pageType(path)` |
| `/pub/products/crossselling/<type>/<id>` | `vtex.catalog.crossSelling(type, productId)` |
| `/pub/category/tree/<levels>` | `vtex.catalog.categoryTree(levels)` |
| `getOrCreateCart` | `vtex.checkout.orderForm({ cookie, sections? })` |
| `addItemsToCart` | `vtex.checkout.addItems(orderFormId, items, { cookie })` |
| `updateCartItems` | `vtex.checkout.updateItems(orderFormId, items, { cookie })` |
| `addCouponToCart` | `vtex.checkout.addCoupon(orderFormId, text, { cookie })` |
| `updateOrderFormAttachment` | `vtex.checkout.attachment(orderFormId, name, body, { cookie })` |
| `simulateCart` | `vtex.checkout.simulation({ items, postalCode, country })` |
| `getSellersByRegion` | `vtex.checkout.regions({ postalCode, country })` |
| `/api/sessions` (get, edit) | `vtex.sessions.get({ cookie, items })`, `vtex.sessions.update(public, { cookie })` |
| Master Data v1 search, create | `vtex.masterdata.search(entity, args)`, `.create(entity, doc)` |
| IO GraphQL (`myvtex.com/_v/private/graphql/v1`) | `vtex.io.graphql({ query, variables })` |

What the v8 cart calls do differently from v7's handlers (the migration report lists
these too):

- `orderForm` gets the cart from the shopper's `checkout.vtex.com` cookie. v7 fetched
  `props.orderFormId` when given.
- No `allowedOutdatedData=paymentData` on add or update, no `noSplitItem` on update,
  no `RnbBehavior=1` on simulation.
- `addItems` types each SKU `id` as a number.
- Item images keep VTEX's `http:` URLs. v7 rewrote them to `https:`. Do it in your
  converter if the site needs it.

Wishlist, OMS orders, VTEX ID sign-in, profile and address calls have no operation in
the v8 client. Keep the vendored code, or write the call with `createInstrumentedFetch`
([`instrumented-fetch.md`](./instrumented-fetch.md)).

## Housekeeping

- **The script vendors every loader the content references**, including ones v7 never
  ran. Check which ones render before keeping them; delete the rest with the saved
  blocks nothing references.
- **Don't reformat vendored GraphQL documents.** Prettier reflows a vendored
  `queries.ts`, which changes every request body sent upstream; a replaying parity
  harness then misses every call. Keep such files in `.prettierignore`.
- **Tailwind** may scan `src/vendor` now, where v7 never scanned `node_modules`. See
  `deco-v7-to-v8-migration` if classes change.
