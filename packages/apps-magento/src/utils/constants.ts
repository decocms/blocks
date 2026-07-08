/**
 * Magento constants — ported verbatim from
 * `deco-cx/apps/magento/utils/constants.ts`.
 *
 * Keep this file boring and append-only. Magento's REST and GraphQL
 * payloads rely on these identifiers as-is (URL_KEY for PDP slug
 * matching, GRAND_TOTAL/SUBTOTAL/… for the totals composition that
 * cart.ts pulls, IN_STOCK/OUT_OF_STOCK for schema.org availability).
 * Mutating any of these values would silently break consumer sites
 * that already render against them.
 */

import type { FiltersGraphQL } from "../client";

export const URL_KEY = "url_key";

// Schema.org availability mapping (used by utils/transform.ts to
// produce Offer.availability — kept here so transform doesn't import
// schema.org strings as magic literals).
export const IN_STOCK = "https://schema.org/InStock";
export const OUT_OF_STOCK = "https://schema.org/OutOfStock";

// Rating bounds used by `utils/transform.ts` (and the review/rating
// loaders that follow) when mapping Magento's integer-rating scale
// into schema.org `AggregateRating`'s 1–5 range.
export const MAX_RATING_VALUE = 5;
export const MIN_RATING_VALUE = 1;

/**
 * Default filter mapping consumed by `utils/graphql.ts:filtersFromUrlGraphQL`.
 * Each entry pairs a Magento attribute slug with the comparison operator
 * the storefront's URL filters use. Sites can extend this via the
 * `customFilters` prop on PLP/list loaders without forking the array.
 */
export const DEFAULT_GRAPHQL_FILTERS: FiltersGraphQL[] = [
	{ value: "activity", type: "EQUAL" },
	{ value: "category_gear", type: "EQUAL" },
	{ value: "category_id", type: "EQUAL" },
	{ value: "category_uid", type: "EQUAL" },
	{ value: "category_url_path", type: "EQUAL" },
	{ value: "climate", type: "EQUAL" },
	{ value: "collar", type: "EQUAL" },
	{ value: "color", type: "EQUAL" },
	{ value: "description", type: "MATCH" },
	{ value: "eco_collection", type: "EQUAL" },
	{ value: "erin_recommends", type: "EQUAL" },
	{ value: "features_bags", type: "EQUAL" },
	{ value: "format", type: "EQUAL" },
	{ value: "gender", type: "EQUAL" },
	{ value: "material", type: "EQUAL" },
	{ value: "name", type: "MATCH" },
	{ value: "new", type: "EQUAL" },
	{ value: "pattern", type: "EQUAL" },
	{ value: "performance_fabric", type: "EQUAL" },
	{ value: "price", type: "RANGE" },
	{ value: "purpose", type: "EQUAL" },
	{ value: "sale", type: "EQUAL" },
	{ value: "short_description", type: "MATCH" },
	{ value: "size", type: "EQUAL" },
	{ value: "sku", type: "EQUAL" },
	{ value: "sleeve", type: "EQUAL" },
	{ value: "strap_bags", type: "EQUAL" },
	{ value: "style_bags", type: "EQUAL" },
	{ value: "style_bottom", type: "EQUAL" },
	{ value: "style_general", type: "EQUAL" },
	{ value: "url_key", type: "EQUAL" },
];

/**
 * Query-string keys that should be stripped before forwarding a request
 * URL to Magento (e.g. when computing a cache key or building a
 * paginated request). Mirrors the Fresh-era REMOVABLE_URL_SEARCHPARAMS.
 */
export const REMOVABLE_URL_SEARCHPARAMS = ["p", "product_list_order"];

// ---------------------------------------------------------------------------
// Cart totals composition — field names sent to Magento's
// /V1/carts/:cartId/totals?fields=… endpoint. The cart loader joins
// these into the `fields` query param to keep the response narrow.
// ---------------------------------------------------------------------------

export const GRAND_TOTAL = "grand_total";
export const SUBTOTAL = "subtotal";
export const DISCOUNT_AMOUNT = "discount_amount";
export const BASE_DISCOUNT_AMOUNT = "base_discount_amount";
export const SHIPPING_AMOUNT = "shipping_amount";
export const BASE_SHIPPING_AMOUNT = "base_shipping_amount";
export const SHIPPING_DISCOUNT_AMOUNT = "shipping_discount_amount";
export const COUPON_CODE = "coupon_code";
export const BASE_CURRENCY_CODE = "base_currency_code";

// ---------------------------------------------------------------------------
// Cookie names — single source of truth so loaders/actions/middleware
// don't drift on string literals (Magento is case-sensitive about
// these and a typo produces a silent anonymous-session bug).
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "PHPSESSID";
export const CUSTOMER_COOKIE = "dataservices_customer_id";
export const CART_COOKIE = "dataservices_cart_id";
export const FORM_KEY_COOKIE = "form_key";
