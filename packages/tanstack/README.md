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

Always on: `/deco/_liveness`; 404 for v7's admin paths; Studio may frame the site (`frame-ancestors`, no `X-Frame-Options`) and the security headers; drafts (the host allowlist, the draft cookie, never cached, `noindex`); the CMS redirects; an edge cache keyed on the build, the content revision, the device and your `segment`, with stale-while-revalidate and stale-if-error; CDN caching of client-side navigation data under a checked `__cseg` token; one `Set-Cookie` per cookie; `x-page-status`.

Options, each for a value a site needs to change: `csp`, `segment`, `cacheProfiles`, `safeCookies`, `purgeToken`, `preload`, `previewHosts`, `routes` and `onCache`.

### Draft hosts

A draft link (`?__draft=`) previews where v7 allowed it: on the preview hosts the site declares (the `CMS` block's `preview.hosts`, or `createCMS`'s) and always on the hosts Deco runs the site on, `<site>.deco.site` and `<site>.deco-cx.workers.dev`. A site that declares no hosts previews only on those two, not on every host. `previewHosts: [...]` replaces the declared list with exact hosts (`["localhost:5173"]` for local development), as v7's `DECO_ALLOWED_PREVIEW_HOSTS` did; `previewHosts: "none"` turns previews off on every host. The worker passes the accepted draft to the app in the `x-deco-draft` request header: read it with `contentClient(cms)` from `@decocms/tanstack/server`.

### Names and Studio's origins

The root export holds what the worker, `/server` and `DecoDocument` share, for a site's own code: the draft names (`DRAFT_PARAM` `__draft`, `DRAFT_COOKIE` `__deco_draft`, `DRAFT_HEADER` `x-deco-draft`), `draftResponseHeaders(pointer)` (`no-store, private`, `Vary: Cookie`, `noindex`), and Studio's origins: `STUDIO_ORIGINS`, `STUDIO_FRAME_ANCESTORS` (what the worker's `frame-ancestors` starts from) and `isStudioOrigin`. `DecoDocument` passes `STUDIO_ORIGINS` to the Studio bridge.

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
