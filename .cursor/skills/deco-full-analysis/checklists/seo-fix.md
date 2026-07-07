# SEO Fix Checklist

10 learnings from real Deco sites. Check these during analysis.

> **Correction to an earlier version of this note**: `.deco/blocks/*.json` is still a
> real, current, on-disk convention on most real sites (confirmed: faststore-fila,
> casaevideo-tanstack, bagaggio-tanstack) — that's where page/section CMS content,
> including any `seo` block, actually lives locally, loaded via `@decocms/cli`'s
> `generate-blocks.ts`/`sync-blocks-to-kv.ts` or `@decocms/runtime/cms`'s
> `loadDecofileDirectory`. A smaller number of sites (minimal fixtures like
> `examples/tanstack-smoke`) instead pass an inline `blocks` object straight to
> `createSiteSetup({ blocks: {...} })` in `src/setup.ts` — check which pattern a given
> site uses before auditing. Either way, a fast-deploy site's *live production* content
> can additionally live only in Cloudflare KV (not checked into the repo at all — see
> `packages/admin/src/admin/decofile.ts`'s `handleDecofileRead`), so audit commands
> below that grep local files should be treated as "nothing wrong in what's checked
> in," not "verified against production."

## Structured Data (JSON-LD)

### 1. Safe JSON-LD Embedding
**Check**: Is JSON-LD properly escaped?

```typescript
// Bad: Vulnerable to injection
<script type="application/ld+json">
  {JSON.stringify(product)}
</script>

// Good: Escape < character
<script type="application/ld+json">
  {JSON.stringify(product).replace(/</g, '\\u003c')}
</script>
```

This prevents:
- Google Search Console errors
- XSS injection attacks

### 2. Price Formatting
**Check**: Are prices formatted to exactly 2 decimals?

```typescript
// Bad: Variable decimals
price: product.price // 99.9 or 99

// Good: Always 2 decimals
price: product.price.toFixed(2) // "99.90"
```

Google Merchant Center requires exactly 2 decimal places.

### 3. GTIN/EAN Validation
**Check**: Are GTIN codes validated before including?

```typescript
function isValidGTIN(gtin: string): boolean {
  // Implement checksum validation
  const digits = gtin.replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  // ... checksum logic
}

// Only include if valid
gtin: isValidGTIN(product.gtin) ? product.gtin : undefined
```

Invalid GTINs cause Merchant Center penalties.

### 4. FAQ Schema
**Check**: Do FAQ sections inject JSON-LD?

```typescript
const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": questions.map(q => ({
    "@type": "Question",
    "name": q.question,
    "acceptedAnswer": {
      "@type": "Answer",
      "text": q.answer
    }
  }))
};
```

## Meta Tags

### 5. Duplicate Meta Descriptions
**Check**: Is only one SEO section active per page?

```bash
# Find pages with multiple SEO blocks in whatever local CMS content exists
# (dev fixtures in src/setup.ts — production content lives in the remote decofile)
grep -c '"__resolveType":.*Seo' src/setup.ts
```

Multiple SEO sections = duplicate meta tags = SEO penalty.

### 6. SEO Block on Every Page
**Check**: Does every page block have an `seo` section?

```json
{
  "name": "Home",
  "sections": [...],
  "seo": {
    "__resolveType": "website/sections/Seo/Seo.tsx",
    "title": "...",
    "description": "..."
  }
}
```

## Canonical URLs

### 7. Strip Non-SEO Parameters
**Check**: Do canonical URLs include tracking params?

```typescript
// Good: Strip UTMs and tracking
function getCanonicalUrl(url: URL): string {
  const canonical = new URL(url);
  ['utm_source', 'utm_medium', 'utm_campaign', 'gclid', 'fbclid']
    .forEach(param => canonical.searchParams.delete(param));
  return canonical.toString();
}
```

### 8. Noindex for Filtered PLPs
**Check**: Are PLPs with filters indexed?

```typescript
// Add noindex for filtered/sorted pages
const hasFilters = url.searchParams.has('filter') || 
                   url.searchParams.has('sort');

<meta name="robots" content={hasFilters ? "noindex,follow" : "index,follow"} />
```

## Semantic HTML

### 9. Single H1 Per Page
**Check**: Is the primary title wrapped in `<h1>`?

```tsx
// PDP: Product name should be h1
<h1>{product.name}</h1>

// PLP: Category name should be h1
<h1>{category.name}</h1>

// Search: Search term should be h1
<h1>Results for "{query}"</h1>
```

### 10. Language Attribute
**Check**: Is the `lang` attribute correct?

There's no framework config file for this anymore. Both `@decocms/next`'s
`DecoRootLayout` (`packages/next/src/DecoRootLayout.tsx`) and `@decocms/tanstack`'s
`DecoRootLayout` (`packages/tanstack/src/hooks/DecoRootLayout.tsx`) render
`<html lang={lang} ...>` from a `lang` prop that **defaults to `"en"`** if the site
doesn't pass one. Check that the site explicitly passes the right value where it
renders `<DecoRootLayout>` (its root layout / `__root.tsx`):

```tsx
<DecoRootLayout lang="pt-BR" /* ... */>
```

A site that never sets `lang` is silently serving `lang="en"` regardless of actual
content language.

## Quick Audit Commands

```bash
# Check local CMS fixture content in setup.ts for pages missing an `seo` field
# (only covers dev fixtures checked into the repo — production page content lives
# in the remote decofile behind @decocms/admin and isn't visible to this grep)
grep -n '"seo"' src/setup.ts

# Check for unescaped JSON-LD in section components
grep -rn "JSON.stringify" src/sections/ | grep -v "replace"
```

## SEO Audit Table

Add this to AGENTS.md:

```markdown
## SEO Health

| Check | Status |
|-------|--------|
| All pages have SEO section | ✅ |
| JSON-LD properly escaped | ✅ |
| Prices have 2 decimals | ❌ Check ProductCard |
| GTIN validation | ⚠️ Not implemented |
| Canonical URLs clean | ✅ |
| Filtered PLPs noindex | ❌ Missing |
```
