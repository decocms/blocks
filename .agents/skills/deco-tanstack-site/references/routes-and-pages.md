# Routes and pages

A v8 site has no route factory. A page is three small files the site owns: the catch-all route,
the page server function, and `openPage`, which routes and resolves. v7's `cmsRouteConfig`,
`loadCmsPage` and `DecoPageRenderer` have no v8 equivalent.

```
src/routes/$.tsx  →  loadPage (src/page.functions.ts)  →  openPage (src/open-page.server.ts)
   route loader         createServerFn, GET                 matchRoute, redirects, resolve
```

During the server render `loadPage` is a plain call. On a client-side navigation the browser
fetches it from `/_serverFn/…`.

## `openPage`: route, redirect, resolve

```ts
// src/open-page.server.ts
import { notFound, redirect } from "@tanstack/react-router";
import { matchRoute, type Seo } from "@decocms/blocks";
import { client } from "./cms";
import type { StoredPage } from "./model";

export async function openPage<T>(href: string, request: Request) {
  const c = client(request);
  const [routes, routesError] = await c.routes();
  if (routesError) throw routesError;
  const match = matchRoute(href, { routes });
  // The page's blocks download with the redirects block, in one wave.
  if (match.kind === "match") c.prefetch(match.entry.name);
  const [redirects, redirectsError] = await c.redirects();
  if (redirectsError) throw redirectsError;
  const moved = matchRoute(href, { routes: [], redirects });
  if (moved.kind === "redirect") throw redirect({ href: moved.location, statusCode: moved.status });
  if (match.kind !== "match") throw notFound();

  const [page, pageError] = await c.resolve<StoredPage>(match.entry.name, { run: false });
  if (pageError) throw pageError;
  const sections = Array.isArray(page.sections) ? page.sections : [page.sections];
  const blocks = sections.map((block, index) => ({
    key: `${href}:${index}`,
    value: c.resolve<T | T[] | undefined>(block).then(([value, blockError]) => {
      if (blockError) console.error(blockError);
      return { value: value ?? undefined, failed: blockError !== null };
    }),
  }));
  const [seo, seoError] = await c.resolve<Seo | undefined>(page.seo);
  if (seoError) throw seoError;
  return { seo, blocks, pathTemplate: match.entry.path };
}
```

What each part does:

- **`client.routes()`** lists `{ name, path }` of every page from the content index, without
  reading page bodies. `matchRoute(url, { routes, redirects? })` returns `{ kind: "match", entry,
  params }`, `{ kind: "redirect", location, status }` or `{ kind: "not-found" }`. Exact segments win
  over `:params`, and params over a `*` splat, per segment.
- **Redirects** are the site's redirects block (`client.redirects()`). The worker already answers
  them for page navigations before the app runs. `openPage` checks them again because a client-side
  navigation reaches it as a server-function call, which the worker doesn't redirect.
- **`resolve(name, { run: false })`** reads the page without running its blocks. Each section is
  then resolved on its own, so each is its own promise and streams on its own.
- **`resolve` returns `[value, error]`** (`Result<T>`): a failed block comes back as an error, so
  check it. Report errors where you get them: v8 has no global error hook.
- **`pathTemplate`** is the page's `path` as `matchRoute` matched it. `DecoDocument` reads it from
  the deepest route's loader data, so "." opens that page in Studio's editor. Add `pageId` the same
  way if you have one. The example app leaves it out; add it.

**Always route the page's URL, never the request's.** `request.url` is the server-function URL on
a client-side navigation. Pass the request only to `client(request)`, which reads the headers the
worker set.

## The server function

```ts
// src/page.functions.ts
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { openPage } from "./open-page.server";
import type { BlockDescriptor } from "./model";

function localPath(data: { href: string }) {
  const href = data?.href;
  if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//") || href.startsWith("/\\")) {
    throw new Error("not a local path");
  }
  return { href };
}

export const loadPage = createServerFn({ method: "GET" })
  .inputValidator(localPath)
  .handler(({ data }) => openPage<BlockDescriptor>(data.href, getRequest()));
```

Reject `//host` and `/\host`: both start with `/` and are protocol-relative URLs. A check of
`startsWith("/")` alone (the example app's zod schema) lets them through. Keep it a `GET`: a page
load is then a cacheable URL, and `serverFnPagePath(url)` from `@decocms/tanstack/worker` can read
the page path out of its `payload` for the site's page cache. Server functions in general:
[`server-functions.md`](./server-functions.md).

## The catch-all route

```tsx
// src/routes/$.tsx
import { Suspense } from "react";
import { Await, createFileRoute } from "@tanstack/react-router";
import { decoStringifySearch } from "@decocms/tanstack/router";
import { loadPage } from "../page.functions";

/** Search params that only select among data already loaded: they never reach the server. */
const CLIENT_ONLY = new Set(["skuId"]);

export const Route = createFileRoute("/$")({
  loaderDeps: ({ search }) => ({
    search: Object.fromEntries(Object.entries(search).filter(([k]) => !CLIENT_ONLY.has(k))),
  }),
  loader: ({ location, deps }) =>
    loadPage({ data: { href: location.pathname + decoStringifySearch(deps.search) } }),
  head: ({ loaderData }) => ({
    meta: loaderData?.seo
      ? [{ title: loaderData.seo.title }, { name: "description", content: loaderData.seo.description }]
      : [],
  }),
  component: Page,
});

function Page() {
  const page = Route.useLoaderData();
  return page.blocks.map((block) => (
    <Suspense key={block.key} fallback={null}>
      <Await promise={block.value}>
        {({ value, failed }) => (failed ? null : value ? <View block={value} /> : null)}
      </Await>
    </Suspense>
  ));
}
```

`View` maps each descriptor to its component (`switch (block.component)`); a value that is an
array is the chosen variant of a whole section list. `undefined` means an editor hid the block.

### Search params

- **`loaderDeps` decides what the loader depends on.** TanStack builds the route match's id from
  the route, its path params and `JSON.stringify(loaderDeps)`. Put every param the page's data
  depends on in it (`q`, `sort`, `page`, `filter.*`); leave out params that only pick among data
  already on the page (a SKU in a product's variant list). Never drop `q`: search then never works.
- **Build the href from `deps`, not from `location.search`**, so the page the server opens is the
  page the match is keyed on.
- **Use `decoStringifySearch`.** `createDecoRouter` parses a repeated key into an array
  (`?filter.size=M&filter.size=L` → `{ "filter.size": ["M", "L"] }`). `new URLSearchParams(search)`
  joins that array into `filter.size=M%2CL`; `decoStringifySearch` writes both values back. The
  migration script's generated route uses `URLSearchParams`; change it if the site has repeated
  filter keys.
- **Empty values are kept** (`?q=`). TanStack compares the request URL with
  `stringify(parse(url))` on the server and redirects (307) when they differ; the Deco pair is a
  fixed point, so it never does.
- **Links and pagination**: carry every current param over and change one. `<Link search>` with
  arrays works on the Deco router; `Object.fromEntries(new URLSearchParams(...))` drops all but one
  value per key. More in [`router-and-navigation.md`](./router-and-navigation.md).
- **The commerce loader gets the URL from the page**, not from the request. A loader that needs the
  query reads it from what `openPage` passes it. How loaders get the URL: `deco-site-authoring`.

## Status codes

- A URL with no page: `throw notFound()` in `openPage`; the route's `notFoundComponent` (or the
  root's) renders.
- A CMS page that should answer with another status (a "not found" page the editors manage): set
  `x-page-status` (`PAGE_STATUS_HEADER` from `@decocms/tanstack/router`) from the route's
  `headers`, for example
  `headers: ({ loaderData }) => (loaderData?.status ? { [PAGE_STATUS_HEADER]: String(loaderData.status) } : {})`.
  The worker turns it into the response status and removes the header. A status set while
  rendering does not reach the response; a route's `headers` do.
- A page whose loader failed but still rendered: set `DEGRADED_HEADER` (`x-deco-degraded`, from
  `@decocms/tanstack/server`) to `"true"` with `setResponseHeader` while the server function runs. The
  example page cache never stores such a response. Caching: `deco-storefront-caching`.

## Head and SEO

The route's `head()` returns meta from the loader data. `DecoDocument` renders `<HeadContent />`,
so the root route's `head()` (charset, viewport, a default title) and the page's merge there.
What to put in it (canonical, Open Graph, JSON-LD): `deco-site-authoring`.
