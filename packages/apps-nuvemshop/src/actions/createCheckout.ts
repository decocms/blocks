import { nuvemshopPost } from "../client";
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

/**
 * @title Nuvemshop - Create Checkout
 * @description Opens a Nuvemshop cart with the items (and coupon) and returns the hosted checkout URL.
 */
export default async function createCheckout(
  props: Props,
  req?: Request,
): Promise<{ checkoutUrl: string }> {
  if (!props.items?.length) throw new Error("Cannot checkout an empty cart");
  const line_items: NuvemshopLineItem[] = props.items.map((i) => ({
    product_id: i.productId,
    variant_id: i.variantId,
    quantity: i.quantity,
  }));
  const coupon_code = props.coupon?.trim() || undefined;
  const res = await nuvemshopPost<NuvemshopCheckout>(
    "/checkouts",
    { line_items, coupon_code },
    { buyerIp: req?.headers.get("cf-connecting-ip") },
  );
  return { checkoutUrl: res.checkout_url };
}
