# Metadata from blocks

On Next, a page's `<title>`, description and other head tags come from
`generateMetadata`. On a Deco page, the source is the page block's `seo`
field. This file covers the wiring; what to put in SEO content and JSON-LD is
in `deco-site-authoring`.

## The seo block

`@decocms/blocks` types it as `Seo { title: string; description: string }`,
and the built-in `page` block carries an optional `seo` next to `sections`.
There is no built-in `seo` block function: the site registers one in its block
map, so Studio can draw the form and saved pages can reference it.

```tsx
// .deco/index.tsx
import type { Blocks, Seo } from "@decocms/blocks";

export default {
  seo: (input: Seo) => input,
  // … sections …
} satisfies Blocks;
```

```json
{
  "__resolveType": "page",
  "name": "Summer shirt",
  "path": "/:slug/p",
  "seo": {
    "__resolveType": "seo",
    "title": "Summer shirt | My store",
    "description": "Light cotton shirt for hot days."
  },
  "sections": []
}
```

When `resolve` runs the page, `seo` is resolved too: `page.seo` holds what the
`seo` function returned.

Need more fields (canonical, Open Graph image, noindex)? Give the site's `seo`
function its own Props type that extends `Seo`, and type the resolved page
with your own interface instead of `Page`. The CMS passes the props through;
nothing in the binding reads them.

## generateMetadata

```tsx
// src/app/%5Fassignments/[assignments]/[[...path]]/page.tsx
import type { Metadata } from "next";
import { openPage, pathnameFor } from "../../../../open-page.server";

type Props = { params: Promise<{ assignments: string; path?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { assignments, path } = await params;
  const page = await openPage(pathnameFor(path), assignments);
  return { title: page.seo?.title, description: page.seo?.description };
}
```

- `openPage` is wrapped in React's `cache()` ([rendering.md](./rendering.md)),
  so the metadata and the page share one resolve per request.
- On the assignments route, read only `params`. Reading `headers()`,
  `cookies()` or `searchParams` in `generateMetadata` makes the page render
  on every request, the same as in the page.
- On the draft route, call `bindDraft` before `openPage` in
  `generateMetadata` too: Next may run it before the page body.
- Leave a field `undefined` when the page has no `seo`. Next then uses the
  root layout's `metadata` (site defaults, a `title.template`).

## Drafts are noindex

A preview must never be indexed. Two layers already do it:

- The proxy's `applyDraft` sets `X-Robots-Tag: noindex, nofollow`,
  `Cache-Control: max-age=0, no-cache, must-revalidate` and `Vary: Cookie` on
  every preview response.
- `withDeco`'s header rules add `X-Robots-Tag: noindex, nofollow` to any
  request with `?__draft=` or the `__deco_draft` cookie.

Do not remove either to "fix" a header conflict. If a site-wide rule in
`headers()` sets `Cache-Control`, `withDeco` already places the draft rules
first.

## Head tags the binding adds

`StudioPage` renders `<meta name="deco:page" content="<path template>">`.
React hoists it into `<head>`; it does not change the page's markup or SEO.

## Checks

- `curl -s https://<host>/<path> | grep -i '<title>'` shows the page's
  `seo.title`, not the layout default.
- A page with a `:slug` path has one `seo` for every slug. Per-item titles
  (a product name) come from a loader that the `seo` block reads; load
  `deco-site-authoring`.
- `curl -sI 'https://<host>/<path>?__draft=<name>'` shows
  `X-Robots-Tag: noindex, nofollow`.
