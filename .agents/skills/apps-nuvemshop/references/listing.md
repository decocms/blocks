# PLP: facets, sort, pagination, related products

The API has no facets and only three sorts, but the Nuvemshop core (the theme)
has both. `utils/listing.ts` (`applyListing`) reproduces the theme in memory over
a window of ≤200 products (`LISTING_WINDOW`) — verified equal to the theme's
counts and order on live search/category cases. Past 200 products per
category/search it is wrong; switch to native API facets when they exist.

## URL contract (same as the theme, so old links keep working)

- Filters: `?<Attribute>=<value>`, several values OR-ed with `|`
  (`?Cor=Vermelho|Preto`); AND across attributes. Repeated params are NOT the
  theme's format (it keeps only the last). Price: `min_price`/`max_price`.
- Sort: `?sort_by=` with the theme's values (`alpha-*`, `created-*`,
  `best-selling`, `price-*`) plus our `discount-descending`. Only `best-selling`
  is delegated to the API; the rest sort in memory with newest-first ties.
- Default category order: the API returns oldest-first and doesn't expose the
  category's configured sort, so `defaultSort` (block prop, default
  `created-descending`) applies; `?sort_by=user` (manual order) falls back to it.
- Search keeps API relevance and drops `best-selling`.
- Facet counts ignore their own attribute's selection; zero-count values are hidden.

## Paths

`/produtos/<handle>` (`?variant=<id>` selects a variant) and nested
categories `/<parent>/<child>`, no trailing slash. The PLP resolves the category
from the last path segment.

## Related products

`relatedProducts` follows the theme's fallback rule: same category, without the
product, in-stock first, refilled with out-of-stock, max 8. No shuffle (keeps it
cacheable). The theme first prefers ids from a related-products app metafield,
which the API doesn't expose.

## Colors

The theme paints swatches from a hex the core attaches to palette colors
(`custom_data`); the API returns only the name. Color → hex is site config (a
CMS loader); free-text colors ("Vermelho e Preto") never had a hex in the theme
either — it shows "+N" / "N cores".
