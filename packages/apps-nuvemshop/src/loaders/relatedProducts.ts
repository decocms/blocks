import type { Product } from "@decocms/apps-commerce/types";
import { getNuvemshopConfig, nuvemshopGet } from "../client";
import { originOf, type PageProps, pageUrlOf } from "../utils/request";
import { isAvailable, pickVariant, toProduct } from "../utils/transform";
import type { NuvemshopList, NuvemshopProduct } from "../utils/types";

export interface Props extends PageProps {
  /** @description Product handle or id. Defaults to the `/produtos/<handle>/` URL segment. */
  slug?: string;
  /** @default 8 */
  count?: number;
}

const CANDIDATES = 50;

/**
 * @title Nuvemshop - Related Products
 * @description Same rule as the Nuvemshop theme's fallback: products from the product's
 * category, without itself, in-stock first, refilled with out-of-stock ones.
 * (The theme prefers ids from a related-products app metafield, which the API doesn't expose.)
 */
export default async function relatedProducts(props: Props, req?: Request): Promise<Product[]> {
  const count = props.count ?? 8;
  const slug = props.slug ?? pageUrlOf(props, req).pathname.match(/\/produtos\/([^/]+)/)?.[1];
  if (!slug) return [];
  const product = await nuvemshopGet<NuvemshopProduct>(`/products/${encodeURIComponent(slug)}`);
  const category = product?.categories?.[0];
  if (!product || !category) return [];

  const list = await nuvemshopGet<NuvemshopList<NuvemshopProduct>>("/products", {
    category_id: category.id,
    per_page: CANDIDATES,
  });
  const others = (list?.data ?? []).filter((p) => p.id !== product.id && p.variants?.length);
  const inStock = (p: NuvemshopProduct) => p.variants!.some(isAvailable);
  // ponytail: no shuffle (the theme shuffles) — keeps the result cacheable.
  const ordered = [...others.filter(inStock), ...others.filter((p) => !inStock(p))].slice(0, count);

  const opts = { origin: originOf(props, req), currency: getNuvemshopConfig().currency };
  return ordered.map((p) => toProduct(p, pickVariant(p), opts));
}
