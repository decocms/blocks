# Caching and privacy

From the site migrations; the sites and what the commit hashes refer to are listed in `SKILL.md` ("Gotchas by subject").

- **Keep per-visitor data out of the edge cache** (`844ce9f`): cache a GET server function only when its payload is page data; cart, user, wishlist, addresses answer `Cache-Control: private, no-store`, and the cache wrapper never stores such a response. Detect signed-in shoppers by the cookie the sign-in flow actually sets.
- **One QueryClient per router**, never per isolate: a shared one leaks the previous request's cart and user.
- v7's admin paths (`/deco/*`, `/live/*`, `/.decofile`) should answer 404, not a cacheable page. `createDecoWorker` does; on Next.js, check them in the parity run (`hosted-releases.md`).
- **The draft decision is the binding's.** v7's edge cache skipped a request with `?__draft=` or the draft cookie only on an allowed preview host; a hand-copied worker that checks the raw param lets anyone skip the cache on production (`?__draft=x`). `createDecoWorker` decides once per request with v7's allowlist, skips the cache only for a draft it accepted, and hands the page that draft (`contentClient(cms)`); on Next.js, `decideDraft` in the proxy does the same. Don't add a second draft check of your own.
- **A signed-in shopper never shares a cached page**: return `"private"` from `createDecoWorker`'s `segment` for the cookie the sign-in flow actually sets; a server function answering per-visitor data calls `markPrivate()` (`@decocms/tanstack/server`).
- **Don't let hydration wait on a cross-origin call.** Prefetching the shopper's profile in the router's `hydrate` so widgets hydrate with it keeps v7's pixels, but `hydrate` is awaited: a slow or hung gateway keeps the page from ever becoming interactive. Cap the wait (a few hundred milliseconds) or don't await it. A parity harness replays upstream calls, so it never shows this cost.
