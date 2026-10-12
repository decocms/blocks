# Caching and privacy

From the site migrations; the sites and what the commit hashes refer to are listed in `SKILL.md` ("Gotchas by subject").

- **Keep per-visitor data out of the edge cache** (`844ce9f`): cache a GET server function only when its payload is page data; cart, user, wishlist, addresses answer `Cache-Control: private, no-store`, and the cache wrapper never stores such a response. Detect signed-in shoppers by the cookie the sign-in flow actually sets.
- **One QueryClient per router**, never per isolate: a shared one leaks the previous request's cart and user.
- v7's admin paths (`/deco/*`, `/live/*`, `/.decofile`) should answer 404, not a cacheable page.
- Read drafts with `await cms.draftPointer(request)`; it ignores drafts on hosts outside `preview.hosts` (the `CMS` block, capped by `createCMS({ preview })`), so list your staging and dev hosts there.
- **Gate the copied worker entry's draft bypass on the pointer too.** v7's edge cache skipped a request with `?__draft=` or the draft cookie only on an allowed preview host. A copy that checks the raw param or cookie lets anyone skip the edge cache on production (`?__draft=x`), so every such request reaches the worker and the commerce API. Compute `const previewing = (await cms.draftPointer(request)) !== null` once per request and use it wherever the copy checked for a draft.
- **Don't let hydration wait on a cross-origin call.** Prefetching the shopper's profile in the router's `hydrate` so widgets hydrate with it keeps v7's pixels, but `hydrate` is awaited: a slow or hung gateway keeps the page from ever becoming interactive. Cap the wait (a few hundred milliseconds) or don't await it. A parity harness replays upstream calls, so it never shows this cost.
