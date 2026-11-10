# Caching and ISR on Next

The binding caches nothing itself. It shapes requests so Next's own cache
(ISR, keyed by path) can keep published pages, while previews and
per-visitor decisions stay out of it.

## The assignments route

Next caches a page by its path. Tests and campaigns change what a page shows,
so the proxy puts its decision into the path:

```
/shoes  →  /_assignments/<segment>/shoes
```

- The segment lists every test of the saved `experiments` block on or off for
  this visitor, and every campaign of the saved `campaigns` block running or
  not now. `-` means none; otherwise it is base64url, one spelling per set.
- The visitor id is never in it. Visitors on the same side of every test
  share one path and one cache entry.
- A campaign starting or ending moves every visitor to a new path.
- The rewritten request carries no visitor and no draft header. The page
  builds its client from the path alone (`assignedClient`), so it reads no
  request.

```tsx
// src/app/%5Fassignments/[assignments]/[[...path]]/page.tsx
export const revalidate = 600; // 10 minutes; never force-static
export async function generateStaticParams() {
  return []; // nothing at build time: each path renders on first request, then is cached
}
```

## What the numbers mean

`revalidate = 600`: Next serves a stored page for 10 minutes. The first
request after that still gets the stored copy while Next renders the page
again in the background. So:

- A published change shows within about 10 minutes on a page people visit.
- A page nobody opened for longer shows its old copy once more.
- A banner can switch on a few minutes late. That delay is accepted.

On a site with `site`, the CMS also checks for a new release every `interval`
(default 60 000 ms, minimum 5 000 ms). A re-render picks up whatever release the
process holds at that moment.

Never use `force-static` on a CMS page. A page that never expires keeps what
it rendered first, forever.

## What makes a page render on every request

Any of these anywhere in the route, its layouts included:

- `headers()`, `cookies()` or `searchParams`;
- `bindDraft` (it reads `headers()`), so the `contentClient(cms)` pattern
  that needs it (use `assignedClient` here);
- `export const dynamic = "force-dynamic"`.

A client component calling `useSearchParams()` does not stop the cache, but
renders on the client up to its nearest `<Suspense>`.

Check with `curl -sI https://<host>/<path>` twice: the second response should
show `x-nextjs-cache: HIT` (or `STALE` after 10 minutes). The example app's
smoke test checks exactly this.

## Rules the route depends on

- **Direct hits are a 404.** The proxy answers `/_assignments/…` and
  `/_draft/…` with 404 (`isAssignmentsRoutePath`, `isDraftRoutePath`), so only
  its own rewrite reaches the route. Otherwise anyone could switch a test on
  by typing a path.
- **Unknown names stay off, not 404.** `assignedClient` keeps off a test at 0%
  and drops a test or campaign the content doesn't have. It returns `null`
  (answer `notFound()`) only for a segment the proxy never writes. Next would
  cache a 404 under the path, and a path written just before a publish must
  still render.
- **Previews never land here.** `rewriteToAssignmentsRoute` returns `null` for
  any preview; those render on the dynamic `/_draft` route.
- **Only CMS pages.** The proxy calls it only for paths its `isCmsPage` (the
  site's own function) accepts.

## A CDN in front of Next

The URL the visitor asked for (`/shoes`) answers by their cookie and the
current time, even though Next's entry is shared. So when the content saves
tests or campaigns, the rewrite marks the response
`Cache-Control: private, no-cache`. Do not override that with a shared
`s-maxage` at the CDN.

A site that caches pages in front of Next keys on the assignments, never on
the visitor:

```ts
import { assignmentsKey, decideAssignments } from "@decocms/nextjs/proxy";

const key = assignmentsKey(await decideAssignments(proxyCms, draft, visitor));
// the version, the tests on and the campaigns running; "" when there are none
```

Never store a response that carries `?__draft=` or the `__deco_draft` cookie.
Those responses carry `Cache-Control: max-age=0, no-cache, must-revalidate`
and `Vary: Cookie`.

## Stale content after publishing

1. Wait out `revalidate` and request the page twice: the second request
   gets the new render.
2. Check the release the process holds: a site with `site` reloads it every
   `interval`.
3. Check that no CDN or `headers()` rule adds a long shared `max-age` on top.
4. A page on the draft route is never stale: if the draft shows the change
   and the published page doesn't, it is the cache, not the content.

Cache keys, hit rate and egress in general: load `deco-storefront-caching`.
Tests and campaigns content: load `deco-variants`.
