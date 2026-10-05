# SEO architecture — `page.seo`, registered SEO sections, JSON-LD

SEO in @decocms/tanstack works across four layers:

### 1. CMS `page.seo` Block (primary source)

CMS page JSONs have a top-level `seo` field separate from `sections`. This is the **primary** SEO data source, processed by `resolvePageSeoBlock()` in `resolve.ts`.

**Key behavior: Lazy/Deferred wrappers are always unwrapped.** SEO metadata must be in the initial SSR HTML for crawlers. The original Fresh/Deno framework did NOT do this, causing PDP pages to have zero SSR SEO when `page.seo` was wrapped in `Lazy.tsx`. We fix this by design.

Resolution pipeline:
1. Unwrap Lazy/Deferred (unlimited depth)
2. Follow named block references
3. Evaluate multivariate flags
4. Resolve all nested `__resolveType` (commerce loaders for product data)
5. Return `ResolvedSection` in `DecoPageResult.seoSection`

In `cmsRoute.ts`, the seoSection is enriched by its section loader, then:
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

These sections must have a **section loader** that returns props with SEO fields:

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

### 4. Structured Data (section component)

JSON-LD (`<script type="application/ld+json">`) is rendered by the section component itself — NOT in `<head>`. The section receives `jsonLDs` in its props and renders them:

```typescript
// src/components/ui/Seo.tsx
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
  ├─ page.sections[] → resolveDecoPage → runSectionLoaders
  │    → extractSeoFromSections() (secondary SEO source)
  │
  └─ page.seo → resolvePageSeoBlock (unwrap Lazy, resolve commerce loaders)
       → runSingleSectionLoader (SEOPDP transforms jsonLD → title/desc/etc.)
       → extractSeoFromProps() → apply titleTemplate/descriptionTemplate
       → PRIMARY PageSeo

  Merged PageSeo = { ...sectionSeo, ...pageSeo }
  → cmsRouteConfig head() → emits <title>, <meta>, <link>, OG, Twitter, robots
  → Section component renders JSON-LD in page body
```

### Checklist for New Sites

1. **`__root.tsx`**: Include fallback `description`, `og:site_name`, `og:locale`
2. **`$.tsx` / `index.tsx`**: Pass `siteName`, `defaultTitle`, `defaultDescription` to `cmsRouteConfig` / `cmsHomeRouteConfig`
3. **`setup.ts`**: Register section loaders for any site SEO sections (e.g., SEOPDP) that appear in `page.seo` CMS blocks
4. **`setup.ts`**: Optionally call `registerSeoSections([...])` for sections in `page.sections` that contribute SEO
5. **`Seo.tsx`**: Component renders JSON-LD (NOT meta tags — framework handles those)
6. **Device**: Use `matchMedia` for client-side, section loaders for server-side — NO hardcoded `Device.Provider`
7. **CMS audit**: Verify PDP `page.seo` blocks are NOT wrapped in `Lazy.tsx` with no inner section — the framework unwraps Lazy, but the inner section must exist
