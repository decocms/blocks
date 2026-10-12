import type { Product } from "@decocms/apps-commerce/types";
import { getNuvemshopConfig, nuvemshopGet } from "../client";
import { originOf, type PageProps } from "../utils/request";
import { pickVariant, toProduct } from "../utils/transform";
import type { NuvemshopList, NuvemshopProduct, NuvemshopSort } from "../utils/types";

export interface Props extends PageProps {
  /** @description Product ids (max 30). Takes precedence over the other selectors. */
  ids?: number[];
  /** @description Product handles (max 30). */
  handles?: string[];
  /** @description Category id (includes subcategories). */
  categoryId?: number;
  /** @description Search term. */
  query?: string;
  /** @description Ignored for ids/handles (kept in request order) and search. */
  sort?: NuvemshopSort;
  /** @default 12 */
  count?: number;
}

/**
 * @title Nuvemshop - Product List
 * @description Shelf by ids, handles, category or search term.
 */
export default async function productList(props: Props, req?: Request): Promise<Product[]> {
  const count = props.count ?? 12;
  const byKeys = props.ids?.length
    ? { ids: props.ids.join(",") }
    : props.handles?.length
      ? { handles: props.handles.join(",") }
      : null;
  const list =
    props.query && !byKeys
      ? await nuvemshopGet<NuvemshopList<NuvemshopProduct>>("/search/products", {
          q: props.query,
          per_page: count,
        })
      : await nuvemshopGet<NuvemshopList<NuvemshopProduct>>("/products", {
          ...byKeys,
          // The API rejects sort_by combined with ids/handles.
          ...(!byKeys && { category_id: props.categoryId, sort_by: props.sort }),
          per_page: count,
        });
  const opts = { origin: originOf(props, req), currency: getNuvemshopConfig().currency };
  return (list?.data ?? [])
    .filter((p) => p.variants?.length)
    .map((p) => toProduct(p, pickVariant(p), opts));
}
