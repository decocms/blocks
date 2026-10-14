# Framework code: the v8 bindings, and what stays site code

From the site migrations; the sites and what the commit hashes refer to are listed in `SKILL.md` ("Gotchas by subject").

v8 keeps the framework layer in two bindings, released with `@decocms/blocks` at one version (`^8.3.0`): `@decocms/tanstack` (TanStack Start on Cloudflare Workers, deployed the Deco way) and `@decocms/nextjs` (any Next.js App Router app). Use them; don't copy v7's worker, draft, preview or image code into the site. What neither binding covers (commerce flows, SEO, device-specific UI) is site code. Each package's README has the full wiring; `examples/tanstack-worker-smoke` and `examples/nextjs-binding-smoke` in this repo are complete apps.

## TanStack Start (`@decocms/tanstack`)

- **Worker entry**: `createDecoWorker({ serverEntry, cms, site, buildHash, dev })` from `/worker` replaces v7's `createDecoWorkerEntry` and everything a copied entry carried. Built in: `/deco/_liveness`, 404 for v7's admin paths, drafts (the host allowlist, the cookie, no-store and noindex, only a real draft skips the cache), CMS redirects before any route, the edge cache keyed by build, content revision, device and `segment` (stale-while-revalidate, stale-if-error), `__cseg` CDN caching of navigation data, Studio's `frame-ancestors`, one `Set-Cookie` per cookie, `x-page-status`. A site states only what differs: `segment` (region, sales channel, `"private"` for a signed-in shopper), `csp`, `cacheProfiles`, `safeCookies`, `preload`, `purgeToken`, `previewHosts`, `onCache`, and `routes` for requests it answers itself (a commerce proxy, a sitemap). Code the site keeps (geo cookies, a v7 request context) wraps the worker's `fetch`; it needs no new option.
- **Build hash**: `decoTanstack({ buildHash: <CI commit sha> })` from `/vite` (CI sha, then git, then the time) defines `__BUILD_HASH__` and includes `decoContent()` from `@decocms/blocks/vite`. The package reads no env: the site passes the CI value.
- **Root document**: `DecoDocument` from `/react` (`site`, `lang`, `nonce`, `editShortcut`) mounts `StudioBridge` and `DraftBadge` from `@decocms/blocks/preview`, the events bus, `NavigationProgress` and `StableOutlet`. A layout it can't express (a skip link before `<main>`) keeps its own document and renders `StudioBridge` there.
- **Router and server functions**: `createDecoRouter` (`/router`) keeps `?q=`; a router that needs TanStack's `hydrate` builds its own router with `decoParseSearch`/`decoStringifySearch`. `createStart(() => ({ serverFns: { fetch: decoServerFnFetch } }))` (`/start`). The worker decides the draft, so delete the draft middleware in `start.ts`; pages read it with `contentClient(cms)` (`/server`).
- **Image**: `Image`, `Picture` and `Source` from `/react` render v7's markup with v7's props (the script moves those imports). Give them the site's `createImageUrl` (`@decocms/blocks/image`) with `createDecoRouter({ routeTree, Wrap: ({ children }) => <ImageUrlProvider value={imageUrl}>{children}</ImageUrlProvider> })`; without it they use v7's defaults. A site that called `registerImageCdnDomain`/`registerImageQuality` passes the same values to `decoCdn({ domain, quality, proxyOtherHosts: true })`, after `vtexCatalog({ size: "exact" })` and `shopify()`. Check a page's image URLs against v7's.
- **Cache metrics**: v7's `DECO_METRICS` writes have no writer; `onCache` (hit/miss/bypass, page type, duration) is the hook to send them anywhere (`telemetry.md`).

## Next.js (`@decocms/nextjs`)

- **Drafts**: `decideDraft`, `draftRequestHeaders`, `rewriteToDraftRoute`, `applyDraft` and `isDraftRoutePath` from `/proxy` in `proxy.ts` (or `draftProxy` for a site with no proxy of its own); `bindDraft(cms, { searchParams, site })` and `contentClient(cms)` from `/server` on the `/_draft` route and in a layout that reads content. Pass the same `{ site, previewHosts }` to both. Details and gotchas: `nextjs.md`.
- **Studio and the badge**: `<StudioBridge site="…" />` in the root layout and `<DraftPreviewIndicator />` on the draft route, from `@decocms/nextjs`.
- **next.config**: `withDeco(config)` from `/config` puts v7's draft header rules first and adds Studio's dev origins; it adds no rewrites (v7's `/deco/*` handlers are gone) and no `transpilePackages`.
- **Image**: `createDecoImageLoader(imageUrl, { fallback: nextImageOptimizer })` from `/image-loader` as the `loaderFile`, over the site's `createImageUrl`. URLs match v7's loaders byte for byte, except VTEX file-manager images, which move from the broken `?width=` resizer to Thumbor.
- **Dev**: `createCMS({ dev: isNextDev(process.env.NODE_ENV) })`.

## Site code either way

- **SEO/head**: a head builder; SEO blocks return the page's SEO.
- **Device detection** for components: v7's user-agent patterns in `src/sdk/device.ts` (the TanStack worker keys its cache by device on its own).
- **Cookies and request state**: pass the request and response headers explicitly, or a site-owned `AsyncLocalStorage`, instead of v7's `RequestContext`.
- **Cart, user, wishlist, sign-in flows and commerce loaders**: vendored next to the loaders the script copied, sending through the v8 client.
- **Section loaders** run inside their block functions.
- **Module-level config from v7 apps is cross-request state.** A v7 app's `configureX({...})` singleton (the website app's SEO defaults, for one) called from the page loader on every request is shared by every request in the isolate. A preview host and production share the worker, so a draft's values can land in a concurrent release render that the edge then caches. Put per-page values in the page's own state and pass them to whatever read the singleton.
- **Identification headers** (`x-powered-by`, the outbound `User-Agent`) are the site's own values; if they change (v7 sent its package version), list it as the site's difference.
- **Keep v7's platform client, or adopt the v8 one?** Keeping the vendored v7 client (and its cached loaders and fetch cache) keeps every upstream request identical, so recorded upstream fixtures replay. If you keep it, drop the v8 `@decocms/apps-<platform>` dependency nothing imports, and list the move to its client plus the `/next/caching` recipe (`cachedLoader` is gone in v8) as a follow-up.
- **Error reporting.** v7's `onResolveError` sent every failed section or loader to the site's exception reporting. v8 has no hook: `client.resolve` returns `[value, error]`, and a section loader that throws is caught in its block function. Report both explicitly there (same attributes as before, so dashboards keep working); `console.error` alone only reaches the SDK's sampled log export.
- **A worker-level A/B split (`withABTesting`, `SITES_KV`).** v8 has no equivalent. If the KV holds no config for the site's hosts, nothing was split: delete the wrapper and the binding. If it does, keep the split as site code around the worker's `fetch`. Either way, list it for the product owner.
- **Not ported to the TanStack worker**: v7's caching of POST server functions by body. A site that relied on it keeps that wrapper or lists it.
