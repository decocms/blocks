# SEO and JSON-LD

A page's title, description, canonical and structured data come from its `seo` field.
It is a block like any other, resolved on the server before the response is sent, so
crawlers and people get the same HTML. There is no deferred SEO section, no HTMX
head-support, and no separate bot render on v8.

## The `seo` field

The built-in `page` has an optional `seo` field. Studio offers any block that returns:

- `Seo` from `@decocms/blocks`: `{ title: string; description: string }`, or
- an object whose fields are all optional, with a string `title` or `description`
  (a richer type of the site's own, such as a `PageSeo` with `canonical` and `jsonLDs`).

A loader whose result has required fields (a post with a required `title` and
`excerpt`) is content, not SEO, and is not offered.

The smallest setup is the one in the examples: a block that returns its input.

```ts
export default {
  seo: (input: Seo) => input,
  // ...sections
} satisfies Blocks;
```

The page loader resolves `page.seo` (after starting every section, so SEO does not
delay them), and the route turns it into tags: `head()` on TanStack Start,
`generateMetadata` on Next.js. Without `seo`, the root layout's defaults apply. The
head wiring is in the `deco-tanstack-site` and `deco-nextjs-site` skills.

## Feed SEO from the same loader as the page

On a product or listing page, the title, description, canonical and JSON-LD come from
the same product or listing the page shows. Do not fetch it twice, and do not type it
by hand into content.

Write an SEO block that takes the same param as the section and resolves the same
loader through the current client:

```ts
import { currentClient } from "@decocms/blocks";
import type { Product } from "@decocms/compat-v7/commerce/types";

export interface PageSeo {
  title?: string;
  description?: string;
  canonical?: string;
  noIndexing?: boolean;
  jsonLDs?: Record<string, unknown>[];
}

export interface ProductSeoProps {
  /** @ignore */
  slug?: string;
  /** @title Title template, %s is the product name */
  titleTemplate?: string;
}

export async function productSeo({ slug, titleTemplate = "%s" }: ProductSeoProps): Promise<PageSeo> {
  const client = currentClient(); // before any await
  const [product, error] = await client.resolve<Product>({ __resolveType: "product-by-slug", slug });
  if (error || !product) return { noIndexing: true };
  return {
    title: titleTemplate.replace("%s", product.name ?? ""),
    description: product.description,
    jsonLDs: [{ "@context": "https://schema.org", ...product }],
  };
}
```

```json
"seo": { "__resolveType": "product-seo", "titleTemplate": "%s | Store" }
```

The page loader passes `slug` to `seo` the same way it passes it to the sections (see
[pages.md](./pages.md)). Both resolve `product-by-slug` with the same inputs on the
same client, so the upstream call runs once and both get the same object (see
[loaders.md](./loaders.md)). If they pass different inputs (one adds a field the other
does not), they make two calls. Keep the loader inputs identical.

For a listing page, do the same with the listing loader. `ProductListingPage` and
`ProductDetailsPage` in `@decocms/compat-v7/commerce/types` carry an optional `seo`
(`title`, `description`, `canonical`, `noIndexing`) when the platform provides one, and
`canonicalFromBreadcrumblist` in `@decocms/compat-v7/commerce/utils/canonical` picks the
last breadcrumb's URL.

## JSON-LD

- Emit each structured-data object once, as `<script type="application/ld+json">`. If
  the route emits `jsonLDs` from `seo`, no section should render the same object again.
- Escape `<` in the serialized JSON (`JSON.stringify(x).replace(/</g, "\\u003c")`), so
  a product description with `</script>` cannot end the tag.
- Product JSON-LD from a platform `Product` is large. Trim it to what rich results use
  (name, image, description, sku, brand, offers with price, currency and availability,
  aggregate rating) before you serialize it.
- A block that renders nothing and only feeds data (fonts, a JSON-LD helper) can take
  its data as `Lazy<T>`, so nothing is fetched when it is not used. See
  [lazy-blocks.md](./lazy-blocks.md).

## Checklist for a site

1. The root layout sets a default title, description, `og:site_name` and `lang`.
2. Every page has `seo`, or relies on the defaults on purpose.
3. Product and listing pages use an SEO block that resolves the same loader, with the
   same inputs, as the main section.
4. Empty listing pages and not-found products set `noIndexing` (or the route returns
   404). Drafts are already sent with `X-Robots-Tag: noindex, nofollow` by the
   bindings' draft response headers.
5. A canonical URL is set on pages that can be reached with tracking or filter params.
6. JSON-LD appears once per object.
7. Check one page of each type with `curl -s <url> | grep -E "<title|og:|ld\+json|canonical"`.
   v8 sends the same HTML to bots and people, so one request is enough.

Coverage audits, `robots.txt` and sitemaps are not part of this skill.
