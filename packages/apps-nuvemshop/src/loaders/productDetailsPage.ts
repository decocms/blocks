import type { ProductDetailsPage } from "@decocms/apps-commerce/types";
import { getNuvemshopConfig, nuvemshopGet } from "../client";
import { originOf, type PageProps, pageUrlOf } from "../utils/request";
import { toProductPage } from "../utils/transform";
import type { NuvemshopProduct } from "../utils/types";

export interface Props extends PageProps {
  /** @description Product handle or id. Defaults to the `/produtos/<handle>` URL segment (trailing slash optional). */
  slug?: string;
}

/**
 * @title Nuvemshop - Product Details Page
 * @description Product by handle/id; `?variant=<id>` selects the variant.
 */
export default async function productDetailsPage(
  props: Props,
  req?: Request,
): Promise<ProductDetailsPage | null> {
  const url = pageUrlOf(props, req);
  const slug = props.slug ?? url.pathname.match(/\/produtos\/([^/]+)/)?.[1];
  if (!slug) return null;
  const product = await nuvemshopGet<NuvemshopProduct>(`/products/${encodeURIComponent(slug)}`);
  if (!product?.variants?.length) return null;
  return toProductPage(product, {
    origin: originOf(props, req),
    currency: getNuvemshopConfig().currency,
    variantId: url.searchParams.get("variant") ?? url.searchParams.get("skuId"),
  });
}
