# `@decocms/apps-blog` — port status

Source of truth: [`deco-cx/apps/blog`](https://github.com/deco-cx/apps/tree/main/blog).
This package was originally copied from `apps-start`'s already-reduced blog port
(Task 13 of `docs/apps-monorepo-migration-plan.md`), not from the Deno original,
so a chunk of the upstream surface was missing. This file tracks what is now in
sync and what deliberately isn't.

## Ported

| Upstream | Here | Notes |
|---|---|---|
| `types.ts` | `src/types.ts` | Full parity, incl. `PostStatus`, `isPublishedStatus`, `isLivePost`, `Publisher`, `Review`/`Rating`/`AggregateRating`, `Ignore`, `ImageCarousel`. `Section` is redeclared as the opaque `any` type — see the docstring, it's what triggers the admin's section picker. |
| `utils/{date,constants,jsonLD,sanitizeHtml,hardSanitize,blocksToSections}.ts` | `src/utils/` | Near-literal; pure functions. |
| `core/handlePosts.ts` | `src/core/handlePosts.ts` | Incl. `filterRoutablePosts` and UTC-pinned date sorting. |
| `core/records.ts` | `src/core/records.ts` | `getRecordsByPath` uses `loadBlocks()` instead of `ctx.get(resolvables)`. Ratings/reviews go through the adapter (below). |
| `loaders/*.ts` (9) | `src/loaders/` | `ctx` replaced by `src/client.ts`; `(props, req?)` signatures. |
| `loaders/extensions/*/[ratings,reviews].ts` (6) | `src/loaders/extensions/` | — |
| `actions/submit{Rating,Review,View}.ts` | `src/actions/` | Persistence via the adapter. |
| `sections/Seo/*.tsx` (2) | `src/sections/Seo/` | Reuse `Seo`/`renderTemplateString`/`SEOSection` from `@decocms/apps-website/components/Seo`. |
| `sections/Template.tsx` | `src/sections/Template.tsx` | `renderSection` replaced by `getSyncComponent` from `@decocms/blocks/cms/client`. |
| `sections/blocks/*.tsx` (17) | `src/sections/blocks/` | `class` → `className`, SVG attrs camelCased; otherwise unchanged. |
| `static/css.ts` | `src/static/css.ts` | Verbatim. |

## Deliberately not ported

| Upstream | Why |
|---|---|
| `db/schema.ts` | Drizzle/SQLite table definitions for the `records` app. Neither the app nor `drizzle-orm` exists in this monorepo, and pulling them in would make every site installing the blog carry a DB client. The table/column names now live on the site's side of `src/core/blogRecords.ts`. |
| `loaders/extensions/{BlogpostList,BlogpostListing,BlogpostPage}.ts` | Three-line delegations to `website/loaders/extension.ts` — the *generic* extension-composition loader. That loader has not been ported into `@decocms/apps-website`; reimplementing it here would put a website-app concern in the wrong package. The 6 concrete ratings/reviews extensions are ported and callable directly. **Tracked gap: port `website/loaders/extension.ts` into `@decocms/apps-website`.** |
| `manifest.gen.ts` (as generated) | `scripts/generate-manifests.ts` doesn't exist in this repo (deferred, `docs/apps-monorepo-migration-plan.md`). `src/manifest.gen.ts` is hand-maintained — add new loaders/actions/sections to it manually. |
| `mod.ts`'s `preview` / `PreviewContainer` | `utils/preview.tsx` is Deno-app scaffolding with no equivalent here; `preview` is `undefined`, matching every other `apps-*` package. |

## Ratings, reviews and view counts

These three features need persistence. Upstream reaches the separate `records`
app (`await ctx.invoke.records.loaders.drizzle()`); here the dependency is
inverted, the same way `@decocms/blocks-admin` inverts KV via
`setFastDeployKVGetter`:

```ts
import { setBlogRecordsAdapter } from "@decocms/apps-blog";

setBlogRecordsAdapter({
  listPostViews: () => db.select(...),
  incrementPostView: (id) => ...,
  // listRatings, upsertRating, listReviews, getReview, createReview, updateReview
});
```

Every method is optional. With **no adapter registered**, reads return `[]`,
writes return `null`, `submitView` returns `{ count: 0 }`, and `view_asc` /
`view_desc` sorting falls back to date order — so a blog with no comments and no
view counter works untouched. Note this differs from upstream on one point:
the Deno app *threw* `"Deco Records not installed!"` on a view sort without the
backend; degrading was chosen instead, since view sorting is an enhancement and
a missing backend shouldn't blank a listing.

## Divergences from upstream worth knowing

- **Title and view sorts are inverted** — `title_asc` yields Z-A, and
  `view_desc` puts the *least*-viewed post first. Both come from upstream's
  comparator (`sortOrder === "desc" ? comparison : -comparison` over an `a - b`
  difference); only the `date` branch, which compares `b - a`, reads the right
  way round. Preserved on purpose so a site moving off the Deno app sees no
  reordering — see the comments in `src/core/handlePosts.ts`. Fix upstream
  first, then here.
- **`sortPosts([])` throws** (it reads `blogPosts[0]`). Upstream does too;
  `handlePosts` guards the empty case before calling it.
