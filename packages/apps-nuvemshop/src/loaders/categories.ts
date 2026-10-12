import type { SiteNavigationElement } from "@decocms/apps-commerce/types";
import { nuvemshopGet } from "../client";
import { originOf, type PageProps } from "../utils/request";
import { categoryChain, categoryPath } from "../utils/transform";
import type { NuvemshopCategory, NuvemshopList } from "../utils/types";

/**
 * @title Nuvemshop - Categories
 * @description Category tree for menus, with Nuvemshop-style nested URLs.
 */
export default async function categories(
  props: PageProps,
  req?: Request,
): Promise<SiteNavigationElement[]> {
  const all =
    (await nuvemshopGet<NuvemshopList<NuvemshopCategory>>("/categories", { per_page: 200 }))
      ?.data ?? [];
  const origin = originOf(props, req);
  const node = (c: NuvemshopCategory): SiteNavigationElement => ({
    "@type": "SiteNavigationElement",
    name: c.name,
    identifier: String(c.id),
    url: `${origin}${categoryPath(categoryChain(c, all))}`,
    children: all.filter((child) => child.parent === c.id).map(node),
  });
  return all.filter((c) => !c.parent).map(node);
}
