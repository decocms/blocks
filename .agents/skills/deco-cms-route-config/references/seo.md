# SEO architecture — `page.seo`, registered SEO sections, JSON-LD

SEO in @decocms/tanstack works across four layers:

### 1. CMS `page.seo` Block (primary source)

CMS page JSONs have a top-level `seo` field separate from `sections`. This is the **primary** SEO data source, processed by `resolvePageSeoBlock()` in `resolve.ts`.

**Key behavior: Lazy/Deferred wrappers are always unwrapped.** SEO metadata must be in the initial SSR HTML for crawlers. The original Fresh/Deno framework did NOT do this, causing PDP pages to have zero SSR SEO when `page.seo` was wrapped in `Lazy.tsx`. We fix this by design.

Resolution pipeline:
1. Unwrap Lazy/Deferred
2. Follow named block references
3. Evaluate multivariate flags

   Steps 1–3 share a hard cap of **10 hops** (the `depth < 10` loop in `resolvePageSeoBlock`); a chain deeper than that returns `null` (no page.seo).
4. Resolve all nested `__resolveType` (commerce loaders for product data) — **unless** the request is from a human (not a bot / eager request) and either the section's `ignoreStructuredData` toggle is on or `setAsyncRenderingConfig({ botAwareSeo: true })` is set. Then props backed by a commerce loader are stripped (`stripCommerceLoaderProps`) and are absent from that SSR result; crawlers always get them resolved.
5. Return `ResolvedSection` in `DecoPageResult.seoSection`

In `cmsRoute.ts`, the seoSection is enriched by its section loader (if one is registered) in the same batch as the body sections (`runSectionLoadersWithSeo`), then:
- `extractSeoFromProps()` picks title/description/canonical/image/noIndexing/jsonLDs/type
- `titleTemplate` / `descriptionTemplate` from the CMS block are applied (e.g., `"%s | STORE NAME"`)

### 2. Page-Level Meta (framework `head()`)

`cmsRouteConfig` and `cmsHomeRouteConfig` generate `<head>` metadata automatically from the merged `PageSeo` object (page.seo primary + sections secondary). Includes title, description, canonical, OG (title, description, image, type, url), Twitter Card, and robots.

### 3. Section-Contributed SEO (secondary source, `registerSeoSections`)

Sections in `page.sections` that also contribute SEO metadata register themselves in `setup.ts`:

```typescript
import { registerSeoSections } from "@decocms/blocks/cms";

registerSeoSections([
  "site/sections/SEOPDP.tsx",     // Product structured data + meta
  "site/sections/SEOPLP.tsx",     // Category/search meta
]);
```

Their props are scanned for these SEO fields. A **section loader** is only needed when the fields must be computed or enriched (e.g. derived from a product); a section without a loader passes through and its CMS props are extracted as-is:

```typescript
interface PageSeo {
  title?: string;
  description?: string;
  canonical?: string;
  image?: string;
  noIndexing?: boolean;
  jsonLDs?: Record<string, any>[];
  type?: string;    // og:type: "website", "product", etc.
}
```

After `runSectionLoaders`, the framework scans registered SEO sections and extracts these fields. Page.seo fields take precedence when both sources provide the same field.

### 4. Structured Data (JSON-LD)

The framework emits every entry of the merged `PageSeo.jsonLDs` as a `<script type="application/ld+json">` in `<head>` (`cmsRoute.ts` head builder). Do **not** also render those same `jsonLDs` from a registered SEO section's component — it duplicates the structured data. Only render JSON-LD from a section that is neither the `page.seo` block nor in `registerSeoSections`, i.e. data that does not flow through `PageSeo`:

```typescript
// a body section NOT registered via registerSeoSections
export default function Seo({ jsonLDs }: Props) {
  if (!jsonLDs?.length) return null;
  return (
    <>
      {jsonLDs.map((jsonLD, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLD) }}
        />
      ))}
    </>
  );
}
```

### SEO Data Flow

```
CMS Page JSON
  ├─ page.sections[] → resolveDecoPage
  └─ page.seo → resolvePageSeoBlock (unwrap Lazy, ≤10 hops, resolve commerce loaders)
       │
       ▼
  runSectionLoadersWithSeo([...sections, seoSection])  — one batch (Promise.all)
       ├─ body sections → extractSeoFromSections() (secondary SEO source)
       └─ seoSection (SEOPDP transforms jsonLD → title/desc/etc.)
            → extractSeoFromProps() → apply titleTemplate/descriptionTemplate
            → PRIMARY PageSeo

  Merged PageSeo = { ...sectionSeo, ...pageSeo }
  → cmsRouteConfig head() → emits <title>, <meta>, <link>, OG, Twitter, robots,
    and PageSeo.jsonLDs as <script type="application/ld+json">
```

### Checklist for New Sites

1. **`__root.tsx`**: Include fallback `description`, `og:site_name`, `og:locale`
2. **`$.tsx` / `index.tsx`**: Pass `siteName`, `defaultTitle`, `defaultDescription` to `cmsRouteConfig` / `cmsHomeRouteConfig`
3. **`setup.ts`**: Register section loaders for any site SEO sections (e.g., SEOPDP) that appear in `page.seo` CMS blocks
4. **`setup.ts`**: Optionally call `registerSeoSections([...])` for sections in `page.sections` that contribute SEO
5. **`Seo.tsx`**: Don't re-render `PageSeo.jsonLDs` or meta tags — the framework emits both in `<head>`
6. **Device**: Use `matchMedia` for client-side, section loaders for server-side — NO hardcoded `Device.Provider`
7. **CMS audit**: Verify PDP `page.seo` blocks are NOT wrapped in `Lazy.tsx` with no inner section — the framework unwraps Lazy, but the inner section must exist
