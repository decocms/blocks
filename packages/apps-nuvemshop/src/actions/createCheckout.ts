import { NuvemshopApiError, nuvemshopPost } from "../client";
import type { NuvemshopCheckout, NuvemshopLineItem } from "../utils/types";

export interface CartItem {
  productId: number;
  variantId: number;
  quantity: number;
}

export interface Props {
  items: CartItem[];
  coupon?: string;
}

export type CheckoutErrorCode =
  | "coupon_rejected"
  | "out_of_stock"
  | "unavailable"
  | "invalid"
  | "unknown";

export type CreateCheckoutResult =
  | { checkoutUrl: string }
  | { error: CheckoutErrorCode; message: string };

// API error code → what the buyer can act on.
const ERRORS: Record<string, CheckoutErrorCode> = {
  coupon_rejected: "coupon_rejected",
  checkout_rejected: "out_of_stock", // returned when a line exceeds the variant's stock
  resource_not_found: "unavailable",
  invalid_request: "invalid",
};

/**
 * @title Nuvemshop - Create Checkout
 * @description Opens a Nuvemshop cart with the items (and coupon) and returns the hosted checkout URL.
 * Failures come back as `{ error, message }` (rejected coupon, stock, removed variant) instead of throwing.
 */
export default async function createCheckout(
  props: Props,
  req?: Request,
): Promise<CreateCheckoutResult> {
  if (!props?.items?.length) return { error: "invalid", message: "Cannot checkout an empty cart" };
  const line_items: NuvemshopLineItem[] = props.items.map((i) => ({
    product_id: i.productId,
    variant_id: i.variantId,
    quantity: i.quantity,
  }));
  const coupon_code = props.coupon?.trim() || undefined;
  try {
    const res = await nuvemshopPost<NuvemshopCheckout>(
      "/checkouts",
      { line_items, coupon_code },
      { buyerIp: req?.headers.get("cf-connecting-ip") },
    );
    return { checkoutUrl: res.checkout_url };
  } catch (e) {
    if (!(e instanceof NuvemshopApiError)) throw e;
    return {
      error: ERRORS[e.code] ?? "unknown",
      message: e.message.replace(/^Nuvemshop \d+ [\w-]*: /, ""),
    };
  }
}
