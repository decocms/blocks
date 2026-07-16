/**
 * Cart v2 — platform-agnostic fragmentation contract.
 *
 * Two independent dimensions govern every cart operation:
 *
 * 1. `sections` — WHAT WE ASK THE PLATFORM FOR. Maps to VTEX's
 *    `expectedOrderFormSections`; other platforms map it to their own
 *    partial-response mechanism. Controls the upstream payload + compute.
 * 2. `projection` — WHAT THE SERVER RETURNS TO THE CLIENT. Independent of
 *    `sections`: we can ask the platform for the full cart yet project a slim
 *    `{ totalItems, total }` down the wire, or vice-versa.
 *
 * The whole point is "default to the minimum, everything opt-in". A mutation
 * that only needs to bump a badge should not ship the entire cart to the
 * browser, and a page view where the user never clicked "add" should not hit
 * the cart API at all.
 *
 * This module is deliberately platform-neutral — VTEX is the first
 * implementation (see `@decocms/apps/vtex/utils/cartProjection`), Shopify/Wake
 * reuse the same contract. Only types + presets live here; the actual
 * OrderForm→projection mapping is platform-specific.
 */

import type { MinicartItem } from "./commerce";

/**
 * A VTEX OrderForm section (the canonical superset). Other platforms map the
 * subset they support; unknown strings are allowed so a platform can request a
 * section this union doesn't yet name without a type error.
 */
export type CartSection =
  | "items"
  | "totalizers"
  | "clientProfileData"
  | "shippingData"
  | "paymentData"
  | "sellers"
  | "messages"
  | "marketingData"
  | "clientPreferencesData"
  | "storePreferencesData"
  | "giftRegistryData"
  | "ratesAndBenefitsData"
  | "openTextField"
  | "commercialConditionData"
  | "customData"
  | (string & {});

/**
 * Shape of the response the server sends to the client after a cart read or
 * mutation. Ordered from cheapest to richest:
 *
 * - `none` — `{ ok: true }`. The platform payload is discarded server-side.
 *   Use when the client updates optimistically and needs no confirmation data.
 * - `summary` — `{ orderFormId, totalItems, total }`. Enough for a badge.
 * - `summary+items` — summary plus the slim line items (the **default** for
 *   add-to-cart: the platform returns the items regardless, so we forward a
 *   trimmed view — name, image, price, chosen variant, quantity).
 * - `minicart` — the full canonical `Minicart` (drawer view).
 * - `raw` — the untouched platform cart (escape hatch for platform-specific
 *   reads: GTM, pixels, custom integrations).
 */
export type CartProjection = "none" | "summary" | "summary+items" | "minicart" | "raw";

/** Minimal, cacheable-shaped cart totals for a badge. All money in major units. */
export interface CartSummary {
  orderFormId: string | null;
  /** Sum of line quantities. `0` when there is no cart yet. */
  totalItems: number;
  /** Total payable, in major units. */
  total: number;
}

/**
 * A trimmed cart line — the "at least name, image, price, chosen size" the
 * user asked for. Structurally a subset of `MinicartItem` so it forwards
 * straight to analytics and drawer UIs without re-mapping.
 */
export interface CartItemSlim {
  item_id?: string;
  item_name?: string;
  item_variant?: string;
  image: string;
  /** Selling price per unit, in major units. */
  price: number;
  quantity: number;
}

/** `projection: "none"` result. */
export interface CartOk {
  ok: true;
}

/** `projection: "summary+items"` result — the add-to-cart default. */
export interface CartSummaryWithItems extends CartSummary {
  items: CartItemSlim[];
}

/**
 * Discriminated union of every projection result, so callers can narrow on the
 * `projection` they requested. `minicart`/`raw` payload types are supplied by
 * the platform binding via the generic params.
 */
export type CartProjectionResult<TMinicart = unknown, TRaw = unknown> =
  | CartOk
  | CartSummary
  | CartSummaryWithItems
  | TMinicart
  | TRaw;

// ---------------------------------------------------------------------------
// Section presets — the "which sections per operation" defaults.
// ---------------------------------------------------------------------------

/**
 * Smallest useful set for a mutation: line items + totals, plus `messages` so
 * stock/availability errors surface. This is the add-to-cart default and the
 * single biggest lever for shrinking both the VTEX payload and its compute.
 */
export const SECTIONS_MINIMAL: CartSection[] = ["items", "totalizers", "messages"];

/** Everything a drawer/minicart renders: totals, coupon, shipping, sellers. */
export const SECTIONS_DRAWER: CartSection[] = [
  "items",
  "totalizers",
  "messages",
  "marketingData",
  "sellers",
  "ratesAndBenefitsData",
  "storePreferencesData",
  "clientPreferencesData",
  "shippingData",
];

/** The full superset — parity with the legacy hardcoded default. */
export const SECTIONS_FULL: CartSection[] = [
  "items",
  "totalizers",
  "clientProfileData",
  "shippingData",
  "paymentData",
  "sellers",
  "messages",
  "marketingData",
  "clientPreferencesData",
  "storePreferencesData",
  "giftRegistryData",
  "ratesAndBenefitsData",
  "openTextField",
  "commercialConditionData",
  "customData",
];

/** Default sections per projection — used when a caller passes a projection but no explicit sections. */
export function defaultSectionsFor(projection: CartProjection): CartSection[] {
  switch (projection) {
    case "none":
    case "summary":
    case "summary+items":
      return SECTIONS_MINIMAL;
    case "minicart":
      return SECTIONS_DRAWER;
    case "raw":
      return SECTIONS_FULL;
  }
}

/** Re-export so consumers can build slim items against the canonical type. */
export type { MinicartItem };
