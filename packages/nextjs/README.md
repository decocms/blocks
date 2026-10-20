# @decocms/nextjs

Deco CMS for any [Next.js](https://nextjs.org) App Router app. It makes no hosting assumptions: no CDN, ISR or platform behaviour is built in. It is a set of small helpers your site calls from its own proxy, layout, pages and `next.config`.

Peers: `@decocms/blocks` (same version), `next` 16, `react` 19; optionally `@opentelemetry/api` (see [Request metric](#request-metric)).

| Import | What it is for |
| --- | --- |
| `@decocms/nextjs/proxy` | Draft previews and A/B assignments in `proxy.ts`: `decideDraft`, `draftRequestHeaders`, `rewriteToDraftRoute`, `applyDraft`, `isDraftRoutePath`, `decideAssignments`, `assignmentRequestHeaders`, `applyAssignments`, or `draftProxy` for a site with no proxy of its own. No React and no block map. |
| `@decocms/nextjs/server` | Draft previews and A/B assignments in Server Components: `bindDraft`, `activeDraftPointer`, `contentClient`. |
| `@decocms/nextjs` | `DraftPreviewIndicator` (the "Preview mode" badge on a draft page), `StudioBridge` (lets Studio's site editor drive the page) and `StudioPage` (tells it which page is on screen), plus the draft names and Studio's origins (below). |
| `@decocms/nextjs/config` | `withDeco(nextConfig)`: the draft header rules and Studio's dev origins. CommonJS, so `next.config.js` can `require()` it. |
| `@decocms/nextjs/instrumentation` | `register`, the `instrumentation.ts` hook that records `http.server.request.duration` from Next's own request span, and `serverRequestSpanProcessor()` for a site with its own OpenTelemetry SDK. |
| `@decocms/nextjs/image-loader` | `createDecoImageLoader(imageUrl)`: a next/image loader over an `ImageUrl` from `@decocms/blocks/image`. |

`createCMS` reads `NODE_ENV` to decide dev mode, so `next dev` never swaps the hosted release in over your local content; nothing needs passing. `createCMS({ dev })` still overrides it when a site needs to.

## Drafts

```ts
// src/cms.config.ts: the options both CMS handles share, and where drafts preview
export const cmsConfig = { content };
export const preview = { site: "my-store" };

// src/cms.ts and src/cms.proxy.ts
export const cms = createCMS({ blocks, ...cmsConfig });
export const proxyCms = createCMS({ blocks: {}, ...cmsConfig }); // no block map in the proxy

// src/proxy.ts
export async function proxy(request: NextRequest) {
  if (isDraftRoutePath(request.nextUrl.pathname)) return new NextResponse(null, { status: 404 });
  const draft = await decideDraft(proxyCms, request, preview);
  const assignments = await decideAssignments(proxyCms, request, draft);
  const headers = assignmentRequestHeaders(draftRequestHeaders(request, draft), assignments);
  const response =
    rewriteToDraftRoute(request, draft, assignments) ?? NextResponse.next({ request: { headers } });
  return applyAssignments(applyDraft(response, draft), assignments);
}

// src/app/%5Fdraft/[[...path]]/page.tsx: the dynamic draft route (a literal `_draft` folder never routes)
export const dynamic = "force-dynamic";
export default async function DraftPage({ params, searchParams }) {
  await bindDraft(cms, { searchParams: await searchParams, ...preview });
  const client = contentClient(cms);
  // … resolve and render the page as on the published route …
  return <>{page}<DraftPreviewIndicator /></>;
}
```

Published pages stay static: the proxy sends only drafted requests to the draft route, sets the draft cookie, forwards the accepted pointer on `x-deco-draft` (removing any copy sent from outside), and marks the response `Cache-Control: no-store, private` and `X-Robots-Tag: noindex, nofollow`. A root layout that reads content calls `bindDraft(cms, preview)` too: it reads the forwarded header.

### A/B tests

A/B tests are content: the `Experiments` block (each test's name and the percentage of visitors in it) and the `experiment` matcher in a block's variants. On each request, `decideAssignments` runs `assign` from `@decocms/blocks/experiments` over the `Experiments` block of the content it renders (the release, or the draft) and the visitor's `deco_segment` cookie; `assignmentRequestHeaders` forwards the result on `x-deco-assignments` (`draftRequestHeaders` always removes a copy sent from outside), and `applyAssignments` sets the cookie only when the visitor's assignments changed. With no experiments, nothing is forwarded and no cookie is set. A draft is assigned for the draft's `Experiments`, so a test created in a draft runs in its preview, and never writes the cookie; the variants Studio forces in its link still apply. On the page, `bindDraft` binds the forwarded assignments (on the release it reads the request only when the release has experiments) and `contentClient(cms)` passes them to the client, where the `experiment` matcher reads them. A page that should vary per visitor has to render per request.

### Draft hosts

v7's allowlist. A draft link (`?__draft=`) previews on the preview hosts the site declares (the `CMS` block's `preview.hosts`, or `createCMS`'s; a site that declares none has none, as in v7) and always on the hosts Deco runs the site on, `<site>.deco.site` and `<site>.deco-cx.workers.dev`. `previewHosts: [...]` replaces the declared list (v7's `DECO_ALLOWED_PREVIEW_HOSTS`, such as `["localhost:3000"]` in development); `previewHosts: "none"` turns previews off on every host. Hosts compare exactly, port included, on the host the visitor asked for (`x-forwarded-host`, else `host`). Pass the same options to `decideDraft` and `bindDraft`. On a host that may not preview, the page renders the release; `?__draft=off` still ends a preview anywhere.

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

For a site that needs them in its own code (a route that sets its own headers, a CSP it writes itself), `@decocms/nextjs` exports what the proxy, the pages and `withDeco` use: `DRAFT_PARAM` (`__draft`), `DRAFT_COOKIE` (`__deco_draft`), `DRAFT_HEADER` (`x-deco-draft`), `ASSIGNMENTS_HEADER` (`x-deco-assignments`), `draftResponseHeaders(pointer)`, `STUDIO_ORIGINS`, `STUDIO_FRAME_ANCESTORS` and `isStudioOrigin(origin)`. They have the same values as `@decocms/tanstack`'s; each binding keeps its own copy and never imports the other.

## next.config

```js
const { withDeco } = require("@decocms/nextjs/config");
module.exports = withDeco({ images: { loader: "custom", loaderFile: "./src/image-loader.ts" } });
```

`withDeco` puts v7's two draft header rules before your own (a `?__draft=` query, or the draft cookie: no-store, `Vary: Cookie`, noindex) and adds Studio's origins to `allowedDevOrigins`. Each can be turned off: `withDeco(config, { draftHeaders: false, studioOrigins: false })`. Next sets `Cache-Control` and `Vary` itself on dynamic pages, so only `X-Robots-Tag` is sure to arrive from these rules; the proxy's `applyDraft` sets all three on the responses it makes.

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
| `cache` | `DRAFT` for a draft render (the proxy forwarded `x-deco-draft`, or the request was rewritten onto `/_draft`), otherwise `BYPASS`: Next decides its own cache (`x-nextjs-cache`) on the response, which the span never sees |

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
