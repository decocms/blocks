# Reading and rendering a page

Pages are Server Components. They get one content client, match the path,
follow redirects, resolve the page block and render its sections. The same
function serves the draft route, the assignments route and
`generateMetadata`.

## The client

| Where | Client | Why |
|---|---|---|
| Assignments route (published CMS pages) | `await assignedClient(cms, segment)` | Built from the path segment, reads no request, so Next can cache the page. `null` for a segment the proxy never writes: answer `notFound()` |
| Draft route, and the app's own dynamic routes | `contentClient(cms)`, after `await bindDraft(...)` | Built from what `bindDraft` bound from the request and the proxy's headers |

Both come from `@decocms/nextjs/server`. Create a client per request. A client
runs each block function once per distinct input and memoizes the result, so
results are shared and read-only: copy before changing one.

## The page function

```ts
// src/open-page.server.ts
import "server-only";
import { cache, type ReactNode } from "react";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { matchRoute, type Page } from "@decocms/blocks";
import { assignedClient, contentClient } from "@decocms/nextjs/server";
import { cms } from "./cms";

export const openPage = cache(async (pathname: string, assignments?: string) => {
  const c = assignments === undefined ? contentClient(cms) : await assignedClient(cms, assignments);
  if (!c) notFound();

  const [routes, routesError] = await c.routes();
  if (routesError) throw routesError;
  const match = matchRoute(pathname, { routes });
  // Start downloading the page's blocks while the redirects block loads.
  if (match.kind === "match") c.prefetch(match.entry.name);

  const [redirects, redirectsError] = await c.redirects();
  if (redirectsError) throw redirectsError;
  const moved = matchRoute(pathname, { routes: [], redirects });
  if (moved.kind === "redirect") {
    if (moved.status === 301 || moved.status === 308) permanentRedirect(moved.location);
    redirect(moved.location);
  }
  if (match.kind !== "match") notFound();

  const [page, error] = await c.resolve<Page<ReactNode>>(match.entry.name);
  if (error) throw error;
  return page;
});

export const pathnameFor = (segments: string[] = []) =>
  "/" + segments.map(encodeURIComponent).join("/");
```

Why each step is there:

- **`cache()`** from React: `generateMetadata` and the page call `openPage`
  with the same arguments in one request; they share one result.
- **`routes()`** reads `{ name, path }` of every page from the content index,
  without page bodies. `client.list()` was removed and throws: route with
  `routes()` and `redirects()`, and read other types with `entries(type)`.
- **`matchRoute(pathname, { routes, redirects })`** returns
  `{ kind: "match", entry, params }`, `{ kind: "redirect", location, status }`
  or `{ kind: "not-found" }`. Exact segments win over `:params`, params over a
  trailing `*`. `match.params` holds the matched params.
- **`prefetch(name)`** starts fetching the page and everything it references
  in one parallel wave, with the redirects block. It never throws.
- **Redirects** run before the not-found. Statuses are 301, 302, 307 or 308.
  Next's `permanentRedirect` answers 308 and `redirect` 307.
- **`resolve(name)`** runs the page: `seo` and every block in `sections` are
  resolved, so `sections` holds what each block function returned.

The example app also routes a custom block type (blog posts that carry a
`path`): it adds the `{ name, path }` of `(await c.entries("post"))` to the
routes it matches (from the index, no post body read) and reads the one post
that matched.

## Results and errors

`resolve`, `entries`, `routes` and `redirects` return a tuple instead of
throwing: `[value, null]` or `[null, CMSError]`. (`revision()` is the
exception: it rejects when content can't load.) `CMSError` has `code`, `message`, `path` (where in the
tree, such as `["sections", 2, "product"]`) and, for function failures,
`cause`.

| Code | Meaning |
|---|---|
| `NOT_FOUND` | No saved block by that name |
| `UNKNOWN_BLOCK` | A `__resolveType` not in the block map |
| `CYCLE` | Blocks reference each other in a loop |
| `BLOCK_FAILED` | A block function threw |
| `LOADER_FAILED` | The content didn't load. On a site with `site`, its `cause` is a `ContentUnavailableError` until the first load succeeds |

Throwing the error renders Next's error boundary. Decide per page whether a
failed block should fail the page or be skipped.

## Rendering sections

```tsx
// src/app/PageView.tsx
import { StudioPage } from "@decocms/nextjs";
import { Fragment, type ReactNode } from "react";
import type { Page } from "@decocms/blocks";

export function PageView({ page }: { page: Page<ReactNode> }) {
  return (
    <main>
      {page.sections.map((section, index) => (
        <Fragment key={index}>{section}</Fragment>
      ))}
      <StudioPage pathTemplate={page.path} />
    </main>
  );
}
```

- A section function returns a React element, so the page renders the list
  as is. A site may return descriptors instead (`{ component, props }`) and
  map them itself; `Page<Section>` takes either.
- `StudioPage` renders a `<meta>` that tells the Studio bridge which page
  template is on screen. See [studio-bridge.md](./studio-bridge.md).
- Sections are Server Components by default. Put interactive parts in a
  `"use client"` component the section renders (the example's `ProductHero`
  renders a client `CartButton`). Props passed to a client component must be
  serializable.
- A client component that calls `useSearchParams()` renders on the client up
  to its nearest `<Suspense>` on a cached page. Wrap it.
- A block prop that is a `lazy` block arrives as a function
  `() => Promise<T>` that resolves only when called. Lazy blocks and loading
  states: load `deco-site-authoring`.

## The two routes

```tsx
// src/app/%5Fassignments/[assignments]/[[...path]]/page.tsx
import { openPage, pathnameFor } from "../../../../open-page.server";
import { PageView } from "../../../PageView";

export const revalidate = 600;
export async function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ assignments: string; path?: string[] }> };

export default async function Page({ params }: Props) {
  const { assignments, path } = await params;
  return <PageView page={await openPage(pathnameFor(path), assignments)} />;
}
```

The draft route is the same page with `bindDraft` first and
`DraftPreviewIndicator` after; see [proxy-and-drafts.md](./proxy-and-drafts.md).
Why the assignments route looks like this: [caching.md](./caching.md).

## Routes the app owns

A route outside the CMS (a blog index, an account page) calls
`await bindDraft(cms)` (with `{ searchParams }` on a page) and then reads with
`contentClient(cms)`, which uses the version, visitor and assignments the
proxy forwarded. Leave it out of the proxy's `isCmsPage` so it is not
rewritten. `bindDraft` reads request headers, so Next renders the route per
request.

`contentClient` only reads what `bindDraft` bound. Called without it, it
reads the current release with no visitor: every test is off, and campaigns
are checked against the current time.

Writing sections, loaders and page blocks: load `deco-site-authoring`.
