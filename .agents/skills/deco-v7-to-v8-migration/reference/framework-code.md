# Framework code moves into the site

From the site migrations; the sites and what the commit hashes refer to are listed in `SKILL.md` ("Gotchas by subject").

v8 has no framework binding and its apps are thin clients. What `@decocms/tanstack`, `@decocms/blocks` 7 and `@decocms/apps-*` did for the site becomes site code, copied with its v7 output (`21addb9`, `0512e60`):

- **Edge cache**: the worker entry owns cache profiles, `Cache-Control`, the Cache API with SWR/SIE, split by device/login/region, keyed by deployment. Cache GET server functions (client-side navigation data) like pages; POST server functions keep their own headers (blog `59cb74f`). Restore `/deco/_liveness` if monitoring uses it.
- **Image**: copy v7's `Image` so CDN URLs stay identical.
- **SEO/head**: a head builder; SEO blocks return the page's SEO.
- **Device detection**: v7's user-agent patterns in `src/sdk/device.ts`.
- **Cookies and request state**: pass the request and response headers explicitly, or use a site-owned `AsyncLocalStorage`, instead of v7's `RequestContext`.
- **Cart, user, wishlist, sign-in flows and commerce loaders**: vendored next to the loaders the script copied, sending through the v8 client.
- **Section loaders** run inside their block functions.
- **Module-level config from v7 apps is cross-request state.** A v7 app's `configureX({...})` singleton (the website app's SEO defaults, for one) called from the page loader on every request is shared by every request in the isolate. A preview host and production share the worker, so a draft's values can land in a concurrent release render that the edge then caches. Put per-page values in the page's own state (the `AsyncLocalStorage` the page loader runs blocks in) and pass them to whatever read the singleton.
- **Identification headers in the copied worker entry** (`x-powered-by`, the outbound `User-Agent`) are the site's own values now, not the framework's. If they change (v7 sent its package version), list it as the site's difference.
- **Keep v7's platform client, or adopt the v8 one?** Keeping the vendored v7 client (and its cached loaders and fetch cache) keeps every upstream request identical, so recorded upstream fixtures replay. If you keep it, drop the v8 `@decocms/apps-<platform>` dependency nothing imports, and list the move to its client plus the `/next/caching` recipe (`cachedLoader` is gone in v8) as a follow-up. Prune what the copied worker entry still carries for v7's admin (preview shells, `/live/previews`, `/deco/render`).
- **Error reporting.** v7's `onResolveError` hook sent every failed section or loader to the site's exception reporting. v8 has no hook: `client.resolve` returns `[value, error]`, and a section loader that throws is caught in its block function. Report both explicitly there (same attributes as before, so dashboards keep working); `console.error` alone only reaches the SDK's sampled log export.

- **A worker-level A/B split (`withABTesting`, `SITES_KV`).** v7 could wrap the worker to send a share of traffic to a fallback origin, configured per host in KV. v8 has no equivalent. If the KV holds no config for the site's hosts, nothing was split: delete the wrapper and the binding. Either way, list it for the product owner, since the switch to run such a test is gone.
