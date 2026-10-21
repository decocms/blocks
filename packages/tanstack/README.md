# @decocms/tanstack

Deco CMS for [TanStack Start](https://tanstack.com/start) sites on Cloudflare Workers, deployed the way Deco deploys them. It is opinionated: one worker entry with a few options, one escape hatch for your own routes, and the behaviour every Deco TanStack site should have, always on.

Peers: `@decocms/blocks` (same version), `@tanstack/react-start`, `@tanstack/react-router`, `react`, and `vite` for `/vite`.

## The worker

```ts
// src/worker-entry.ts (wrangler.jsonc "main")
import { createDecoWorker } from "@decocms/tanstack/worker";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { cms } from "./cms";

export default createDecoWorker({
  serverEntry: createServerEntry({ fetch: handler.fetch }),
  cms,
  site: "my-store",
  buildHash: __BUILD_HASH__,
  dev: import.meta.env.DEV,
});
```

Always on: `/deco/_liveness`; 404 for v7's admin paths; Studio may frame the site (`frame-ancestors`, no `X-Frame-Options`) and the security headers; drafts (the host allowlist, the draft cookie, never cached, `noindex`); the CMS redirects; an edge cache keyed on the build, the content revision, the device, your `segment` and the request's assignments (below), with stale-while-revalidate and stale-if-error; CDN caching of client-side navigation data under a checked `__cseg` token; one `Set-Cookie` per cookie; `x-page-status`; and `http.server.request.duration` for every request, in the CMS's telemetry through `recordServerRequest` from `@decocms/blocks/metrics` (nothing without a `token` or an `endpoint`, and then the page template is never looked up), labelled `http.route` (the content's page template, `redirect` for every CMS redirect, a fixed one such as `/_serverFn/*` or `/assets/*`, otherwise `unmatched`), `http.request.method`, `status_class`, `cache` (`HIT`, `MISS`, `BYPASS` or `DRAFT`) and `device`.

Options, each for a value a site needs to change: `csp`, `segment`, `cacheProfiles`, `safeCookies`, `purgeToken`, `preload`, `previewHosts`, `routes` and `onCache`.

### Draft hosts

A draft link (`?__draft=`) previews where v7 allowed it: on the preview hosts the site declares (the `CMS` block's `preview.hosts`, or `createCMS`'s) and always on the hosts Deco runs the site on, `<site>.deco.site` and `<site>.deco-cx.workers.dev`. A site that declares no hosts previews only on those two, not on every host. `previewHosts: [...]` replaces the declared list with exact hosts (`["localhost:5173"]` for local development), as v7's `DECO_ALLOWED_PREVIEW_HOSTS` did; `previewHosts: "none"` turns previews off on every host. The same link can carry a published release's commit SHA instead of a draft (Studio's "Preview this version"), and either one can carry a preview time and forced tests; all of it passes the same host check, so a visitor on the live site never picks a version. The worker passes the accepted version to the app in the `x-deco-draft` request header.

### The visitor and the client

On every page and server-function request the worker reads the visitor with `readVisitor` from `@decocms/blocks/experiments` (the `deco_segment` cookie, or a new visitor) and hands it to the app on `x-deco-visitor`, removing any copy sent from outside. It sends the cookie on a first visit only (a visitor with no id yet), never from a preview. The saved `experiments` block decides the tests for the visitor the client carries; the worker only reads the answers.

Before the cache lookup the worker resolves `experiments` and `campaigns` through `cms.client({ visitor, version })`, as the page will, and keys the entry on the result: the tests the visitor is in and the campaigns running now, by name, never the visitor's id. Visitors on the same side of every test share one entry, the other side gets its own, and a campaign starting or ending moves every page to new entries. A site without those blocks keys as before. Previews (a draft, an old release, a preview time) are never cached.

`contentClient(cms)` from `@decocms/tanstack/server` builds `cms.client({ visitor, version })` from the two headers; `requestVisitor()` and `requestDraft()` (the version) return them for a site's own code. A request that didn't come through the worker has no visitor, so every test is off.

### Purge

With `purgeToken` set, `POST /_cache/purge` with `Authorization: Bearer <token>` and a body of `{ "paths": ["/", "/shoes"] }` stops every cached copy of each path from being served: every device and `segment` part, every query (`/shoes?page=2` is a copy of `/shoes`), navigations and programmatic fetches, the page's navigation data (a server function's GET that loads it), every side of every test whatever its share (a v7 visitor's stored side included), and every set of campaigns, with no limit on how many tests run. It costs one Cache API delete per path, not one per combination: each path keeps a generation in the edge cache (a small entry beside its copies) that every copy's key carries, and a purge deletes that entry, so the next request for any copy renders it again and the old copies expire unread. An evicted generation entry only causes a miss, never a stale page. The answer lists what it did: `{ "purged": ["/shoes"], "notCached": ["/"], "total": 1 }`, where `notCached` names the paths that had no copy to drop. Each path costs one of the request's Cache API calls (50 on Workers Free, 1,000 on Paid): when a delete fails the answer is a 503 that adds `notPurged`, the paths it didn't reach, to send again. The Cache API is per data center, so a purge reaches the copies of the data center that serves it, and never the copies a browser or a CDN in front of the worker keeps (navigation data the CDN may keep for the profile's fresh time).

### Names and Studio's origins

The root export holds what the worker, `/server` and `DecoDocument` share, for a site's own code: the draft names (`DRAFT_PARAM` `__draft`, `DRAFT_COOKIE` `__deco_draft`, `DRAFT_HEADER` `x-deco-draft`), `VISITOR_HEADER` (`x-deco-visitor`), `draftResponseHeaders(pointer)` (`no-store, private`, `Vary: Cookie`, `noindex`), and Studio's origins: `STUDIO_ORIGINS`, `STUDIO_FRAME_ANCESTORS` (what the worker's `frame-ancestors` starts from) and `isStudioOrigin`. `DecoDocument` passes `STUDIO_ORIGINS` to the Studio bridge.

```ts
import { DRAFT_HEADER, STUDIO_ORIGINS } from "@decocms/tanstack";
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
