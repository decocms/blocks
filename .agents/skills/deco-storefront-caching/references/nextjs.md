# Next.js: the same rules on @decocms/nextjs

`@decocms/nextjs` caches nothing either. Caching is Next's own (ISR, the full route cache) and
whatever CDN sits in front. The binding's job is to make that safe: a cached page must never be a
preview, and must never be keyed on the visitor. The setup itself is in `deco-nextjs-site`.

## What `@decocms/nextjs/proxy` does

`draftProxy(proxyCms, options)` is the whole flow for a site without a proxy of its own. A site
with one calls `decideDraft`, `decideVisitor`, `decideAssignments`, the `*RequestHeaders` helpers
and `applyDraft` / `applyVisitor` itself.

| Request | What happens | Cache effect |
|---|---|---|
| Any draft signal (`?__draft=`, `off` included, or the draft cookie) | Rewritten onto the dynamic draft route (`/_draft/<path>`, mounted as `app/%5Fdraft/...`) | Never cached. `Cache-Control: max-age=0, no-cache, must-revalidate`, `Vary: Cookie`, `X-Robots-Tag: noindex, nofollow` |
| A published CMS page, with `options.assignments(request)` true | Rewritten onto `/_assignments/<assignments>/<path>` (`rewriteToAssignmentsRoute`) | Next keeps one cached page per set of assignments. The visitor id is never in the path |
| Anything else | Forwarded with `x-deco-version`, `x-deco-visitor`, `x-deco-assignments` | Your route decides |

On the assignments route the page builds its client with `assignedClient(cms, segment)` from
`@decocms/nextjs/server`, which reads no request, so Next can cache it:

```tsx
export const revalidate = 600;
export async function generateStaticParams() {
  return [];
}
export default async function Page({ params }) {
  const { assignments, path } = await params;
  const client = await assignedClient(cms, assignments);
  if (!client) notFound();
  // …
}
```

With `revalidate = 600`, a page can be about ten minutes stale; the first request after that
still gets the old page while Next renders again.

## The visitor URL vs the cached route

When the content has saved tests or campaigns, the proxy marks the response to the URL the visitor
asked for `Cache-Control: private, no-cache`. Next caches the rewritten route, but the original
URL answers differently by cookie and by moment, so a CDN in front must not keep it under that
URL.

A CDN that should cache in front of Next keys on the request's assignments, never the visitor:
`assignmentsKey(await decideAssignments(proxyCms, draft, visitor))`, `""` when there are none.
`assignmentsKey` is exported from `@decocms/nextjs/proxy` with the same output as the TanStack
worker's.

## What carries over from the TanStack references

- `cache-keys.md`: everything except the example's `cacheKey` and `pageCache` code. Tracking
  params, segments, never storing degraded or empty pages, private responses, single-flight.
- `egress-traps.md`: all traps; read `X-Cache` and `X-Cache-Reason` only if your CDN or code sets
  them. Next's own response headers tell you whether a page came from its cache.
- `verification.md`: the probes, with your CDN's headers in place of the example's.

What does not carry over: `createDecoWorker`, `pageCache`, `cacheVersion`, `__cseg` and
`decoServerFnFetch`, and the example's purge route. On Next, a release reaching cached pages is a
question of `revalidate` and Next's own invalidation.
