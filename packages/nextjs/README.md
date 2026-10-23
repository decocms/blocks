# @decocms/nextjs

Deco CMS for any [Next.js](https://nextjs.org) App Router app. It makes no hosting assumptions: no CDN, ISR or platform behaviour is built in. It is a set of small helpers your site calls from its own proxy, layout, pages and `next.config`.

Peers: `@decocms/blocks` (same version), `next` 16, `react` 19; optionally `@opentelemetry/api` (see [Request metric](#request-metric)).

| Import | What it is for |
| --- | --- |
| `@decocms/nextjs/proxy` | What a request reads, decided once in `proxy.ts`: `decideDraft`, `draftRequestHeaders`, `rewriteToDraftRoute`, `applyDraft`, `isDraftRoutePath`, `decideVisitor`, `visitorRequestHeaders`, `applyVisitor`, `decideAssignments`, `assignmentsRequestHeaders`, or `draftProxy` for a site with no proxy of its own; `assignmentsKey` for a site's own cache key; `rewriteToAssignmentsRoute`, `isAssignmentsRoutePath`, `assignmentsRoutePath` and `assignmentsSegment` for Next's own cache. No React and no block map. |
| `@decocms/nextjs/server` | What the proxy decided, in Server Components: `bindDraft`, `activeDraftPointer`, `contentClient`; `assignedClient` for a page on the assignments route. |
| `@decocms/nextjs` | `DraftPreviewIndicator` (the "Preview mode" badge on a draft page), `StudioBridge` (lets Studio's site editor drive the page) and `StudioPage` (tells it which page is on screen), plus the draft names and Studio's origins (below). |
| `@decocms/nextjs/config` | `withDeco(nextConfig)`: the draft header rules and Studio's dev origins. CommonJS, so `next.config.js` can `require()` it. |
| `@decocms/nextjs/instrumentation` | `register`, the `instrumentation.ts` hook that records `http.server.request.duration` from Next's own request span, and `serverRequestSpanProcessor()` for a site with its own OpenTelemetry SDK. |
| `@decocms/nextjs/image-loader` | `createDecoImageLoader(imageUrl)`: a next/image loader over an `ImageUrl` from `@decocms/blocks/image`. |

`createCMS` reads `NODE_ENV` to decide dev mode, so `next dev` never swaps the hosted release in over your local content; nothing needs passing. `createCMS({ dev })` still overrides it when a site needs to.

## Drafts

```ts
// src/cms.config.ts: the options both CMS handles share (with `site`, hosted releases and
// the preview hosts Studio writes into them)
export const cmsConfig = { content, site: "my-store" };

// src/cms.ts and src/cms.proxy.ts
export const cms = createCMS({ blocks, ...cmsConfig });
export const proxyCms = createCMS({ blocks: {}, ...cmsConfig }); // no block map in the proxy

// src/proxy.ts
export async function proxy(request: NextRequest) {
  if (isDraftRoutePath(request.nextUrl.pathname)) return new NextResponse(null, { status: 404 });
  const draft = await decideDraft(proxyCms, request);
  const visitor = decideVisitor(request, draft);
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

// src/app/%5Fdraft/[[...path]]/page.tsx: the dynamic draft route (a literal `_draft` folder never routes)
export const dynamic = "force-dynamic";
export default async function DraftPage({ params, searchParams }) {
  await bindDraft(cms, { searchParams: await searchParams });
  const client = contentClient(cms);
  // … resolve and render the page as on the published route …
  return <>{page}<DraftPreviewIndicator /></>;
}
```

Published pages stay cached (ISR, below): the proxy sends only preview requests to the draft route (any `?__draft=`, `off` included, or the draft cookie; never the assignments route), sets the draft cookie, forwards the accepted version on `x-deco-version` (removing any copy sent from outside), and marks the response exactly `Cache-Control: max-age=0, no-cache, must-revalidate`, `Vary: Cookie` and `X-Robots-Tag: noindex, nofollow`. It reads a link's draft before forwarding it: a draft that can't be read anymore renders the release, expires the cookie and tells the pages on `x-deco-draft-unavailable`, so `DraftPreviewIndicator` shows a calm notice instead of an error page. A layout that reads content goes with its route, so the cached pages read no request: under the draft route (`app/%5Fdraft/layout.tsx`) it calls `bindDraft(cms)` and `contentClient(cms)`, which read the forwarded headers; under the assignments route (`app/%5Fassignments/[assignments]/layout.tsx`) it reads through `await assignedClient(cms, (await params).assignments)`. `bindDraft` reads `headers()`, and a cached page that reads a request header renders on every request instead, so never call it in the root layout or on the assignments route.

A draft link can carry a published release's commit SHA instead of a draft (Studio's "Preview this version"), and either one can carry a preview time (`__at`) and tests and campaigns switched on or off (`__test`, `__campaign`), which `cms.readVersion` reads as the client's `date`, `experiments` and `campaigns`. All of it passes the same host check and renders on the draft route: a visitor on the live site never picks a version. A preview may switch on a test at 0%.

### The visitor, the assignments and the client

The proxy decides once per request. `decideVisitor(request, draft)` reads the visitor with `readVisitor` from `@decocms/blocks/experiments` (the `deco_segment` cookie, or a new visitor); `applyVisitor` sends its cookie on a first visit only, never from a preview. `decideAssignments(proxyCms, draft, visitor)` then decides each test and campaign on or off: `cms.client({ visitor, version, date, experiments, campaigns })` with the visitor and the Studio link's version, moment and switched tests and campaigns, resolving the saved `experiments` and `campaigns` blocks. `visitorRequestHeaders` and `assignmentsRequestHeaders` forward them on `x-deco-visitor` and `x-deco-assignments` (`draftRequestHeaders` always removes copies sent from outside).

On the page, `bindDraft` binds the version and what the proxy forwarded (on the current release it binds the visitor and the assignments only when the release saves an `experiments` or `campaigns` block, and a test at 0% stays off whatever the header says), and `contentClient(cms)` builds `cms.client({ version, experiments, campaigns })` from them: the page decides nothing again. The pages trust those headers: behind the proxy they hold what it decided, and a request that reaches a page without it (a `matcher` that leaves the route out, or a site without the proxy) is read the same way, with whatever `x-deco-version` and `x-deco-assignments` it arrives with. Which routes go through the proxy, and how the others are protected, is the site's call. A cached page reads no request: the CMS's pages render on [the assignments route](#the-assignments-route), with the tests and campaigns the proxy decided in the path.

The binding caches nothing. A site that caches pages in front of Next (a CDN keyed on a request header) keys on the request's assignments, never on the visitor: `assignmentsKey(assignments)` from `@decocms/nextjs/proxy`, with what `decideAssignments` gave, is the version, the tests on and the campaigns running (`""` when there are none). Visitors on the same side of every test share one entry, and a campaign starting or ending changes the key. To let Next's own cache do it, see [the assignments route](#the-assignments-route).

### The assignments route

The proxy decides, the page renders that. Next caches a page by its path (ISR), so the proxy puts its decision in the path: it rewrites each CMS page to `/_assignments/<assignments>/<path>`, and the page renders exactly the tests and campaigns that segment names. Next then keeps one entry per path and set of assignments and serves it to every visitor with the same ones; the page reads no request, so Next can cache it. CMS pages are ISR with `revalidate = 600` (10 minutes): Next serves a stored page for 10 minutes; the first request after that still gets the stored copy while Next renders the page again in the background for the requests after it. So a published change shows within about 10 minutes on a page people open, and a page nobody opened for longer shows its old copy once more. That delay (for example, a banner switching on late) is accepted. Never `force-static` on Next.js: a page that never expires would keep what it rendered first.

```ts
// src/proxy.ts
import { isAssignmentsRoutePath, isDraftRoutePath, rewriteToAssignmentsRoute /* … */ } from "@decocms/nextjs/proxy";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isDraftRoutePath(pathname) || isAssignmentsRoutePath(pathname)) return new NextResponse(null, { status: 404 });
  const draft = await decideDraft(proxyCms, request, preview);
  const visitor = decideVisitor(request, draft);
  const assigned = isCmsPage(pathname) ? await rewriteToAssignmentsRoute(proxyCms, request, draft, visitor) : null;
  if (assigned) return applyVisitor(applyDraft(assigned, draft), visitor);
  const assignments = await decideAssignments(proxyCms, draft, visitor);
  const headers = assignmentsRequestHeaders(visitorRequestHeaders(draftRequestHeaders(request, draft), visitor), assignments);
  const response = rewriteToDraftRoute(request, draft, visitor, assignments) ?? NextResponse.next({ request: { headers } });
  return applyVisitor(applyDraft(response, draft), visitor);
}

// Next's own files never go through the proxy: rewritten, every script and style would be a 404.
export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };
```

```tsx
// src/app/%5Fassignments/[assignments]/[[...path]]/page.tsx: every CMS page (a literal `_assignments` folder never routes)
import { assignedClient } from "@decocms/nextjs/server";

export const revalidate = 600; // 10 minutes; never force-static
export async function generateStaticParams() {
  return []; // no path at build time: each renders on its first request, then is cached
}
export default async function Page({ params }) {
  const { assignments, path } = await params;
  const client = await assignedClient(cms, assignments);
  if (!client) notFound();
  // … match the path and resolve the page through `client`, as on any page …
}
```

- **What the segment holds**: every test of the saved `experiments` block on or off for the visitor and every campaign of the saved `campaigns` block running or not now (`readAssignments` on the current release), as `assignmentsSegment` writes it: `-` for none, otherwise base64url, one spelling per set of assignments. Visitors on the same side of every test get the same path; the visitor's id is never in it, and the rewritten request carries neither the visitor nor a draft header. A campaign starting or ending moves every visitor to a new path.
- **The page renders what the path names**: `await assignedClient(cms, segment)` builds `cms.client({ experiments, campaigns })` with every test and campaign as the segment names it and no visitor, a client fully decided in advance, so every visitor on that side renders the same page. The page never checks a campaign's dates or rolls a test itself. A test now at 0% stays off whatever the segment names. A page Next renders again later (revalidation) shows the same tests and campaigns under the same path.
- **The route trusts the path its proxy writes**: the proxy answers a direct hit on `/_assignments/…` with a 404, as it does for `/_draft/…`, so behind the proxy only its own rewrite reaches the route. A request that reaches the page some other way (a proxy `matcher` that leaves the route out, or a site without the proxy) renders the tests and campaigns its path names: `assignedClient` only keeps off a test at 0% and a test or a campaign the content doesn't have, and returns `null` (a 404) for a segment the proxy never writes. Which routes go through the proxy, and how the others are protected, is the site's call. Leaving off rather than answering 404 matters because Next caches a 404 under the path too: a path the proxy wrote before the page's server saw newly published content still renders.
- **The URL asked for stays private**: when the content saves tests or campaigns, the rewrite marks the response `Cache-Control: private, no-cache`. Next keeps one cached page per path and set of assignments, but `/shoes` itself answers by the visitor's cookie and the moment, so a CDN in front must not keep Next's ISR `s-maxage` under it.
- **A cached page reads no request**: `headers()`, `cookies()` or `searchParams` anywhere in the route (its layouts included, so no `bindDraft` there) make Next render it on every request instead of caching it, and a client component calling `useSearchParams()` renders on the client up to its nearest `<Suspense>`. `force-static` used to hide both by handing the page empty values; with ISR the page takes what it needs from the path, as the assignments do.
- **Drafts and previews are never rewritten here**: a drafted request goes to the dynamic draft route, so nothing from a preview lands in Next's cache.
- **Which paths**: only the CMS's pages (`isCmsPage` above is the site's own: routes of the app's own, such as `/blog` here, render as before). `draftProxy(proxyCms, { assignments: (request) => isCmsPage(request.nextUrl.pathname) })` does the same for a site with no proxy of its own.

`examples/nextjs-binding-smoke` in the repository runs it: two visitors on opposite sides of a test get different paths, two on the same side get one cached entry (`x-nextjs-cache: HIT`), the route is ISR at 600 seconds, and a typed `/_assignments/…` path is a 404.

### Draft hosts

A draft link (`?__draft=`) previews on the hosts the CMS allows, which `cms.readVersion` checks: the addresses Studio writes into the current release's metadata (`previewHosts` in `latest.json`, read with `createCMS`'s `site`), plus `createCMS({ preview: { hosts } })`. The site lists nothing else. With no list, every host previews: a site with no `latest.json` on the CDN yet, or one published before Studio wrote `previewHosts` (its next publish writes the list), and content with no `site` unless `preview.hosts` lists hosts (such as `["localhost"]`). If `latest.json` can't be read (a network error, a 5xx, a malformed file), previews stay closed, besides `preview.hosts`, until a read succeeds. The host is the one the visitor asked for (`x-forwarded-host`, else `host`); the proxy and `bindDraft` ask the same CMS. On a host that may not preview, the page renders the release; `?__draft=off` still ends a preview anywhere.

## The layout

```tsx
import { StudioBridge } from "@decocms/nextjs";

<body>
  {children}
  <StudioBridge site="my-store" />
</body>
```

Studio's origins are the package's own (`STUDIO_ORIGINS`), so the bridge takes only the site's name. v7's "." edit shortcut is on by default (`editShortcut={false}` turns it off), and `nonce` is optional.

On a page that isn't in Studio's frame, "." (or Ctrl+Shift+E) opens the page in Studio's editor, and Ctrl or Cmd+"." opens it in a new tab; Studio asks a visitor who isn't signed in to sign in first. To open the right page, each CMS page tells the bridge its path template: the root layout stays across navigations, so the page renders the marker, next to the sections it resolved:

```tsx
import { StudioPage } from "@decocms/nextjs";

const match = matchRoute(pathname, { routes: pages });
// …
return <>{sections}<StudioPage pathTemplate={match.entry.path} /></>;
```

It renders a `<meta>` that React places in the `<head>`, so the page's own markup doesn't change. Without it, Studio picks the page from the URL.

## Names and Studio's origins

For a site that needs them in its own code (a route that sets its own headers, a CSP it writes itself), `@decocms/nextjs` exports what the proxy, the pages and `withDeco` use: `DRAFT_PARAM` (`__draft`), `DRAFT_COOKIE` (`__deco_draft`), `VERSION_HEADER` (`x-deco-version`), `VISITOR_HEADER` (`x-deco-visitor`), `ASSIGNMENTS_HEADER` (`x-deco-assignments`), `draftResponseHeaders(version)`, `STUDIO_ORIGINS`, `STUDIO_FRAME_ANCESTORS` and `isStudioOrigin(origin)`. They have the same values as `@decocms/tanstack`'s; each binding keeps its own copy and never imports the other.

## next.config

```js
const { withDeco } = require("@decocms/nextjs/config");
module.exports = withDeco({ images: { loader: "custom", loaderFile: "./src/image-loader.ts" } });
```

`withDeco` puts v7's two draft header rules before your own (a `?__draft=` query, or the draft cookie: `max-age=0, no-cache, must-revalidate`, `Vary: Cookie`, noindex) and adds Studio's origins to `allowedDevOrigins`. Each can be turned off: `withDeco(config, { draftHeaders: false, studioOrigins: false })`. Next sets `Cache-Control` and `Vary` itself on dynamic pages, so only `X-Robots-Tag` is sure to arrive from these rules; the proxy's `applyDraft` sets all three on the responses it makes.

## Request metric

```ts
// src/instrumentation.ts (or instrumentation.ts at the root, next to app/)
export { register } from "@decocms/nextjs/instrumentation";
```

Next.js already measures every request it serves: one root span per request (`BaseServer.handleRequest`) that ends with the status, the method and the route's template. `register` gives Next a tracer provider whose only job is that span: when it ends, the request goes to the CMS's telemetry as `http.server.request.duration` (through `recordServerRequest` from `@decocms/blocks/metrics`) (seconds, the same buckets as the upstream clients' `http.client.request.duration`), next to everything else `createCMS` sends. No span is exported anywhere, and every other span Next asks for is a shared non-recording one. With no telemetry destination (no `token` and no `endpoint`) nothing is recorded.

| Label | Value |
| --- | --- |
| `http.route` | Next's route template: `/[[...path]]`, `/blog`, `/_draft/[[...path]]`. An RSC request counts under its page's route. `unmatched` when Next names none (an Edge route under `next start`) |
| `http.request.method` | `GET`, `POST`, …; any other is `_OTHER` |
| `status_class` | `2xx` … `5xx`; a request that threw is `5xx` |
| `cache` | `DRAFT` for a draft render (the proxy forwarded `x-deco-version`, or the request was rewritten onto `/_draft`), otherwise `BYPASS`: Next decides its own cache (`x-nextjs-cache`) on the response, which the span never sees |

- `@opentelemetry/api` is an optional peer: `register` uses the same copy Next does (yours when installed, else Next's compiled one) and does nothing if neither loads.
- **Your own OpenTelemetry setup** (`@vercel/otel`, `NodeSDK`): only one tracer provider can be registered, so `register` leaves yours alone and logs how to combine them. Add the processor to yours instead: `registerOTel({ serviceName, spanProcessors: ["auto", serverRequestSpanProcessor()] })`.
- **The proxy**: under `next start` Next runs the proxy through a request span of its own; that one is not counted, and the request the proxy hands on is. A response the proxy makes itself (a redirect, a 404 for a direct `/_draft` hit) never reaches a page and is not counted.
- **Edge runtime**: `register` does nothing there. Under `next start` an Edge route is still measured by the Node.js server that serves it (`unmatched`, no template); on a host that runs Edge functions on their own, nothing measures them.

## Images

```ts
// src/image-loader.ts
import { vtexCatalogWebp, vtexFileManager } from "@decocms/apps-vtex/image"; // your platform's helpers, if any
import { createImageUrl, decoCdn } from "@decocms/blocks/image";
import { createDecoImageLoader, nextImageOptimizer } from "@decocms/nextjs/image-loader";

const imageUrl = createImageUrl({
  providers: [
    vtexCatalogWebp(),
    vtexFileManager({ via: "query" }),
    decoCdn({ quality: "high", fit: "contain", layout: "quality-last" }),
  ],
});
export default createDecoImageLoader(imageUrl, { fallback: nextImageOptimizer });
```

The loader knows no commerce platform: the site lists its platform's helpers (`@decocms/apps-vtex/image`, `@decocms/apps-shopify/image`) before the Deco CDN, and the first provider that takes a source makes its URL. Any other source goes to `fallback` (`nextImageOptimizer` uses Next's own `/_next/image`), or comes back unchanged. With the providers above, a Next storefront's current loader URLs come out byte for byte (`tests/nextjs-image-loader.golden.test.ts` in the repository), except an already-resized Deco CDN URL in content: it is now re-resized from its `src` instead of becoming `src=image`.

`examples/nextjs-binding-smoke` in the repository is a complete app, and its `bun run smoke` checks the whole flow on `next start`.
