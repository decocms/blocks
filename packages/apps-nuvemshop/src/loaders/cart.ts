import type { CartItem } from "../actions/createCheckout";
import { getNuvemshopConfig, nuvemshopGet } from "../client";
import { originOf, type PageProps } from "../utils/request";
import { isAvailable, productPath, variantPrices } from "../utils/transform";
import type { NuvemshopList, NuvemshopProduct } from "../utils/types";

export interface Props extends PageProps {
  /** Items held by the client cart (`useCart`). */
  items: CartItem[];
}

export interface CartLine extends CartItem {
  name: string;
  variantName: string;
  image?: string;
  url: string;
  price: number;
  listPrice: number;
  subtotal: number;
  /** Most the checkout will accept for this variant (stock, capped at 99). */
  maxQuantity: number;
  /** `quantity` was lowered to `maxQuantity`. */
  adjusted?: boolean;
}

export interface Cart {
  lines: CartLine[];
  unavailable: (CartItem & { reason: "not_found" | "out_of_stock" })[];
  itemCount: number;
  subtotal: number;
  listSubtotal: number;
  savings: number;
  currency: string;
}

const MAX_PER_VARIANT = 99;
const IDS_PER_REQUEST = 30; // API limit for `ids`
const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * @title Nuvemshop - Cart
 * @description Minicart data for the client-held items: names, images, prices, totals and savings,
 * fresh from the Storefront API. Quantities are clamped to stock so the checkout won't reject them.
 * No coupon preview (the API has none) — the coupon is validated when the checkout is created.
 */
export default async function cart(props: Props, req?: Request): Promise<Cart> {
  const { currency = "BRL" } = getNuvemshopConfig();
  const items = props?.items ?? [];
  const ids = [...new Set(items.map((i) => i.productId))];
  const products = new Map<number, NuvemshopProduct>();
  for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
    const list = await nuvemshopGet<NuvemshopList<NuvemshopProduct>>("/products", {
      ids: ids.slice(i, i + IDS_PER_REQUEST).join(","),
      per_page: IDS_PER_REQUEST,
    });
    for (const p of list?.data ?? []) products.set(p.id, p);
  }

  const origin = originOf(props, req);
  const lines: CartLine[] = [];
  const unavailable: Cart["unavailable"] = [];
  for (const item of items) {
    const product = products.get(item.productId);
    const variant = product?.variants?.find((v) => v.id === item.variantId);
    if (!product || !variant || variant.visible === false) {
      unavailable.push({ ...item, reason: "not_found" });
      continue;
    }
    if (!isAvailable(variant)) {
      unavailable.push({ ...item, reason: "out_of_stock" });
      continue;
    }
    const maxQuantity = Math.min(
      variant.stock_management && variant.stock != null ? variant.stock : MAX_PER_VARIANT,
      MAX_PER_VARIANT,
    );
    const quantity = Math.min(Math.max(1, item.quantity), maxQuantity);
    const { price, listPrice } = variantPrices(variant);
    const image = product.images?.find((i) => i.id === variant.image_id) ?? product.images?.[0];
    lines.push({
      ...item,
      quantity,
      maxQuantity,
      ...(quantity !== item.quantity && { adjusted: true }),
      name: product.name,
      variantName: variant.values.join(" / "),
      image: image?.src,
      url: `${origin}${productPath(product.handle)}?variant=${variant.id}`,
      price,
      listPrice,
      subtotal: cents(price * quantity),
    });
  }

  const subtotal = cents(lines.reduce((s, l) => s + l.subtotal, 0));
  const listSubtotal = cents(lines.reduce((s, l) => s + l.listPrice * l.quantity, 0));
  return {
    lines,
    unavailable,
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    subtotal,
    listSubtotal,
    savings: cents(listSubtotal - subtotal),
    currency,
  };
}

export const cache = "no-store";
