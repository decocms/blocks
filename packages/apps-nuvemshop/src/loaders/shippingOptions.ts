import { nuvemshopPost } from "../client";
import type { NuvemshopShippingOption, NuvemshopShippingOptions } from "../utils/types";

export interface Props {
  zipCode: string;
  variantId: number;
  /** @default 1 */
  quantity?: number;
}

export type ShippingOption = Omit<NuvemshopShippingOption, "price"> & { price: number };

/**
 * @title Nuvemshop - Shipping Options
 * @description Shipping quote for one variant + CEP (the API has no whole-cart quote yet).
 */
export default async function shippingOptions(
  props: Props,
  req?: Request,
): Promise<ShippingOption[]> {
  const res = await nuvemshopPost<NuvemshopShippingOptions>(
    "/shipping-options",
    { zip_code: props.zipCode, variant_id: props.variantId, quantity: props.quantity ?? 1 },
    { buyerIp: req?.headers.get("cf-connecting-ip") },
  );
  return res.shipping_options.map((o) => ({ ...o, price: Number(o.price) }));
}

export const cache = "no-store";
