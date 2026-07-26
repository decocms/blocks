/**
 * `vtex/loaders/cart/full` — the drawer/minicart loader.
 *
 * Returns the full canonical `Minicart`, but requests only `SECTIONS_DRAWER`
 * from VTEX (not the legacy 15-section superset). Call it when the user opens
 * the cart drawer — not on every page view.
 *
 * Like the summary loader, a first-time visitor gets an empty `Minicart` shell
 * with no VTEX call.
 *
 * Registered in the app manifest as `vtex/loaders/cart/full`
 * (`invoke.vtex.loaders.cart.full`).
 */

import type { Minicart } from "@decocms/apps-commerce/types";
import { SECTIONS_DRAWER } from "@decocms/apps-commerce/types";
import { getOrCreateCartV2 } from "../../actions/checkout";
import type { OrderForm } from "../../types";
import { resolveOrderFormId } from "./orderFormId";

export interface CartFullProps {
  orderFormId?: string;
  /** Free-shipping threshold in major units. `0` disables the progress bar. */
  freeShippingTarget?: number;
  /** Override the OrderForm's locale (BCP-47, e.g. `"pt-BR"`). */
  locale?: string;
  /** Where the checkout button sends the user. Default: `/checkout`. */
  checkoutHref?: string;
  /** Whether the UI should expose the coupon input. Default: `true`. */
  enableCoupon?: boolean;
}

function emptyMinicart(props: CartFullProps): Minicart<OrderForm | null> {
  return {
    original: null,
    storefront: {
      items: [],
      subtotal: 0,
      discounts: 0,
      total: 0,
      locale: props.locale ?? "pt-BR",
      currency: "BRL",
      enableCoupon: props.enableCoupon ?? true,
      freeShippingTarget: props.freeShippingTarget ?? 0,
      checkoutHref: props.checkoutHref ?? "/checkout",
    },
  };
}

export default async function cartFull(
  props: CartFullProps = {},
): Promise<Minicart<OrderForm | null>> {
  const orderFormId = resolveOrderFormId(props.orderFormId);
  if (!orderFormId) return emptyMinicart(props);

  return (await getOrCreateCartV2({
    orderFormId,
    projection: "minicart",
    sections: SECTIONS_DRAWER,
    minicartOptions: {
      freeShippingTarget: props.freeShippingTarget,
      locale: props.locale,
      checkoutHref: props.checkoutHref,
      enableCoupon: props.enableCoupon,
    },
  })) as Minicart<OrderForm>;
}
