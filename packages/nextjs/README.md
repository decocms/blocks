# @decocms/nextjs

Deco CMS for any [Next.js](https://nextjs.org) App Router app. It makes no hosting assumptions: no CDN, ISR or platform behaviour is built in. It is a set of small helpers your site calls from its own proxy, layout, pages and `next.config`.

Peers: `@decocms/blocks` (same version), `next` 16, `react` 19.

| Import | What it is for |
| --- | --- |
| `@decocms/nextjs/proxy` | Draft previews in `proxy.ts`: `decideDraft`, `draftRequestHeaders`, `rewriteToDraftRoute`, `applyDraft`, `isDraftRoutePath`, or `draftProxy` for a site with no proxy of its own. No React and no block map. |
| `@decocms/nextjs/server` | Draft previews in Server Components: `bindDraft`, `activeDraftPointer`, `contentClient`. |
| `@decocms/nextjs` | `DraftPreviewIndicator` (the "Preview mode" badge on a draft page) and `StudioBridge` (lets Studio's site editor drive the page). |
| `@decocms/nextjs/config` | `withDeco(nextConfig)`: the draft header rules and Studio's dev origins. CommonJS, so `next.config.js` can `require()` it. |
| `@decocms/nextjs/image-loader` | `createDecoImageLoader(imageUrl)`: a next/image loader over an `ImageUrl` from `@decocms/blocks/image`. |

`isNextDev(process.env.NODE_ENV)` (from `/proxy` and `/server`) is the value for `createCMS({ dev })`, so `next dev` never swaps the hosted release in over your local content.

## Drafts

```ts
// src/cms.config.ts: the options both CMS handles share, and where drafts preview
export const cmsConfig = { content, dev: isNextDev(process.env.NODE_ENV) };
export const preview = { site: "my-store" };

// src/cms.ts and src/cms.proxy.ts
export const cms = createCMS({ blocks, ...cmsConfig });
export const proxyCms = createCMS({ blocks: {}, ...cmsConfig }); // no block map in the proxy

// src/proxy.ts
export async function proxy(request: NextRequest) {
  if (isDraftRoutePath(request.nextUrl.pathname)) return new NextResponse(null, { status: 404 });
  const draft = await decideDraft(proxyCms, request, preview);
  const response =
    rewriteToDraftRoute(request, draft) ??
    NextResponse.next({ request: { headers: draftRequestHeaders(request, draft) } });
  return applyDraft(response, draft);
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

## next.config

```js
const { withDeco } = require("@decocms/nextjs/config");
module.exports = withDeco({ images: { loader: "custom", loaderFile: "./src/image-loader.ts" } });
```

`withDeco` puts v7's two draft header rules before your own (a `?__draft=` query, or the draft cookie: no-store, `Vary: Cookie`, noindex) and adds Studio's origins to `allowedDevOrigins`. Each can be turned off: `withDeco(config, { draftHeaders: false, studioOrigins: false })`. Next sets `Cache-Control` and `Vary` itself on dynamic pages, so only `X-Robots-Tag` is sure to arrive from these rules; the proxy's `applyDraft` sets all three on the responses it makes.

## Images

```ts
// src/image-loader.ts
import { createDecoImageLoader, nextImageOptimizer } from "@decocms/nextjs/image-loader";
import { imageUrl } from "./imageUrl"; // createImageUrl({ providers: [...] }) from @decocms/blocks/image
export default createDecoImageLoader(imageUrl, { fallback: nextImageOptimizer });
```

A source a provider resizes gets the provider's URL; any other goes to `fallback` (`nextImageOptimizer` uses Next's own `/_next/image`), or comes back unchanged.

`examples/nextjs-binding-smoke` in the repository is a complete app, and its `bun run smoke` checks the whole flow on `next start`.
