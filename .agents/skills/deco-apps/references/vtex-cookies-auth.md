# VTEX cookies, sign-in and what may be cached

VTEX keeps the shopper's cart, session, region and sign-in in cookies. The v8 client
never reads the incoming request and never writes a response. The site passes the
shopper's `Cookie` header in, and sends VTEX's `Set-Cookie` values out. Most VTEX cart
and sign-in bugs on a migrated site are one of those two steps.

## Cookies in

Pass the request's `Cookie` header as `cookie` on every shopper-scoped call:

```ts
const cookie = request.headers.get("cookie") ?? undefined;
const { data: orderForm, setCookies } = await vtex.checkout.orderForm({ cookie });
```

- A call with `cookie` goes out **as the shopper**: the client leaves the app key and
  token off. A cart call without `cookie` goes out as the app and gets a new cart.
- The client cleans the header first. It drops pairs without `=`, pairs whose name
  isn't a valid token, and pairs whose value has non-ASCII bytes. VTEX's gateway
  answers `503` with an empty body to a cookie with non-ASCII bytes, before the request
  reaches the service. One analytics tag that writes an accented category name into
  `document.cookie` would otherwise break every checkout call for that shopper. Dropped
  cookies are not reported.
- It does **not** filter by name. Every clean cookie the browser sent goes to VTEX.

### Sending only VTEX's cookies

The package keeps a list of the cookie name prefixes VTEX APIs read. It is internal (not
exported), and the client does not apply it:

`VtexIdclientAutCookie`, `checkout.vtex.com`, `CheckoutOrderFormOwnership`,
`vtex_session`, `vtex_segment`, `vtex_is_`, `janus_sid`

To keep third-party cookies away from VTEX (a smaller header, nothing extra sent
upstream), filter in the site before you pass `cookie`:

```ts
const VTEX_PREFIXES = ["VtexIdclientAutCookie", "checkout.vtex.com", "CheckoutOrderFormOwnership",
  "vtex_session", "vtex_segment", "vtex_is_", "janus_sid"];

const vtexCookies = (header: string | null) =>
  (header ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => VTEX_PREFIXES.some((prefix) => pair.startsWith(prefix)))
    .join("; ") || undefined;
```

## Cookies out

Calls that change shopper state return `VtexResponse<T>`: `{ data, setCookies }`. The
checkout calls (except `simulation` and `regions`) and both session calls do.
`setCookies` comes from `Headers.getSetCookie()`: one string per cookie, unmodified.

**Append each value as its own `Set-Cookie` header.** A cart call returns several
cookies. Never copy them with `headers.entries()` or `forEach`, and never join them:
those collapse the values into one comma-joined header, which browsers discard. The
cart then looks empty on the next request although VTEX returned the items.

Check in DevTools: the cart call's response has **several** `Set-Cookie` rows, not one
long one.

**TanStack Start**: in the server function, append to the response headers. This is
the forwarder the migration script writes for `--vtex-invoke v8`:

```ts
import { getResponseHeaders } from "@tanstack/react-start/server";
import type { VtexResponse } from "@decocms/apps-vtex";

async function forward<T>(response: Promise<VtexResponse<T>>, request: Request): Promise<T> {
  const { data, setCookies } = await response;
  const host = new URL(request.url).hostname;
  const headers = getResponseHeaders();
  for (const cookie of setCookies) {
    if (cookie.startsWith("vtex_is_session=") || cookie.startsWith("vtex_is_anonymous=")) continue;
    headers.append("set-cookie", cookie.replace(/(;\s*)domain=[^;]*/i, `$1Domain=${host}`));
  }
  return data;
}
```

- `Domain` is rewritten to the site's host. VTEX names its own domain, and a browser
  rejects a cookie set for a domain other than the one it is talking to.
- Intelligent Search's session cookies stay on the server, as v7 kept them.

**Next.js**: a server action can only set cookies through `cookies()`, which
percent-encodes the value. `checkout.vtex.com=__ofid=…` would reach VTEX as
`__ofid%3D…` and lose the cart. Run cart calls in a **route handler** and append each
`setCookies` value to the `Response` headers.

## Intelligent Search cookies

v7's middleware created `vtex_is_session` and `vtex_is_anonymous` (random UUIDs) when
the request had none, and sent them on Intelligent Search calls. v8 does neither: the
client sends exactly the `cookie` you pass, and nothing when you pass none.

If the store relies on those cookies, set them in the site and include them in the
search's `cookie`. That makes the search shopper-scoped: don't put it in a shared
cache (below). Without them, a search is the same for every shopper and can be cached.

## Sign-in: `VtexIdclientAutCookie`

- **It is HttpOnly.** Browser code can't read it with `document.cookie`. A client
  component that checks `document.cookie` for sign-in always sees a signed-out shopper.
  Ask the server instead: a server function calls
  `vtex.sessions.get({ cookie, items: ["profile.isAuthenticated", "profile.email"] })`
  and returns what the UI needs, marked private.
- **Two names.** VTEX also sets `VtexIdclientAutCookie_<account>`. v7's client sent both
  names, with the same token, on authenticated IO GraphQL calls. The v8 client sends
  what the browser has; if only one name is there, add the other to the `cookie` you
  pass to `io.graphql`.
- **Authorized hosts.** VTEX accepts headless sign-in only from hosts listed in the
  store's settings in the VTEX admin. Add every host the site is served from:
  production, preview hosts, and `localhost:<port>` for local work. A missing host
  shows as a sign-in that redirects in a loop.
- **Testing without a sign-in flow.** Sign in on an authorized host, copy every cookie
  whose name starts with `VtexIdclientAutCookie` from DevTools (Application → Cookies),
  and set them on the target host. They expire; copy them again when the session drops.

| Symptom | Likely cause |
|---|---|
| Sign-in redirects in a loop | The host isn't in the store's authorized hosts |
| Copied cookies don't keep the session | Expired, or the target host isn't authorized |
| `401` with the cookie present | The cookie belongs to another VTEX account than the client's `account` |
| UI shows signed-out while VTEX checkout shows signed-in | The UI reads `document.cookie`; ask the server |

## What may be cached

Only responses that are the same for every shopper.

- **Never cache** a call made with `cookie`, any `VtexResponse` (checkout, sessions),
  Master Data reads made for a shopper, or `io.graphql` with a sign-in cookie.
- **Cacheable**: `search.*` and `catalog.*` sent without `cookie`. Key on the full URL:
  `sc`, `regionId`, `locale`, page, sort and facets are all in it. See
  [`instrumented-fetch.md`](./instrumented-fetch.md) for the client's `fetch` option.
- **Server functions that return shopper data** (cart, user, wishlist, addresses) answer
  `Cache-Control: private, no-store`. On TanStack Start, call `markPrivate()` from
  `@decocms/tanstack/server` in them.
- **A signed-in shopper never shares a cached page.** The worker entry's segment marks
  the shopper as signed in from the cookie the sign-in flow actually sets. Details in
  `deco-storefront-caching`.
- **One React Query client per router**, never per isolate: a shared one leaks the
  previous request's cart and user to the next shopper.
