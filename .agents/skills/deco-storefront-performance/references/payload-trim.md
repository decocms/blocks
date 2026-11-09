# Payload trim: smaller Product graphs before they reach the HTML

Load when: a listing page's HTML is several MB; a `/_serverFn/` navigation response is
huge; the HTML holds thousands of `UnitPriceSpecification` entries; JSON-LD is large.

## Why the HTML is heavy

On TanStack Start, what a block returns becomes route loader data. It is serialised into
the HTML for hydration, and again into the `/_serverFn/` response of every client-side
navigation. On Next.js, props passed to client components go into the RSC payload. Every
field the block returns is shipped, whether a component reads it or not.

A VTEX `Product` (schema.org shape, `@decocms/compat-v7/commerce/types`) is mostly ballast
for a product card:

- `offers.offers[].priceSpecification`: one `UnitPriceSpecification` per installment plan,
  often ~30 per offer.
- `isSimilarTo[]`: up to ~10 full `Product` graphs, for colour swatches.
- `additionalProperty`: dozens of entries.
- `image[]`: every image of the product.

Measured on a listing page of a VTEX store after trimming:

| | before | after |
|---|---|---|
| Raw HTML | 28.7 MB | 2.89 MB (−89.9%) |
| `UnitPriceSpecification` count | 63,744 | 585 (−99.1%) |
| `PropertyValue` count | 82,877 | 11,577 (−86.0%) |
| `ImageObject` count | 13,497 | 1,921 (−85.8%) |

## Rule: check every reader, then trim what nobody reads

List the components that read the product on that page and what each reads. A typical
listing:

| Reader | Reads | Keep |
|---|---|---|
| `useOffer` (`@decocms/compat-v7/commerce/sdk/useOffer`) | `offers.offers[0]`: price, availability, seller, the `ListPrice` spec and the best `Installment` | `ListPrice` + best `Installment` |
| Product card | name, url, `productID`, first image, some `additionalProperty`, `isVariantOf.hasVariant` for sizes | the card's fields; `hasVariant` |
| Colour swatches | on each `isSimilarTo[]`: availability, thumbnails, the colour property, `isVariantOf.productGroupID` | only those |
| Quick-buy size selector | each `hasVariant[]` offer: availability and its price specs | slimmed specs, not dropped |
| Product page | the whole graph | **do not trim** |

Your store's components may read more. Grep them before you remove a field.

## The trim functions

```ts
// src/sdk/productPayload.ts
import type {
  AggregateOffer,
  Product,
  ProductListingPage,
  UnitPriceSpecification,
} from "@decocms/compat-v7/commerce/types";
import { bestInstallment } from "@decocms/compat-v7/commerce/sdk/useOffer";

const LIST_PRICE = "https://schema.org/ListPrice";
const SWATCH_PROPS = new Set(["Color"]); // your store's colour property names

/** ListPrice plus the installment useOffer would pick, nothing else. */
const slimSpecs = (specs: UnitPriceSpecification[] = []): UnitPriceSpecification[] => {
  const list = specs.find((s) => s.priceType === LIST_PRICE);
  const best = specs.reduce(bestInstallment, null);
  return [list, best].filter((s): s is UnitPriceSpecification => !!s);
};

const slimOffers = (agg: AggregateOffer | undefined, dropSpecs = false) => {
  const first = agg?.offers?.[0];
  if (!agg || !first) return agg;
  return { ...agg, offers: [{ ...first, priceSpecification: dropSpecs ? [] : slimSpecs(first.priceSpecification) }] };
};

const isThumb = (img: { alternateName?: string; url?: string }) =>
  /thumb/i.test(img.alternateName ?? "") || /thumb/i.test(img.url ?? "");

/** isSimilarTo[]: what a swatch reads. */
const slimSimilar = (p: Product): Product => {
  const thumbs = p.image?.filter(isThumb);
  return {
    ...p,
    image: thumbs?.length ? thumbs : p.image?.slice(0, 1),
    additionalProperty: p.additionalProperty?.filter((x) => SWATCH_PROPS.has(x.name ?? "")),
    offers: slimOffers(p.offers, true), // swatches read availability only
    isVariantOf: p.isVariantOf && ({ productGroupID: p.isVariantOf.productGroupID } as Product["isVariantOf"]),
    isSimilarTo: undefined, // never nest: a later change would grow it geometrically
  };
};

export const trimProductForCard = (p: Product): Product => ({
  ...p,
  offers: slimOffers(p.offers),
  isSimilarTo: p.isSimilarTo?.map(slimSimilar),
  isVariantOf: p.isVariantOf && {
    ...p.isVariantOf,
    hasVariant: p.isVariantOf.hasVariant?.map((v) => ({ ...v, offers: slimOffers(v.offers) })),
  },
});

export const trimListingPage = (page: ProductListingPage | null) =>
  page?.products?.length ? { ...page, products: page.products.map(trimProductForCard) } : page;
```

`bestInstallment` is the reducer `useOffer` uses, so the card shows the same installment
after the trim as before. The functions build new objects and never mutate their input.
That matters in v8: a block's result is shared by every place in the request that named
the same block with the same inputs, and the product page may be one of them.

Adapt the swatch filter (`isThumb`, `SWATCH_PROPS`) to what your store's components read.
Thumbnail naming differs between stores.

## Where to apply it

In the block function or vendored loader that returns the products for a card list, just
before it returns:

```ts
export async function productListingPage(props: Props) {
  const page = await loadListing(props); // your mapping to schema.org
  return trimListingPage(page);
}
```

- Every path that renders cards must trim: the first render, "load more", infinite scroll,
  and any server function that returns products. A path you forget brings back the full
  payload and breaks nothing visibly.
- Keep the product page on the full graph. Use a different block (or a prop) for cards.
- Trimming does not shrink an upstream cache that stores the raw VTEX response. It shrinks
  the HTML, the `/_serverFn/` responses, and a page cache that stores either.

## JSON-LD on listing pages

Structured data is serialised too. A listing's JSON-LD is an `ItemList` of `ListItem` with
`url` and `position`; the full `Product` belongs on the product page. One store emitted a
`"Products"` type (not in schema.org, so no crawler read it) at 2.75 MB per listing page.
The `ItemList` form was 6,198 bytes. Feed the SEO block from the same loader block as the
page (so the client runs it once) and map to the small shape there.

## Personal data in the HTML

Never embed shopper data (cart, postal code, name, session) in server-rendered HTML or
loader data of a page that can be cached. One cached copy serves it to the next visitor.
Load it in a client component after hydration. Cache rules are in `deco-storefront-caching`.

## Verify

```bash
URL=https://www.example.com/some-listing
curl -s "$URL" | wc -c                                      # raw HTML bytes
curl -s --compressed -o /dev/null -w '%{size_download}\n' "$URL"  # bytes on the wire
curl -s "$URL" | grep -o UnitPriceSpecification | wc -l     # bloat marker, should fall ~99%
```

Do the same for the navigation response: open the page, click to another listing, and
read the `/_serverFn/` response size in DevTools.

Visual checks after the trim:

- [ ] Cards show price, list price and installment text as before
- [ ] Colour swatches render and link to the right products
- [ ] The size selector disables out-of-stock sizes
- [ ] "Load more" and infinite scroll render trimmed cards correctly
- [ ] The product page is unchanged
