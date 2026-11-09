# Server functions

v8 has no `/deco/invoke` and no `invoke` object: the worker answers `/deco/*` with 404. Anything
the browser asks the server for (add to cart, newsletter sign-up, a shipping quote) is a TanStack
Start server function the site writes. Raw HTTP endpoints that aren't called from React (a webhook,
a feed) go in the worker's `routes` ([`worker-entry.md`](./worker-entry.md)).

Migrating a v7 site? The migration script writes one server function per v7 invoke key:
`deco-v7-to-v8-migration` (`reference/server-functions.md`).

## The shape

```ts
// src/server/newsletter.functions.ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { subscribe } from "./newsletter.server";

export const subscribeNewsletter = createServerFn({ method: "POST" })
  .inputValidator(z.object({ email: z.string().email() }))
  .handler(({ data }) => subscribe(data.email));
```

```tsx
// a client component
await subscribeNewsletter({ data: { email } });
```

- **`GET` for reads, `POST` for writes.** A `GET` carries its input in the URL (`?payload=`), so a
  cache can key on it. A `POST` never goes through the site's page cache (`isCacheable` accepts
  only `GET`).
- **Validate the input.** `.inputValidator` takes a function or a schema (the example uses zod).
  Anything the browser sends is untrusted; reject protocol-relative paths (`//host`) wherever an
  input is a URL.
- **Put server-only code in `*.server.ts` files** and import them from handlers. TanStack Start's
  import protection flags a `*.server.*` file or `@tanstack/react-start/server` imported into the
  client build.

## The handler must be a top-level `const`

TanStack Start's compiler replaces each `createServerFn(...).handler(...)` with an RPC stub
(`createClientRpc(...)`) in the client build and drops the handler's imports. In a file that only
has server functions, it looks only at top-level variable declarations
(`const x = createServerFn()...` or `export const x = ...`). In such a file, a server function
created inside a function body is not transformed, so the handler and everything it imports ship to the browser.
The call then runs in the browser: upstream APIs answer with CORS errors, and secrets may be in the
bundle.

```ts
// Wrong: created by a factory, never transformed
export function makeAction(action: (input: unknown) => Promise<unknown>) {
  return createServerFn({ method: "POST" }).handler(({ data }) => action(data));
}

// Right: one top-level const per function
export const addToCart = createServerFn({ method: "POST" })
  .inputValidator(cartItemSchema)
  .handler(({ data }) => addItem(data));
```

The compiler also rejects a server function that isn't assigned to a variable
(`createServerFn must be assigned to a variable!`) or is destructured. A dispatcher that looks up
the action by name at runtime (`runInvoke(key, props)`) is v7's invoke endpoint again: write one
function per action.

**Check it.** In the browser's network panel, the call must go to `/_serverFn/...` on your own
origin, not to the upstream API. After `vite build`, search the client JavaScript (not the source
maps) for secret names and for `node:async_hooks`: neither should be there.

## Per-visitor responses

A server function that answers for one visitor (cart, user, wishlist, addresses) calls
`markPrivate()` from `@decocms/tanstack/server`:

```ts
import { markPrivate } from "@decocms/tanstack/server";

export const getCart = createServerFn({ method: "GET" }).handler(async () => {
  markPrivate(); // Cache-Control: private, no-store
  return readCart();
});
```

It sets `Cache-Control: private, no-store` only when the browser called the function over HTTP
(`isServerFnCall()`). While the document renders, the call is a plain function call and the header
would land on the page, so it does nothing. A `GET` without it can be stored by the site's page
cache and served to the next visitor. Caching rules: `deco-storefront-caching`.

## Cookies from an upstream API

An upstream call (a commerce cart, a session) often answers with several `Set-Cookie` headers.
They must reach the browser as separate headers.

```ts
import { setResponseHeader } from "@tanstack/react-start/server";

const upstream = await fetch(url, init);
const cookies = upstream.headers.getSetCookie();
if (cookies.length) setResponseHeader("set-cookie", cookies);
```

- **Read with `getSetCookie()`.** `headers.get("set-cookie")` returns every cookie joined by
  `, ` into one string. Sent on as one header, the browser rejects it. The usual symptom: the
  action succeeds, then the next page shows an empty cart.
- **`setResponseHeader` replaces.** With an array it deletes every `Set-Cookie` set earlier in this
  response, then appends each value; with a string it overwrites. Collect all the cookies, then
  set them once.
- **Duplicates are fine.** The worker keeps the last `Set-Cookie` for each cookie (name + Domain +
  Path) on every response, so two layers setting the same cookie send one. Cookies that differ in
  Domain or Path stay separate: a sign-out that clears a cookie under several scopes still clears
  them all.
- In DevTools, the response should show several `Set-Cookie` rows. One row with commas inside is
  the collapse.

Which cookies a commerce platform needs, and the VTEX cart flow: `deco-apps`.

## Request state

v8 has no `RequestContext`. Inside a handler, read the request with `getRequest()` and the
worker's decisions with `requestVisitor()`, `requestAssignments()` and `requestVersion()` from
`@decocms/tanstack/server`. Pass what a helper needs as arguments; don't keep request data in
module scope, which every request in the isolate shares.
