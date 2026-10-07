# Storefront API — what it gives and what it doesn't

OpenAPI 0.5.0, `v2026-11`. Routes: `GET /products` (browse), `GET /search/products`,
`GET /products/{id|handle}`, `GET /categories[/{id|handle}]`,
`POST /shipping-options`, `POST /checkouts`. That's all — no cart, customer,
facets, promotions, installments or sitemap.

## Fields

The default selection is `id,name,handle`. `client.ts` adds, per route:
- products: `PRODUCT_FIELDS` (images, variants, attributes, categories, brand,
  tags, seo_*, free_shipping, video_url, created_at). `cost` is never requested.
- categories: `CATEGORY_FIELDS` (adds `parent`, `subcategories`, seo_*).

An invalid field answers `400 invalid_fields` listing the bad ones — that's
how the valid set was discovered. `custom_fields` is store-gated
(`custom_fields_unavailable`).

## Prices and stock (per variant, decimal strings)

- sale price = `promotional_price ?? price`; list price = `max(compare_at_price, price)`
  (`compare_at_price` equals `price` when there's no discount).
- `stock: null` means unlimited; available = `!stock_management || stock == null || stock > 0`.
- `values[i]` pairs with the product's `attributes[i]` (e.g. `["P","Azul"]` ↔ `["Tamanho","Cor"]`).
- No currency in the payload — it's config (`currency`, default BRL).

## Query rules

- `ids`/`handles` (≤30) can't be combined with `sort_by`; results keep request order.
- `sort_by` accepts only `best-selling | price-ascending | price-descending` (else 400).
- `category_id` includes subcategories. Unknown params are silently ignored.
- `/search/products` returns only the first page (≤200), no `sort_by`.
- Handles are per language; there's no `lang` param.

## Auth and limits

- Tokenless: 120 req/min per store + client IP. From a Worker every buyer shares
  egress IPs, so production should use a token.
- Storefront token (from Nuvemshop's account team): 1,200/min per store;
  `X-LinkedStore-Buyer-IP` gives each buyer their own 120 bucket. The client sends
  it only on POSTs, only with a token.
- A custom-app token (Configurações → Aplicativos sob medida) is an **Admin API**
  token: the Storefront API rejects it with `401 "A valid Storefront token is required"`.
