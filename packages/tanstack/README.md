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

`examples/tanstack-worker-smoke` in the repository is a complete app.
