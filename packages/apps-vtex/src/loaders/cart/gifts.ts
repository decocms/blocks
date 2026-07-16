/**
 * `vtex/loaders/cart/gifts` — selectable gifts + promotion teasers only.
 *
 * A focused read: fetches just the `ratesAndBenefitsData` (+ `items` so gift
 * eligibility resolves) and returns the gift-relevant slice, so a "you earned a
 * gift" UI does not have to load the whole cart. Empty for visitors with no
 * cart yet (no VTEX call).
 */

import { getOrCreateCartV2 } from "../../actions/checkout";
import type { OrderForm } from "../../types";
import { resolveOrderFormId } from "./orderFormId";

export interface CartGiftsProps {
  orderFormId?: string;
}

export interface CartGifts {
  orderFormId: string | null;
  /** VTEX `selectableGifts` — gifts the shopper can choose. */
  selectableGifts: unknown[];
  /** VTEX `ratesAndBenefitsData` — active promotions / teasers. */
  ratesAndBenefits: OrderForm["ratesAndBenefitsData"] | null;
}

const EMPTY: CartGifts = { orderFormId: null, selectableGifts: [], ratesAndBenefits: null };

export default async function cartGifts(props: CartGiftsProps = {}): Promise<CartGifts> {
  const orderFormId = resolveOrderFormId(props.orderFormId);
  if (!orderFormId) return EMPTY;

  const orderForm = (await getOrCreateCartV2({
    orderFormId,
    projection: "raw",
    sections: ["items", "ratesAndBenefitsData", "messages"],
  })) as OrderForm;

  return {
    orderFormId: orderForm.orderFormId ?? null,
    selectableGifts: orderForm.selectableGifts ?? [],
    ratesAndBenefits: orderForm.ratesAndBenefitsData ?? null,
  };
}
