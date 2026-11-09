# N+1 calls in block functions

Load when: SSR time grows with the number of products on the page; the same upstream
operation shows up dozens of times for one page; VTEX answers 429.

In v8 the loaders a site uses are its own code: the migration vendors v7's app loaders
into the site, and new ones call a thin client (`createVtexClient` from
`@decocms/apps-vtex`, and the other `@decocms/apps-*`). Nothing in the framework batches
or caches those calls. An N+1 is in your code, and so is the fix.

## The pattern

```ts
// RED FLAG: one upstream call per product
export async function productShelf(props: { products: Product[] }) {
  const products = await Promise.all(
    props.products.map(async (p) => ({ ...p, specs: await fetchSpecs(p.productID) })),
  );
  return { component: "shelf", props: { products } };
}
```

A 24-product shelf is 24 extra round trips before the section can render. At ~370 ms
per VTEX call that is seconds even in parallel, because VTEX rate-limits bursts and
serialises the rest. A home page with several shelves multiplies it.

| Pattern | Severity | Example |
|---|---|---|
| Upstream call inside `.map()` | Critical | `products.map((p) => fetchSpecs(p.id))` |
| Data already in the product | High | refetching specs or SKUs the search returned |
| Per-item call where a batch exists | High | one Master Data search per id |
| `await` inside a `for` loop | Medium | `for (const p of products) await fetch(p)` |
| Unbounded `Promise.all` | Medium | `Promise.all(hundredItems.map(fetch))` |

## Fix order

**1. Is the data already there?** Most N+1s fetch what the search already returned. An
Intelligent Search product carries its specification groups and its SKUs, and the
schema.org mapping in the site's loaders puts them on the product
(`@decocms/compat-v7/commerce/types`):

| Per-item VTEX call | Already on the product as |
|---|---|
| `/api/catalog_system/pvt/products/{id}/Specification` | `product.isVariantOf.additionalProperty` |
| `/api/catalog_system/pub/products/variations/{id}` | `product.isVariantOf.hasVariant` |

Delete the call and read the field. If components expect the old shape (numeric spec ids,
the Catalog API's `{ Id, Name, Value[] }`), write a small adapter from
`additionalProperty` and keep it next to the components. Get the exact spec names from a
real search response first: some stores have names with double spaces or trailing
blanks.

**2. Is it per page, not per product?** Related products, "buy together" and cross-selling
are one call for the page, not one per card. `createVtexClient(...).catalog.crossSelling`
takes one product id. Call it once for the page's product.

**3. Can it batch?** Some APIs take many ids in one call:

- Price simulation: `vtex.checkout.simulation({ items: [...] })` takes every SKU of the
  shelf in one `items` array. Build the list, call once, then map results back by id.
- Master Data: `vtex.masterdata.search(entity, { where: "id=1 OR id=2 OR id=3" })`.
- Intelligent Search: one `vtex.search.products` call with a facet or query that selects
  the set (a collection, a list of ids your store supports) instead of one search per item.

**4. Genuinely per item?** Then bound it. Cap the fan-out, keep the call off the critical
path (a `Lazy<T>` prop, or a client component that fetches when visible), and cache it
upstream (see `deco-storefront-caching`). Never `Promise.all` over a list you do not
control the length of.

## The N+1 that has no loop

Two sections each fetch the same product to derive the same facet, then run the same
faceted search. Inside each block it looks like one call. Across the page it is four.
That is a duplicate-call problem, not a loop. See [`request-dedupe.md`](./request-dedupe.md).

Do not "fix" it by switching to a different upstream API. On one store the tempting swap
(legacy Catalog to Intelligent Search) changed the shape of `product.category`, which the
facet was built from, so the shelf silently showed other products. Remove the duplicate
call you have.

## Find them

```bash
# upstream calls inside map/forEach/for in the site's code
grep -rnE "\.map\(\s*async|forEach\(\s*async" src/ .deco/index.ts
grep -rnE "for \(.*\) *\{" -A3 src/ | grep -n "await"
# who calls the thin clients
grep -rnE "\.(search|catalog|checkout|masterdata|io)\.[a-zA-Z]+\(" src/
```

## Verify

Count calls, do not eyeball the page. The method is in
[`request-dedupe.md`](./request-dedupe.md#count-the-calls): one log line per upstream
call in dev, or the `http.client.request.duration` metric in production. After the fix,
one page load shows one line per operation, not one per product. Then confirm the end
result with the `curl` timing in `SKILL.md`, on the same URL, cold and warm.

## Checklist

- [ ] No upstream call inside `.map(async` in a block function
- [ ] Specs and SKUs read from the product, not refetched
- [ ] Cross-selling called once per page
- [ ] Simulation batched into one `items` array
- [ ] Every `Promise.all` over external data has a bounded input
- [ ] Calls counted before and after
