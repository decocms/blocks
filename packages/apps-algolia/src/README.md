# Algolia app — initial scaffold

This folder ports the Algolia integration from `deco-cx/apps/algolia`
(Fresh/Deno) to `@decocms/apps/algolia` (TanStack Start/Node), following
the same shape as `vtex/`, `magento/`, and `shopify/`.

## Status

**Initial scaffold** — covers the `configureAlgolia`/`getAlgoliaClient`
surface plus the `loaders/client.ts` shim that matches the upstream
`apps/algolia/loaders/client.ts` call site (`ctx.invoke.algolia.loaders.client({})`).
Just enough for downstream sites with their own product loaders to wire
Algolia and consume the SDK SearchClient directly.

A real-world consumer (deco-sites/granadobr-tanstack) is migrating away
from the legacy `ctx.invoke.algolia.loaders.client({})` proxy that
existed in the Fresh runtime. The site keeps its own product loaders
(custom Granado transforms over the upstream toProduct) and only needs
the SDK client from this package.

## What's here

- `client.ts` — `configureAlgolia({ applicationId, searchApiKey,
  adminApiKey })` + `getAlgoliaConfig()` accessor + lazy
  `getAlgoliaClient()` cached singleton. Mirrors `configureMagento` /
  `configureVtex`.
- `types.ts` — `AlgoliaConfig`, canonical `Indices` union.
- `loaders/client.ts` — returns the configured `SearchClient` so legacy
  call sites (`invoke.algolia.loaders.client({})`) keep working when
  routed through the loader registry.
- `index.ts` — re-export entry.

## Pending port (PR follow-ups)

These exist as production code in `deco-cx/apps/algolia/` and need a
Deno → Node pass (npm specifiers, `commerce/types.ts` shared import,
etc.). Tracked here so the next PR series has a clear scope:

| Path | Original location |
|---|---|
| `loaders/product/list.ts` | `deco-cx/apps/algolia/loaders/product/list.ts` |
| `loaders/product/listingPage.ts` | idem |
| `loaders/product/suggestions.ts` | idem |
| `actions/setup.ts` | `deco-cx/apps/algolia/actions/setup.ts` |
| `actions/index/{product,wait}.ts` | `deco-cx/apps/algolia/actions/index/*` |
| `utils/{highlight,product}.ts` | `deco-cx/apps/algolia/utils/*` |
| `workflows/index/product.ts` | `deco-cx/apps/algolia/workflows/index/product.ts` |
| `sections/Analytics/Algolia.tsx` | `deco-cx/apps/algolia/sections/Analytics/Algolia.tsx` |

The site-side `src/packs/algolia/products/*` in granadobr-tanstack
contains a Granado-specific transform layer that is not portable as-is.
Once `loaders/product/*` lands here, the upstream tract can be reused;
the Granado overlays will keep living in the site.

## Wiring in a site

```ts
// src/setup.ts
import { initAlgoliaFromBlocks } from "@decocms/apps/algolia";
import { blocks } from "./server/cms/blocks.gen";

createSiteSetup({
  // ...
  initPlatform: (blocks) => {
    initAlgoliaFromBlocks(blocks); // default block key: "deco-algolia"
  },
});
```

Then in your loaders:

```ts
import { getAlgoliaClient } from "@decocms/apps/algolia/client";

export default async function loader(props, req) {
  const client = getAlgoliaClient();
  const { results } = await client.search([{
    indexName: "products",
    query: props.term,
    params: { hitsPerPage: 12 },
  }]);
  return results[0].hits;
}
```

The Secret-shaped `adminApiKey` in the CMS block
(`{__resolveType: "website/loaders/secret.ts", name: "ADMIN_KEY"}`) is
dereferenced via `process.env.ADMIN_KEY` at init time, matching how
`magento/client.ts` handles secrets in this repo.
