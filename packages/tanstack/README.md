# @decocms/tanstack

Deco CMS for [TanStack Start](https://tanstack.com/start) sites on Cloudflare Workers, deployed the way Deco deploys them. It is opinionated: one worker entry with a few options, one escape hatch for your own routes, and the behaviour every Deco TanStack site should have, always on.

Peers: `@decocms/blocks` (same version), `@tanstack/react-start`, `@tanstack/react-router`, `react`, and `vite` for `/vite`.

## The worker

```ts
// src/worker-entry.ts (wrangler.jsonc "main"), without a page cache
import { createDecoWorker } from "@decocms/tanstack/worker";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { cms } from "./cms";

export default createDecoWorker({
  serverEntry: createServerEntry({ fetch: handler.fetch }),
  cms,
  dev: import.meta.env.DEV,
});
```

Always on: `/deco/_liveness`; 404 for v7's admin paths; Studio may frame the site (`frame-ancestors`, no `X-Frame-Options`) and the security headers; drafts (the CMS's preview hosts, the draft cookie, set only with a response below 500; any request with `?__draft=`, `off` included, or the draft cookie is a preview: it never reaches `pageCache` and answers exactly `Cache-Control: max-age=0, no-cache, must-revalidate`, `Vary: Cookie` and `noindex`, a fingerprinted asset excepted; a link to a draft that can't be read anymore renders the release, expires the cookie and shows `DecoPreview`'s calm notice, never a 500); the CMS redirects; one `Set-Cookie` per cookie; `x-page-status`; `CDN-Cache-Control: no-store` on every response that names none; and `http.server.request.duration` for every request, in the CMS's telemetry through `recordServerRequest` from `@decocms/blocks/metrics` (nothing without a `token` or an `endpoint`, and then the page template is never looked up), labelled `http.route` (the content's page template, `redirect` for every CMS redirect, a fixed one such as `/_serverFn/*` or `/assets/*`, otherwise `unmatched`), `http.request.method`, `status_class`, `cache` (`DRAFT` for a preview; otherwise the `X-Cache` your `pageCache` answered with, `HIT` for `HIT`, `STALE-HIT` and `STALE-ERROR`, `MISS`, else `BYPASS`) and `device`.

Options, each for a value a site needs to change: `csp`, `pageCache`, `preload` and `routes`.

The worker caches no page: the page cache is the site's, as on Next.js. Without `pageCache` every request renders. [The page cache](#the-page-cache) below links a complete worker entry with one.

### Draft hosts

A draft link (`?__draft=`) previews on the hosts the CMS allows, which `cms.readVersion` checks: the addresses Studio writes into the current release's metadata (`previewHosts` in `latest.json`, so `createCMS` needs the site's `site` for them), plus `createCMS({ preview: { hosts } })`. The site lists nothing else. With no list, every host previews: a site with no `latest.json` on the CDN yet, or one published before Studio wrote `previewHosts` (its next publish writes the list), and content with no `site` unless `preview.hosts` lists hosts (such as `["localhost"]`). If `latest.json` can't be read (a network error, a 5xx, a malformed file), previews stay closed, besides `preview.hosts`, until a read succeeds. A link on any other host gets the release, never an error. The same link can carry a published release's commit SHA instead of a draft (Studio's "Preview this version"), and either one can carry a preview time (`__at`) and tests and campaigns switched on or off (`__test`, `__campaign`), which `cms.readVersion` reads as the client's `date`, `experiments` and `campaigns`; all of it passes the same host check, so a visitor on the live site never picks a version. The worker passes the accepted version, alone, to the app in the `x-deco-version` request header (`requestVersion(request)` reads it in a `routes` handler).

### The visitor, the assignments and the client

The worker decides once per request, at the edge. On every page and server-function request it reads the visitor with `readVisitor` from `@decocms/blocks/experiments` (the `deco_segment` cookie, or a new visitor), then each test and campaign on or off for it: `readAssignments(cms, { visitor, ...version })`, which resolves the saved `experiments` and `campaigns` blocks through `cms.client({ visitor, version, date, experiments, campaigns })` with the Studio link's version, moment and switched tests and campaigns. It hands the visitor to the app on `x-deco-visitor` and the decisions on `x-deco-assignments`, removing any copy sent from outside, and the decisions to the site's `pageCache` as `page.assignments`, for its key. It sends the visitor's cookie on a first visit only (a visitor with no id yet), never from a preview.

`contentClient(cms)` from `@decocms/tanstack/server` builds `cms.client({ version, experiments, campaigns })` from the headers, every test and campaign as the worker decided it, so the page renders exactly what the cache keyed on and decides nothing again; `requestVersion()`, `requestVisitor()` and `requestAssignments()` return them for a site's own code. They trust those headers: behind `createDecoWorker` they hold what the worker decided, since it removes any copy sent from outside. A request that reaches the app without the worker (another entry, or an app that doesn't use `createDecoWorker`) is read the same way, with whatever `x-deco-version`, `x-deco-visitor` and `x-deco-assignments` it arrives with; with none, its visitor decides, and without one every test is off. Which requests go through the worker, and how the others are protected, is the site's call.

### The page cache

`pageCache(page)` is the site's own cache around the app. The worker calls it for every page and server-function request `isCacheable` accepts (a `GET` of the current release with no `?__draft=` and no draft cookie, outside `vite dev`, without `Authorization`, not `/_build`: never a preview, a draft or an old release), with `page.request` (as the app gets it), `page.url`, `page.visitor` (the visitor the page renders for, a first visit's new one included), `page.assignments` (each test and campaign on or off, as the page renders them), `page.device`, `env`, `ctx` and `page.render(scope?)`, which renders the page. Answer from your cache, or call `render()`; set `X-Cache` on the answer for the request metric. A page request with `Authorization` never reaches it and answers `Cache-Control: private, no-cache, no-store, must-revalidate`, whatever the app set, so no shared cache keeps one caller's page.

The visitor's first-visit cookie is never in what `render()` returns: the worker adds it to whatever `pageCache` answers, a cached copy included. So a stored copy never carries a visitor's cookie, and a new visitor served from the cache still gets theirs. Never store a response that sets any other cookie.

What the key needs, from `@decocms/tanstack/worker`, the same names as `@decocms/nextjs/proxy`'s where both have them:

- `assignmentsKey(page.assignments)`: the tests on and the campaigns running, as one string (`x=<tests>|c=<campaigns>`, `""` for none), never the visitor's id. Visitors on the same side of every test share one entry, the other side gets its own, and a campaign starting or ending moves every page to new entries. `liveAssignmentKeys(cms)` lists every key a live request can carry now (each subset of the saved tests, with the running campaigns and with none), for a purge.
- `cacheVersion(cms, buildHash)`: `<build>.<content revision>`, so a deploy or a published release gets new entries at once.
- `detectDevice(userAgent)` (v7's classes: `mobile`, `tablet`, `desktop`), `segmentKey(segment)` (a segment's parts as one stable string) and `segmentToken(segment, version)`: the `__cseg` token. Pass it as `render({ csegToken })` and `DecoDocument` publishes it; `decoServerFnFetch` sends it back on the page's navigation data (`CSEG_PARAM`), and your cache may let the CDN keep that response when the token matches the request's own.
- `isCacheable(request, { version, dev })`, `requestVersion(request)`, `isServerFnPath(pathname)`, `serverFnPagePath(url)` (the page a server-function page load asks for, from its payload) and `DEGRADED_HEADER` (a page whose loader failed: never store it).

A complete worker entry with a page cache is [`examples/tanstack-worker-smoke/src/worker-entry.ts`](https://github.com/decocms/blocks/blob/main/examples/tanstack-worker-smoke/src/worker-entry.ts): copy it to your `src/worker-entry.ts` and change what your site needs. It is v7's edge cache on the Cloudflare Cache API, and every part of it is yours:

- **The key**: the path (tracking parameters and `__cseg` dropped), the device and your segment's own parts (`buildSegment`, v7's: a region, a sales channel), `assignmentsKey(page.assignments)` and `cacheVersion(cms, __BUILD_HASH__)`. A signed-in shopper (`loggedIn: true` from `buildSegment`), a private response and a degraded one are never stored.
- **The profiles**: v7's cache profiles per URL (`PROFILES`), each with how long a page stays fresh, how long it is served stale while it revalidates, and how long when the app fails.
- **The purge**: v7's `POST /_cache/purge` with `Authorization: Bearer <PURGE_TOKEN>` and a body of `{ "paths": ["/", "/shoes"] }`, optionally with `"segments": [{ "device": "desktop", "salesChannel": "2" }]` (your own parts). It drops each exact path (`/shoes` never drops `/shoes?page=2`) under the current version, for each segment (the devices when the body names none), each assignments key, as a navigation and as a server-function fetch, and answers `{ "purged": [...], "total": n }`. The Cache API is per data center, so a purge reaches the copies of the data center that serves it.

`__BUILD_HASH__` is the build id `decoTanstack()` defines (declare it once: `declare const __BUILD_HASH__: string;`), and `PURGE_TOKEN` a Worker secret. The example runs that file as its worker entry, with its tests (`worker-entry.test.ts` next to it).

### Names and Studio's origins

The root export holds what the worker, `/server` and `DecoDocument` share, for a site's own code: the draft names (`DRAFT_PARAM` `__draft`, `DRAFT_COOKIE` `__deco_draft`), the headers the worker hands the app (`VERSION_HEADER` `x-deco-version`, `VISITOR_HEADER` `x-deco-visitor`, `ASSIGNMENTS_HEADER` `x-deco-assignments`), `draftResponseHeaders(preview)` (`max-age=0, no-cache, must-revalidate`, `Vary: Cookie`, `noindex`; pass the version, or `true` for any request with a draft signal), and Studio's origins: `STUDIO_ORIGINS`, `STUDIO_FRAME_ANCESTORS` (what the worker's `frame-ancestors` starts from) and `isStudioOrigin`. `DecoDocument` passes `STUDIO_ORIGINS` to the Studio bridge.

```ts
import { STUDIO_ORIGINS, VERSION_HEADER } from "@decocms/tanstack";
```

## The app

```ts
// vite.config.ts
plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), react(),
  decoTanstack({ buildHash: process.env.WORKERS_CI_COMMIT_SHA })]

// src/router.tsx
export const getRouter = () => createDecoRouter({ routeTree });

// src/start.ts
export const startInstance = createStart(() => ({ serverFns: { fetch: decoServerFnFetch } }));

// src/routes/__root.tsx
export const Route = createRootRoute({ component: () => <DecoDocument site="my-store" /> });
```

`DecoDocument` mounts Studio's bridge and the draft badge. A page route returns `pathTemplate` (the page block's `path`, as `matchRoute` matched it) in its loader data, so "." on the store page opens that page in Studio's editor. A site that keeps its own document (a skip link before `<main>`, say) renders `<DecoPreview site="my-store" />` in its `<body>` instead: the bridge, the badge and the draft they read.

## Images

```tsx
// src/imageUrl.ts: the site's image URLs (@decocms/blocks/image plus its platform's helpers)
import { createImageUrl, decoCdn } from "@decocms/blocks/image";
import { vtexCatalog } from "@decocms/apps-vtex/image"; // a VTEX store
import { shopifyCdn } from "@decocms/apps-shopify/image"; // a Shopify store
export const imageUrl = createImageUrl({
  providers: [vtexCatalog(), shopifyCdn(), decoCdn({ quality: "high", sources: "all" })],
});

// src/router.tsx: around every page
createDecoRouter({ routeTree, Wrap: ({ children }) => <ImageUrlProvider value={imageUrl}>{children}</ImageUrlProvider> });

// any component
<Image src={src} width={400} height={300} preload={isLcp} />
```

`Image`, `Picture` and `Source` from `/react` take v7's props and render v7's markup, so a migrated call site only changes its import. This package knows no commerce platform: v7's components resized VTEX catalog and Shopify images on those platforms' hosts, and a site keeps those URLs by listing the platform's helper before `decoCdn` as above (v7's URLs, byte for byte, with the `decoCdn` options of the 7.x release the site ran, e.g. `stripAssetHosts: "leading"` from 7.71.4: the v7 to v8 migration skill lists them). An `Image` or `Source` without a width writes v7's `width=NaN` candidates, as v7 did. Without an `ImageUrlProvider` every source goes through `assets.decocms.com` (`DECO_IMAGE_URL`).

`examples/tanstack-worker-smoke` in the repository is a complete app.
