# Setup

How a Next.js App Router app becomes a v8 Deco site. The reference app is
`examples/nextjs-binding-smoke`; copy from it rather than from memory.

## Packages

| Package | Why |
|---|---|
| `@decocms/blocks` | The CMS (`createCMS`, `matchRoute`, types), the `deco` CLI (its `bin`), `@decocms/blocks/image` |
| `@decocms/nextjs` | The Next helpers. Same version as `@decocms/blocks` |
| `next` 16, `react` 19 | Peers of `@decocms/nextjs` (Node 24 or later). Install `react-dom` 19 with them, as any Next app does |
| `server-only` | Optional. The example marks its server modules with it |
| `@opentelemetry/api` | Optional peer, for the request metric only |

`@decocms/nextjs` has six entry points. Each is a separate subpath so the
proxy never loads React:

| Import | Used from |
|---|---|
| `@decocms/nextjs/proxy` | `src/proxy.ts` |
| `@decocms/nextjs/server` | Server Components (it reads `next/headers`) |
| `@decocms/nextjs` | Layouts and pages: `StudioBridge`, `StudioPage`, `DraftPreviewIndicator`, names and Studio origins |
| `@decocms/nextjs/config` | `next.config` (CommonJS, so `require()` works too) |
| `@decocms/nextjs/image-loader` | The next/image `loaderFile` |
| `@decocms/nextjs/instrumentation` | `src/instrumentation.ts` |

## Files

| File | What it holds |
|---|---|
| `.deco/index.tsx` | The block map: the default export, `satisfies Blocks` |
| `.deco/blocks/*.json` | Saved content, one block per file |
| `.deco/schema.gen.json` | Written by `deco schema`. Commit it. Do not edit |
| `.deco/blocks.gen.ts` | Written by `deco content`, only for content without `site`. Do not edit |
| `src/cms.config.ts` | Every `createCMS` option except `blocks` |
| `src/cms.ts` | `cms = createCMS({ blocks, ...cmsConfig })` for pages |
| `src/cms.proxy.ts` | `proxyCms = createCMS({ blocks: {}, ...cmsConfig })` for the proxy |
| `src/proxy.ts` | See [proxy-and-drafts.md](./proxy-and-drafts.md) |
| `src/app/%5Fassignments/[assignments]/[[...path]]/page.tsx` | Every published CMS page. See [caching.md](./caching.md) |
| `src/app/%5Fdraft/[[...path]]/page.tsx` | Every preview. See [proxy-and-drafts.md](./proxy-and-drafts.md) |
| `src/app/layout.tsx` | The root layout, with `<StudioBridge site="…" />` |
| `src/image-loader.ts` | The next/image loader |
| `src/instrumentation.ts` | The request metric |

## The block map

A saved block's `__resolveType` names a key of the block map. The function
gets the block's resolved props and returns what the page renders: a React
element for a section, plain data for anything else.

```tsx
// .deco/index.tsx
import type { Blocks, Seo } from "@decocms/blocks";
import ProductHero from "../src/ProductHero";
import PromoBanner from "../src/PromoBanner";
import type { ProductHeroProps, PromoBannerProps } from "../src/model";

export default {
  seo: (input: Seo) => input,
  "promo-banner": (input: PromoBannerProps) => <PromoBanner {...input} />,
  "product-hero": (input: ProductHeroProps) => <ProductHero {...input} />,
} satisfies Blocks;
```

- The key is the block's identity in content. Renaming it breaks every saved
  block that uses it.
- The CMS adds built-in blocks to every map: `lazy`, `multivariate`, `always`,
  `never`, `experiment`, `campaign`, `page`, `redirect`, `redirects`,
  `cms-settings`, `split-traffic`, `calendar`. Do not reuse those names.
- The Props type of each function is the Studio form. `deco schema` reads it
  from `.deco/index.tsx` (or `.deco/index.ts`). Form details: load
  `deco-cms-schema`.

**Editability check.** A section that renders literal text in JSX looks
right and cannot be edited in Studio. For every section, check that what an
editor should change comes from its props, and that the block map points at
the real component with its real Props type, not a static copy.

## The two CMS handles

```ts
// src/cms.config.ts
export const cmsConfig = { site: "my-store" };

// src/cms.ts
import { createCMS } from "@decocms/blocks";
import blocks from "../.deco";
import { cmsConfig } from "./cms.config";
export const cms = createCMS({ blocks, ...cmsConfig });

// src/cms.proxy.ts
import { createCMS } from "@decocms/blocks";
import { cmsConfig } from "./cms.config";
export const proxyCms = createCMS({ blocks: {}, ...cmsConfig });
```

`createCMS` keeps one instance per process for each `site` (or, without
`site`, each content module), so both handles share content and release
checks. Each handle keeps its own block map. The proxy's handle has no block map, so no
section code lands in the proxy bundle.

Where content comes from:

- **With `site`** (Studio's site slug): the site's latest release on the
  delivery CDN, loaded at runtime and checked again every `interval` (default
  and minimum 60 000 ms). Passing `content` too throws.
- **Without `site`**: pass `content`, the module `deco content` writes from
  `.deco/blocks` (`import content from "../.deco/blocks.gen"`). Used by tests
  and the examples.

Other options: `preview: { hosts, draftHosts }` (see
[proxy-and-drafts.md](./proxy-and-drafts.md)), `telemetry` (`false`, or
`{ endpoint, headers }` for an OTLP/HTTP collector), and `token`, a
server-only secret that sends telemetry to the hosted collector and needs
`site`. Never import `token` into client code.

## next.config

```ts
// next.config.ts
import { withDeco } from "@decocms/nextjs/config";

export default withDeco({
  images: { loader: "custom", loaderFile: "./src/image-loader.ts" },
});
```

`withDeco(nextConfig, options?)` adds two things and nothing about hosting:

- `draftHeaders` (default on): two header rules placed before the site's own
  `headers()`. A request with `?__draft=` or the `__deco_draft` cookie gets
  `Cache-Control: max-age=0, no-cache, must-revalidate`, `Vary: Cookie` and
  `X-Robots-Tag: noindex, nofollow`. Next sets `Cache-Control` and `Vary`
  itself on dynamic pages, so only `X-Robots-Tag` is sure to arrive from these
  rules; the proxy's `applyDraft` sets all three.
- `studioOrigins` (default on): Studio's hosts in `allowedDevOrigins`, so
  `next dev` serves Studio its dev assets.

Turn either off with `withDeco(config, { draftHeaders: false, studioOrigins: false })`.

## Scripts

Run the CLI before Next (the example does the same through a small script):

```json
"predev": "deco schema && deco content",
"prebuild": "deco schema && deco content"
```

Drop `deco content` when the site uses `site`. Use `deco schema --check` in
CI to fail on a stale schema, and `deco schema push` on production deploys so
Studio draws the forms. Order and secrets: load `deco-site-workflow`.

If the host installs only `dependencies` in production builds, keep
`@decocms/blocks` there: the `deco` bin comes from it and `prebuild` needs it.

## Images

```ts
// src/image-loader.ts
import { createImageUrl, decoCdn } from "@decocms/blocks/image";
import { createDecoImageLoader, nextImageOptimizer } from "@decocms/nextjs/image-loader";

const imageUrl = createImageUrl({ providers: [decoCdn({ fit: "contain" })] });
export default createDecoImageLoader(imageUrl, { fallback: nextImageOptimizer });
```

The first provider that takes a source builds its URL. A commerce site lists
its platform's helpers (`@decocms/apps-vtex/image`,
`@decocms/apps-shopify/image`) before `decoCdn`. Any other source goes to
`fallback`: `nextImageOptimizer` sends it through `/_next/image`; without a
fallback the `src` comes back unchanged. next/image's `quality` may also be a
named tier (`low`, `medium`, `high`, `original`); `nextImageOptimizer` sends
them as 60, 70, 80 and 100.
Providers, quality and LCP: load `deco-images-media`.

## Request metric

```ts
// src/instrumentation.ts
export { register } from "@decocms/nextjs/instrumentation";
```

`register` turns Next's own request span into `http.server.request.duration`
in the CMS's telemetry, labelled by `http.route`, `http.request.method`,
`status_class` and `cache` (`DRAFT` or `BYPASS`). It records nothing without
a telemetry destination, and does nothing on the Edge runtime. A site with its
own OpenTelemetry setup adds `serverRequestSpanProcessor()` to its span
processors instead, because only one tracer provider can be registered.
