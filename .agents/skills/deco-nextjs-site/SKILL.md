---
name: deco-nextjs-site
description: "Wiring a Next.js App Router site to @decocms/nextjs 8 (with @decocms/blocks 8, Next 16, React 19): the block map in .deco/index.tsx and the two createCMS handles, withDeco in next.config, the proxy (@decocms/nextjs/proxy: decideDraft, decideVisitor, decideAssignments, the /_draft and /_assignments rewrites, or draftProxy), reading and rendering resolved pages in Server Components (@decocms/nextjs/server: bindDraft, contentClient, assignedClient; matchRoute, redirects, notFound), page metadata from the page's seo block, ISR caching on the assignments route (revalidate = 600, never force-static, assignmentsKey for a CDN), the Studio bridge (StudioBridge, StudioPage, withStudioCsp), the next/image loader (@decocms/nextjs/image-loader) and the request metric (@decocms/nextjs/instrumentation). Load it for any v8 site built on Next.js: scaffolding, a draft that does not show, a page that renders on every request instead of caching, Studio not driving the page, or wrong metadata."
---

# Deco on Next.js (v8)

`@decocms/nextjs` 8 is a set of small helpers a Next.js App Router site calls
from its own `proxy.ts`, layouts, pages and `next.config`. It makes no hosting
assumption: no CDN, no platform rules. Content comes from `@decocms/blocks`
(`createCMS`, `client.resolve`, `matchRoute`); this package adds draft
previews, tests and campaigns decided once per request, Next's cache, and the
Studio bridge.

Load the reference for the job in front of you. Every name below exists in
`packages/nextjs/src` or `packages/blocks/src/v8`. The full working app is
`examples/nextjs-binding-smoke` in this repository: when this skill and that
example disagree, the example wins.

## When to load what

| Reference | Load it when |
|---|---|
| [`references/setup.md`](./references/setup.md) | Starting a site or adding Deco to a Next app: packages, file layout, the block map, the two CMS handles, `withDeco`, scripts, the image loader, the request metric |
| [`references/proxy-and-drafts.md`](./references/proxy-and-drafts.md) | Writing `proxy.ts`; a Studio draft link shows the published page; preview hosts; the draft route and `bindDraft`; the preview badge |
| [`references/rendering.md`](./references/rendering.md) | Reading and rendering a page in a Server Component: routes, redirects, `resolve`, sections, client components, errors |
| [`references/metadata-seo.md`](./references/metadata-seo.md) | `<title>` or description wrong or missing; the `seo` block; noindex on drafts |
| [`references/caching.md`](./references/caching.md) | ISR, the assignments route, a page that renders on every request, a CDN in front, stale content after publish |
| [`references/studio-bridge.md`](./references/studio-bridge.md) | Studio cannot select or reload sections, "." opens the wrong page, CSP blocks Studio, a local Studio |

## The shape of a request

1. `proxy.ts` decides once: the version (a Studio link's draft or old
   release, on an allowed host), the visitor (`deco_segment` cookie) and every
   test and campaign on or off.
2. A published CMS page is rewritten to `/_assignments/<segment>/<path>`. The
   page reads no request, so Next caches it (ISR).
3. A preview request is rewritten to `/_draft/<path>`. That route is dynamic,
   binds the draft with `bindDraft`, and is never cached.
4. Both routes build one content client, match the path, follow redirects,
   resolve the page and render its sections.

## Rules that are easy to break

- The route folders are `app/%5Fdraft/...` and `app/%5Fassignments/...`. A
  folder named `_draft` is private in Next and never routes.
- Never call `bindDraft`, `headers()`, `cookies()` or `searchParams` on the
  assignments route or in the root layout. Any of them makes Next render the
  page on every request.
- Never `export const dynamic = "force-static"` on a CMS page. Use
  `revalidate`.
- The proxy imports a CMS handle with an empty block map
  (`createCMS({ blocks: {}, ...cmsConfig })`), so no section reaches the proxy
  bundle.
- Never edit generated files (`.deco/schema.gen.json`, `.deco/blocks.gen.ts`).
  Change the types or the content and run the CLI again.

## Not in v8

v7's `createNextSetup`, `createDecoRouteHandlers`, `createDecoPreviewPage`,
the `/setup` and `/routeHandlers` subpaths, `src/sections/*` shims as block
keys, `generate:deco` and the `/deco/*` admin routes do not exist in
`@decocms/nextjs` 8. Moving a v7 site: load `deco-v7-to-v8-migration`.

## Related skills

- `deco-site-workflow`: the `deco` CLI (`schema`, `schema push`, `check`,
  `pull`, `push --draft`, `publish`) and how releases reach the site.
- `deco-site-authoring`: writing sections, pages and loaders.
- `deco-cms-schema`: how a Props type becomes the Studio form.
- `deco-variants`: multivariate blocks, tests and campaigns.
- `deco-images-media`: image providers, quality and LCP.
- `deco-storefront-caching`: cache keys and egress, with the Next equivalents.
- `deco-tanstack-site`: the same wiring on TanStack Start.
