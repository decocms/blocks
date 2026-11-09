# Commerce types and helpers (`@decocms/compat-v7/commerce`)

The v8 clients return each platform's own types. The shared schema.org model that v7
sections were written against (`Product`, `Offer`, `ProductListingPage`…) lives in
`@decocms/compat-v7`, under `/commerce`. It is v7's `@decocms/apps-commerce`, file for
file: replace `@decocms/apps-commerce/` with `@decocms/compat-v7/commerce/` in an import
and nothing else changes. None of it uses React.

The site's converters (vendored from v7, see [`vendored-loaders.md`](./vendored-loaders.md))
turn the client's response into these types. Sections, JSON-LD and analytics read them.

## Entry points

| Import | What is there |
|---|---|
| `@decocms/compat-v7/commerce/types` (also `/commerce`) | The schema.org types and the analytics events; re-exports the cart types |
| `@decocms/compat-v7/commerce/types/cart` | `CartSection`, `SECTIONS_MINIMAL`, `SECTIONS_DRAWER`, `SECTIONS_FULL`, `defaultSectionsFor`, cart projections, `MinicartItem` |
| `/commerce/sdk/formatPrice` | `formatPrice(price, currency = "BRL", locale = "pt-BR")`, `formatPriceRange` |
| `/commerce/sdk/useOffer` | `useOffer(aggregateOffer)`, `bestInstallment` |
| `/commerce/sdk/useVariantPossibilities` | `useVariantPossibilities` |
| `/commerce/sdk/url` | `relative(link, { stripSearchParams? })` |
| `/commerce/sdk/analytics` | `mapProductToAnalyticsItem`, `mapProductToAnalyticsItemList`, category mappers |
| `/commerce/utils/productToAnalyticsItem` | v7's other `mapProductToAnalyticsItem` (`{ product, breadcrumbList, price, listPrice, … }`) |
| `/commerce/utils/canonical` | `canonicalFromBreadcrumblist` |
| `/commerce/utils/constants` | `DEFAULT_IMAGE` |
| `/commerce/utils/filters` | `parseRange`, `formatRange` |
| `/commerce/utils/stateByZip` | `getStateFromZip` (default export) |

`useOffer` and `useVariantPossibilities` are plain functions despite the names. They are
safe in Server Components and loaders.

## The model

```
Product (a SKU)              productID, sku, name, offers?: AggregateOffer,
                             isVariantOf?: ProductGroup, additionalProperty?, image?
ProductGroup (the product)   productGroupID, hasVariant: ProductLeaf[], model?
AggregateOffer               highPrice, lowPrice, offerCount, offers: Offer[]
Offer                        price, availability, inventoryLevel, priceSpecification[],
                             seller?, sellerName?, priceValidUntil?, teasers?, giftSkuIds?
ProductDetailsPage           breadcrumbList, product, seo?
ProductListingPage           breadcrumb, filters, products, pageInfo, sortOptions, seo?
```

`ProductLeaf` is `Product` without `isVariantOf`, which stops the variant tree from
recursing. Filters are `FilterToggle` (`values`, `quantity`) or `FilterRange`
(`values: { min, max }`). Navigation is `SiteNavigationElement` with `children`.

`availability` is a schema.org URL (`"https://schema.org/InStock"`,
`"https://schema.org/OutOfStock"`, …). Price types are URLs too:
`priceType` is `ListPrice`, `SalePrice`, `SRP`, …; an installment is a
`UnitPriceSpecification` with `priceComponentType: "https://schema.org/Installment"`,
`billingDuration` (count) and `billingIncrement` (value per installment).

## Rules a converter must keep

Sections and helpers assume these. A converter that breaks one renders wrong prices
or breaks the cart, without a type error.

1. **`Offer.seller` is the seller ID** (`"1"`), never the display name. The name goes
   in `sellerName`. Add-to-cart sends `seller` to the platform.
2. **Prices are decimals** (`199.9`), not cents.
3. **`Product.productID` and `Product.sku` are the SKU ID**; `ProductGroup.productGroupID`
   is the product ID. Cart calls use the SKU.
4. **Put the offer to show first.** `useOffer` reads `offers[0]` only: its price, the
   `ListPrice` spec as `listPrice`, and the best installment (lowest total, then most
   installments).
5. **`category` uses `>` between levels** (`"Furniture > Chairs"`). The analytics
   mappers split on `>`.
6. **Breadcrumb items are `ListItem<string>`** with a 1-based `position` and the URL in
   `item`. `canonicalFromBreadcrumblist` returns the `item` with the highest position.
7. **Images are `ImageObject[]`** with `url` and `alternateName`.

## VTEX to schema.org, field by field

The v7 VTEX converter mapped the client's response like this. Use it to check or
write a converter. VTEX field names are those of `@decocms/apps-vtex`'s response
types.

**Product (one SKU)**

| VTEX | schema.org |
|---|---|
| `item.itemId` | `productID`, `sku` |
| `item.name` | `name` |
| `item.complementName` | `alternateName` |
| `item.ean` | `gtin` |
| `product.description` | `description` |
| `product.brand`, `brandId`, `brandImageUrl` | `brand.name`, `brand["@id"]`, `brand.logo` |
| `product.releaseDate` | `releaseDate` |
| `product.categories[0]` | `category` (split on `/`, joined with ` > `) |
| `product.productId` | `inProductGroupWithID` |
| `item.images[]`: `imageUrl`, `imageText`, `imageLabel` | `image[]`: `url`, `alternateName`, `name` |

**ProductGroup (`isVariantOf`)**: `productId` → `productGroupID`; each of `product.items`
→ `hasVariant` (converted without `isVariantOf`); `/{linkText}/p` → `url`;
`productName` → `name`; `productReference` → `model`.

**Offer (one seller of the SKU)**

| VTEX `sellers[]` | schema.org |
|---|---|
| `sellerId` | `seller` |
| `sellerName` | `sellerName` |
| `sellerDefault: true` | `identifier: "default"` |
| `commertialOffer.spotPrice ?? Price` | `price` |
| `commertialOffer.PriceValidUntil` | `priceValidUntil` |
| `commertialOffer.AvailableQuantity` | `inventoryLevel.value`; `> 0` → `InStock`, else `OutOfStock` |
| `commertialOffer.GiftSkuIds`, `teasers` | `giftSkuIds`, `teasers` |
| `ListPrice` / `Price` / `PriceWithoutDiscount` | `priceSpecification` with `ListPrice` / `SalePrice` / `SRP` |
| `Installments[]`: `NumberOfInstallments`, `Value`, `TotalValuePlusInterestRate`, `PaymentSystemName`, `Name` | installment specs: `billingDuration`, `billingIncrement`, `price`, `name`, `description` |

**Breadcrumb**: each segment of `categories[0]` is a `ListItem` with its position and
URL, then the product name last, at `/{linkText}/p`.

**Legacy or Intelligent Search?** A product with `origin === "intelligent-search"`
came from `vtex.search.*`; otherwise it came from the legacy Catalog
(`vtex.catalog.products`), whose items have a different shape (`LegacyItem`).

`additionalProperty` collects SKU variations, categories, clusters
(`productClusters`), reference IDs, `estimatedDateArrival` and `modalType`.

## Cart sections

`CartSection` names VTEX's orderForm sections. Three presets:

- `SECTIONS_MINIMAL`: `items`, `totalizers`, `messages`. Enough after add-to-cart.
- `SECTIONS_DRAWER`: what a minicart renders (adds marketing, sellers, rates, shipping…).
- `SECTIONS_FULL`: all fifteen, v7's old default.

Pass one as `sections` to `vtex.checkout.orderForm` ([`vtex.md`](./vtex.md)). A smaller
set means a smaller payload from VTEX and less work to serialize.
