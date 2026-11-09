# The proxy and draft previews

The proxy (`src/proxy.ts`, Next 16's name for middleware) decides once per
request what the request reads. The pages only render that decision. This
split is what lets published pages stay cached while Studio previews render
fresh.

## What the proxy decides

| Step | Function (`@decocms/nextjs/proxy`) | Result |
|---|---|---|
| Version | `decideDraft(proxyCms, request)` | A Studio link's draft or old release on an allowed host, its preview moment (`__at`) and switched tests and campaigns (`__test`, `__campaign`), the cookie to set |
| Visitor | `decideVisitor(request, draft)` | The `deco_segment` cookie, or a new visitor. Its cookie is sent on a first visit only, never from a preview |
| Tests and campaigns | `decideAssignments(proxyCms, draft, visitor)` | Each test of the saved `experiments` block on or off, each campaign of the saved `campaigns` block running or not. Missing blocks give none, never an error |

It forwards them to the page on request headers, always removing copies sent
from outside:

| Header | Set by |
|---|---|
| `x-deco-version` | `draftRequestHeaders(request, draft)` |
| `x-deco-visitor` | `visitorRequestHeaders(headers, visitor)` |
| `x-deco-assignments` | `assignmentsRequestHeaders(headers, assignments)` |

On the response, `applyDraft(response, draft)` sets the draft cookie and, on
any preview, `Cache-Control: max-age=0, no-cache, must-revalidate`,
`Vary: Cookie` and `X-Robots-Tag: noindex, nofollow`. `applyVisitor` sets the
visitor cookie.

## The proxy

```ts
// src/proxy.ts
import {
  applyDraft, applyVisitor, assignmentsRequestHeaders, decideAssignments, decideDraft,
  decideVisitor, draftRequestHeaders, isAssignmentsRoutePath, isDraftRoutePath,
  rewriteToAssignmentsRoute, rewriteToDraftRoute, visitorRequestHeaders,
} from "@decocms/nextjs/proxy";
import { type NextRequest, NextResponse } from "next/server";
import { proxyCms } from "./cms.proxy";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Only the rewrites below may reach these routes.
  if (isDraftRoutePath(pathname) || isAssignmentsRoutePath(pathname)) {
    return new NextResponse("Not found", { status: 404 });
  }
  const draft = await decideDraft(proxyCms, request);
  const visitor = decideVisitor(request, draft);
  const assigned = isCmsPage(pathname)
    ? await rewriteToAssignmentsRoute(proxyCms, request, draft, visitor)
    : null;
  if (assigned) return applyVisitor(applyDraft(assigned, draft), visitor);
  const assignments = await decideAssignments(proxyCms, draft, visitor);
  const headers = assignmentsRequestHeaders(
    visitorRequestHeaders(draftRequestHeaders(request, draft), visitor),
    assignments,
  );
  const response =
    rewriteToDraftRoute(request, draft, visitor, assignments) ??
    NextResponse.next({ request: { headers } });
  return applyVisitor(applyDraft(response, draft), visitor);
}

// The app's own routes, outside the CMS.
function isCmsPage(pathname: string): boolean {
  return pathname !== "/blog";
}

// Next's own files must not go through the proxy: rewritten, every script and style is a 404.
export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };
```

- `rewriteToAssignmentsRoute` returns `null` for a preview, so a preview
  falls through to `rewriteToDraftRoute`.
- `rewriteToDraftRoute` returns `null` when the request carries no draft
  signal; the request then goes on with the forwarded headers.
- `isCmsPage` is the site's own. Routes the app owns (a blog index, an API
  route) render as before and still get the forwarded headers.

**A site with no proxy logic of its own** exports
`draftProxy(proxyCms, options)` instead:

```ts
export const proxy = draftProxy(proxyCms, {
  assignments: (request) => isCmsPage(request.nextUrl.pathname),
});
```

`assignments` picks the paths rewritten to the assignments route (default:
none) and makes direct hits on that route a 404. `rewrite` picks which
previews go to the draft route (default: all); return `false` for a route
that is already dynamic and binds the draft itself.

## The draft route

```tsx
// src/app/%5Fdraft/[[...path]]/page.tsx
import { DraftPreviewIndicator } from "@decocms/nextjs";
import { bindDraft, type SearchParams } from "@decocms/nextjs/server";
import { cms } from "../../../cms";
import { openPage, pathnameFor } from "../../../open-page.server";
import { PageView } from "../../PageView";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ path?: string[] }>; searchParams: Promise<SearchParams> };

export default async function DraftPage({ params, searchParams }: Props) {
  await bindDraft(cms, { searchParams: await searchParams });
  const opened = await openPage(pathnameFor((await params).path));
  return (
    <>
      <PageView {...opened} />
      <DraftPreviewIndicator />
    </>
  );
}
```

- The folder is `%5Fdraft`. A literal `_draft` folder is private in Next and
  never routes.
- `bindDraft(cms, { searchParams })` binds, for this request: the page's own
  `?__draft=` (`off` ends the preview), else `x-deco-version`, else the draft
  cookie, each checked against the preview hosts. It also binds the visitor
  and the assignments the proxy forwarded. It returns whether a version was
  bound.
- `contentClient(cms)` then builds `cms.client({ version, experiments, campaigns })`
  from what was bound. Create one per request. `openPage` in
  [rendering.md](./rendering.md) calls it.
- `DraftPreviewIndicator` renders the "Preview mode" badge only when a draft
  is bound. Render it inside the page, after `bindDraft`, never in a layout:
  a layout may render before the page binds. `exitHref` overrides where
  "Exit preview" goes (default: the current URL with `?__draft=off`).
- A layout under the draft route that reads content
  (`app/%5Fdraft/layout.tsx`) calls `bindDraft(cms)` and `contentClient(cms)`
  without `searchParams`; it reads the forwarded headers.
- `activeDraftPointer()` from `@decocms/nextjs/server` returns the bound
  version, or `null` on the current release.

## Preview hosts

A draft link previews only on hosts the CMS allows: the `previewHosts`
Studio writes into the current release's metadata, plus
`createCMS({ preview: { hosts } })`. The host is the one the visitor asked
for (`x-forwarded-host`, else `host`).

| Situation | Who may preview |
|---|---|
| A site whose release lists `previewHosts` | Those hosts and `preview.hosts` |
| No release on the CDN yet, or one published before Studio wrote the list | Every host |
| No `site` and no `preview.hosts` | Every host |
| The release metadata can't be read (network, 5xx, bad file) | Only `preview.hosts`, until a read succeeds |

On a host that may not preview, the page renders the release. `?__draft=off`
ends a preview on any host.

`preview.draftHosts` replaces the hosts a draft pointer may point at
(default: `.decocms.com` and loopback).

## Debugging a draft that shows the published page

1. Is the request reaching the proxy? Check the `matcher`.
2. Is the host allowed? Compare `x-forwarded-host` or `host` with the release's
   `previewHosts` and `preview.hosts`. Add a local host such as `localhost`
   to `preview.hosts` to preview in development.
3. Does the page call `bindDraft` before reading content, on the draft route?
4. Is the preview badge showing "unavailable"? The link's draft can no longer
   be read (deleted, or the drafts host failing). The page renders the
   release and the badge shows a notice instead of an error page.
5. Is a CDN or a `headers()` rule caching responses that carry `?__draft=` or
   the `__deco_draft` cookie? Draft responses must not be stored.

Studio links, draft names and `deco push --draft`: load `deco-site-workflow`.
Variant previews with `__test` and `__campaign`: load `deco-variants`.
