# The worker entry

`src/worker-entry.ts` is the Worker (`wrangler.jsonc` `main`). It puts `createDecoWorker` from
`@decocms/tanstack/worker` in front of TanStack Start's server entry. The full contract is
`packages/tanstack/README.md`; this file is what a site needs to wire and debug it.

## The smallest entry

```ts
import { createDecoWorker } from "@decocms/tanstack/worker";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { cms } from "./cms";

export default createDecoWorker({
  serverEntry: createServerEntry({ fetch: handler.fetch }),
  cms,
  dev: import.meta.env.DEV,
});
```

This caches no page: every request renders. A site with a page cache starts from
`examples/tanstack-worker-smoke/src/worker-entry.ts` (v7's edge cache on the Cloudflare Cache API,
its profiles and its purge route) and owns it from there. How to key and purge it:
`deco-storefront-caching`.

## What it always does

No option turns these off.

- `/deco/_liveness` answers `OK`. v7's admin paths (`/deco/*`, `/live/*`, `/.decofile`) answer 404.
  v8 has no `/deco/invoke`, `/deco/meta` or `/deco/render`.
- **Drafts.** `?__draft=<pointer>` or the `__deco_draft` cookie previews a draft, on the hosts the
  CMS allows (`createCMS` `preview.hosts`, plus the ones Studio writes into the release). Any request
  with a draft signal (`?__draft=off` too) is a preview: it never reaches `pageCache` and answers
  `Cache-Control: max-age=0, no-cache, must-revalidate`, `Vary: Cookie` and
  `X-Robots-Tag: noindex, nofollow`. A link to a
  draft that can't be read renders the release, never a 500. A link on another host gets the
  release.
- **The CMS redirects**, for `GET`/`HEAD` page requests, before anything else. Server-function
  calls, assets and `/_build` are not redirected.
- **The visitor and the tests.** It reads the visitor (`deco_vid` cookie, or a new one) and
  decides each test and campaign once, then hands them to the app on request headers it strips
  from incoming requests (below). The visitor cookie goes out on a first visit only, and never on a request that renders a draft
  or an old release.
- **Headers on the way out**: the security headers and Studio's CSP on HTML
  ([`document-and-security.md`](./document-and-security.md)); `Cache-Control: public,
  max-age=31536000, immutable` on fingerprinted assets; one `Set-Cookie` per cookie (the last one
  for each name + Domain + Path); `x-page-status` turned into the status;
  `CDN-Cache-Control: no-store` on any response that sets none.
- **A request with `Authorization`** never reaches `pageCache` and answers
  `Cache-Control: private, no-cache, no-store, must-revalidate`.
- **`http.server.request.duration`** for every request, to the CMS's telemetry (nothing without a
  token or endpoint).

Don't rebuild any of these in the site: a hand-written draft check that reads `?__draft=` lets
anyone bypass the cache on production.

## Options

| Option | For |
|---|---|
| `serverEntry` | TanStack Start's server entry. Required. |
| `cms` | The site's CMS. Required. |
| `dev` | `import.meta.env.DEV`: `pageCache` is never called, and loopback may frame the site. |
| `csp` | `{ enforce?, reportOnly?, frameAncestors? }`: the site's Content-Security-Policy. Studio's origins are always added. |
| `studioOrigins` | The Studio origins the CSP allows. Set the same list on `DecoDocument`. |
| `pageCache` | `(page) => Promise<Response>`: the site's cache. Called only for requests `isCacheable` accepts. |
| `preload` | `{ styles?, fonts? }`: `Link: rel=preload` headers on every HTML response the app renders. |
| `routes` | `(request, env, ctx) => Response \| null`: the escape hatch. |

## `routes`: requests the site answers itself

`routes` runs after the CMS redirects and before anything else. Return a `Response` to answer
(a commerce proxy, a sitemap, an A/B split to another origin), or `null` to let the worker serve
the request.

```ts
export default createDecoWorker({
  serverEntry: createServerEntry({ fetch: handler.fetch }),
  cms,
  dev: import.meta.env.DEV,
  routes: (request, env) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/checkout")) return proxyCheckout(request, env);
    return null;
  },
});
```

Its response still gets the security headers and `CDN-Cache-Control: no-store` (unless it sets
one), but no `preload` hints: it is another origin's page. A v7 A/B split on Workers KV has a
ready handler for `routes`: `abTestingRoutes` from `@decocms/compat-v7/tanstack/worker`.

Code that must run around everything (a geo cookie, a purge endpoint) wraps the worker's `fetch`
instead, as the example does with `POST /_cache/purge`:

```ts
const worker = createDecoWorker<Env>({
  serverEntry: createServerEntry({ fetch: handler.fetch }),
  cms,
  dev: import.meta.env.DEV,
  pageCache,
});
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike) {
    if (request.method === "POST" && new URL(request.url).pathname === "/_cache/purge") {
      return purge(request, env);
    }
    return worker.fetch(request, env, ctx);
  },
};
```

## What the app receives

The worker sets these on the request it passes to TanStack Start, and removes copies sent from
outside:

| Header | Holds | Read with (`@decocms/tanstack/server`) |
|---|---|---|
| `x-deco-version` | The draft or old release the request renders | `requestVersion()` |
| `x-deco-visitor` | The visitor | `requestVisitor()` |
| `x-deco-assignments` | Each test and campaign, on or off | `requestAssignments()` |
| `x-deco-release-check` | The draft's check of the latest release | (used by `contentClient`) |

`contentClient(cms, request)` builds the content client from all of them. Each helper defaults to
the current request (`getRequest()`). The header names are exported from `@decocms/tanstack`
(`VERSION_HEADER`, `VISITOR_HEADER`, `ASSIGNMENTS_HEADER`) for code that sets its own headers.

A request that reaches the app without the worker carries whatever headers it came with. Only
expose the app through the worker.

## `pageCache` in one paragraph

`pageCache(page)` gets `page.request`, `page.url`, `page.visitor`, `page.assignments`,
`page.device`, `env`, `ctx` and `page.render(scope?)`. Answer from your cache or call `render()`,
and set `X-Cache` (`HIT`, `STALE-HIT`, `STALE-ERROR`, `MISS`) so the request metric counts it.
The worker adds the visitor's first-visit cookie after `pageCache` answers: never store a
response that sets any other cookie. The key helpers (`assignmentsKey`, `cacheVersion`,
`detectDevice`, `segmentKey`, `segmentToken`, `isCacheable`, `serverFnPagePath`,
`DEGRADED_HEADER`) are all in `@decocms/tanstack/worker`. Everything else about the cache:
`deco-storefront-caching`.

## Debugging

| Symptom | Look at |
|---|---|
| `/deco/invoke/...` answers 404 | Expected. Replace each call with a server function ([`server-functions.md`](./server-functions.md)). |
| A draft link shows the published page | The host isn't in the CMS's preview hosts. Add it to `createCMS({ preview: { hosts } })`. |
| A redirect works on reload but not on a client-side navigation | `openPage` must check the redirects block too ([`routes-and-pages.md`](./routes-and-pages.md)). |
| Studio can't frame the site | A `frame-ancestors` the site set itself, or `studioOrigins` set on one side only ([`document-and-security.md`](./document-and-security.md)). |
| The page renders but the status is 200 for a CMS "not found" page | Set `x-page-status` from the route's `headers`. |
