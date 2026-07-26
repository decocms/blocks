/**
 * `vtex/loaders/cart/summary` — the badge loader.
 *
 * Returns the smallest useful cart shape: `{ orderFormId, totalItems, total }`.
 * For a first-time visitor (no orderFormId cookie) it returns an empty summary
 * **without touching VTEX** — this is the "don't create a cart on page load"
 * guarantee. Only visitors who already have a cart pay a checkout API call, and
 * that call requests just `items`+`totalizers` (via `SECTIONS_MINIMAL`).
 *
 * Registered in the app manifest as `vtex/loaders/cart/summary`, so it is
 * invoke-callable from the client (`invoke.vtex.loaders.cart.summary`) in both
 * Next.js and TanStack Start.
 */

import type { CartSummary } from "@decocms/apps-commerce/types";
import { SECTIONS_MINIMAL } from "@decocms/apps-commerce/types";
import { getOrCreateCartV2 } from "../../actions/checkout";
import { resolveOrderFormId } from "./orderFormId";

export interface CartSummaryProps {
  /** Override the orderFormId; defaults to the request cookie. */
  orderFormId?: string;
}

const EMPTY_SUMMARY: CartSummary = { orderFormId: null, totalItems: 0, total: 0 };

export default async function cartSummary(props: CartSummaryProps = {}): Promise<CartSummary> {
  const orderFormId = resolveOrderFormId(props.orderFormId);
  if (!orderFormId) return EMPTY_SUMMARY;

  return (await getOrCreateCartV2({
    orderFormId,
    projection: "summary",
    sections: SECTIONS_MINIMAL,
  })) as CartSummary;
}
