# Loaders

On v8 a loader is a block function that returns data. There is no `loaders/` folder
convention, no `export const loader` next to a section, and no `(props, req, ctx)`
signature. A loader is a key in the block map like any other block.

```ts
// src/catalog.ts
import type { Product } from "@decocms/compat-v7/commerce/types";

export async function productBySlug({ slug }: { slug: string }): Promise<Product> {
  // call the platform client here (see the deco-apps skill)
}
```

```ts
// .deco/index.ts
export default {
  "product-by-slug": productBySlug,
  "product-card": (input: ProductCardProps) => <ProductCard {...input} />,
} satisfies Blocks;
```

`deco schema` puts a key in the loaders group when its return type is not an element,
a descriptor or a boolean. Use whatever data types fit the site. The schema.org-shaped
commerce types (`Product`, `ProductDetailsPage`, `ProductListingPage`, `BreadcrumbList`)
are in `@decocms/compat-v7/commerce/types`.

## How content plugs a loader into a section

A section prop with an object type accepts a plain value, or any block whose awaited
return type fits that type (TypeScript assignability). Studio offers those blocks as
choices for the field. In content:

```json
{
  "__resolveType": "product-card",
  "title": "Summer collection",
  "product": { "__resolveType": "product-by-slug", "slug": "summer-shirt" }
}
```

The resolver runs `product-by-slug` first and calls `product-card` with the `Product`
it returned. So type section props by the data they render, not by the loader that
fetches it. Any loader that returns a `Product` then fits.

## One run per distinct input, per client

A client (one per request) remembers each block function's result by its inputs:

- The same function with the same inputs runs once per client. Every place that asks
  gets the same promise, including calls made at the same time. Key order in the inputs
  does not matter.
- Different inputs run separately. A new client (the next request) runs again.
- Inputs that are not JSON (a function passed by code) are not remembered.

This is how a page shares one upstream call between the product section and its SEO
block (see [seo.md](./seo.md)). It also means results are shared. Never mutate a
loader's result. Copy it first.

This is per request only. Caching across requests is a job for the upstream client's
`fetch` (see the `deco-storefront-caching` skill), not for the block.

## Route params and other request data

A block function gets its inputs and nothing else. To read request-dependent data:

- **Route params** come from `matchRoute` in the page loader, which passes them as
  arguments to the top-level blocks it resolves (see [pages.md](./pages.md)). A nested
  loader does not get them. The section that received the param resolves the loader
  itself, through the current client:

  ```ts
  import { currentClient } from "@decocms/blocks";
  import type { Product } from "@decocms/compat-v7/commerce/types";

  export interface ProductDetailsProps {
    /** @ignore */
    slug?: string;
  }

  export async function productDetails({ slug }: ProductDetailsProps) {
    const client = currentClient(); // before any await
    const [product, error] = await client.resolve<Product>({
      __resolveType: "product-by-slug",
      slug,
    });
    if (error) throw error;
    return { component: "product-details", props: { product } } as const;
  }
  ```

  The call goes through the same client, so it shares the per-request memo with every
  other block asking for the same slug. `@ignore` keeps `slug` out of the Studio form,
  since editors do not fill it in. The page loader does.

- **Visitor, version and date**: `currentClient()` returns the client, with
  `client.visitor`, `client.version` and `client.date`. Call it at the start of the
  function, before any `await`. On runtimes without `AsyncLocalStorage` it is gone after
  the first `await`, and it throws outside a block function.

- **Cookies, headers, device**: these are not block inputs. The binding reads them in
  the page loader. Pass what a block needs as an argument, the same way as a param. A
  block that depends on the request varies the cached page, so check with the
  `deco-storefront-caching` skill first.

## Secrets and clients

Content holds no secrets, and there is no `secret` block. Create the upstream client in
code from the deploy platform's secrets, and close over it:

```ts
export const contactForm = (email: EmailClient) => async (props: ContactFormProps) => {
  await email.sendEmail({ from: "site@example.com", to: props.to, subject: props.subject, text: "" });
  return { to: props.to };
};

// .deco/index.ts: "contact-form": contactForm(resendClient),
```

Editors choose `to` and `subject`. The key never enters content. The
`@decocms/apps-*` clients and how to configure them are in the `deco-apps` skill.

## Fetching upstream

- Use the platform client from `@decocms/apps-*` when there is one.
- For an API of your own, wrap `fetch` with `createInstrumentedFetch` from
  `@decocms/blocks/fetch`:

  ```ts
  import { createInstrumentedFetch } from "@decocms/blocks/fetch";

  const reviewsFetch = createInstrumentedFetch({
    provider: "reviews",
    retry: { attempts: 2 },
    circuitBreaker: { failures: 5, cooldownMs: 30_000 },
  });
  await reviewsFetch(url, { operation: "reviews.list" });
  ```

  Each request is measured once (`http.client.request.duration`, labelled by
  `provider` and `operation`). Retries and the circuit breaker are off unless set. Only
  idempotent methods retry, never a `POST`.
- Ask for only what the section shows. Trim large upstream payloads in the loader
  before they reach a section. The `deco-storefront-performance` skill has the method.

## Errors

- A loader that throws fails as `BLOCK_FAILED`, with `path` pointing at the field, for
  example `["sections", 2, "product"]`, and the original error in `cause`.
- A failed nested block fails its parent. A page loader that resolves each section on
  its own (the TanStack examples) shows one failed section's error state and renders
  the others. One that resolves the whole page in one call (the Next.js examples)
  fails the whole page.
- Decide what "no data" means. For an optional section, return `undefined` (render
  nothing) or an empty list. Throw only when the page cannot make sense without it.
- On TanStack the page loader can mark the response with `DEGRADED_HEADER`
  (`x-deco-degraded`, from `@decocms/tanstack/server`) when a loader failed, so the page
  cache does not store it. See the `deco-storefront-caching` skill.

## Moving a v7 or Fresh loader

| v7 / Fresh | v8 |
|---|---|
| `export const loader = (props, req, ctx) => ...` in the section | A loader block, plugged into a section prop in content; or the section resolves it through `currentClient()` |
| `loaders/x.ts` default export | A block map key pointing at the function |
| `ctx.invoke.<app>.loaders.x(...)` | Call the platform client from `@decocms/apps-*` in code, or `currentClient().resolve({ __resolveType: "x", ... })` for another block |
| `requestToParam` in content | Params from `matchRoute`, passed by the page loader |
| `req.headers`, cookies | Read by the binding and passed as arguments |
| Cached loaders, `cache: "stale-while-revalidate"` | No block-level cache. Cache in the upstream client's `fetch` |

A migrated site can keep v7's `(props, req)` section loaders through
`runSectionLoaders` in `@decocms/compat-v7/sections`. That path is for migrations
only. See the `deco-v7-to-v8-migration` skill. Write new loaders as block functions.
