import type { ProductListingPage } from "@decocms/apps-commerce/types";
import { getNuvemshopConfig, nuvemshopGet } from "../client";
import { applyListing, LISTING_WINDOW } from "../utils/listing";
import { originOf, type PageProps, pageUrlOf } from "../utils/request";
import { categoryChain, categoryPath, toBreadcrumbList } from "../utils/transform";
import type { NuvemshopCategory, NuvemshopList, NuvemshopProduct } from "../utils/types";

export interface Props extends PageProps {
  /** @description Search term. Defaults to the `q` URL param. */
  query?: string;
  /** @description Pin a category. Defaults to the last segment of the URL path. */
  categoryId?: number;
  /** @description Products per page. @default 24 */
  count?: number;
}

/**
 * @title Nuvemshop - Product Listing Page
 * @description Category or search page with in-memory facets (Cor/Tamanho/price), sort and pagination.
 */
export default async function productListingPage(
  props: Props,
  req?: Request,
): Promise<ProductListingPage | null> {
  const url = pageUrlOf(props, req);
  const origin = originOf(props, req);
  const { currency } = getNuvemshopConfig();
  const term = (props.query ?? url.searchParams.get("q") ?? "").trim();
  const opts = { origin, currency, count: props.count ?? 24 };

  if (term) {
    const found = await nuvemshopGet<NuvemshopList<NuvemshopProduct>>("/search/products", {
      q: term,
      per_page: LISTING_WINDOW,
    });
    const listing = applyListing(found?.data ?? [], url, opts);
    return {
      "@type": "ProductListingPage",
      ...listing,
      ...withPageType(listing.pageInfo, "Search"),
      breadcrumb: { "@type": "BreadcrumbList", itemListElement: [], numberOfItems: 0 },
      seo: {
        title: term,
        description: "",
        canonical: `${origin}${url.pathname}?q=${encodeURIComponent(term)}`,
        noIndexing: true,
      },
    };
  }

  const handle = (props.__pagePath ?? url.pathname).split("/").filter(Boolean).at(-1);
  const key = props.categoryId ?? handle;
  if (!key) return null;
  const [category, all] = await Promise.all([
    nuvemshopGet<NuvemshopCategory>(`/categories/${encodeURIComponent(key)}`),
    nuvemshopGet<NuvemshopList<NuvemshopCategory>>("/categories", { per_page: 200 }),
  ]);
  if (!category) return null;
  const categories = all?.data ?? [category];
  const leaf = categories.find((c) => c.id === category.id) ?? category;

  const sort = url.searchParams.get("sort");
  const list = await nuvemshopGet<NuvemshopList<NuvemshopProduct>>("/products", {
    category_id: category.id,
    per_page: LISTING_WINDOW,
    sort_by: sort === "best-selling" ? sort : undefined,
  });
  const listing = applyListing(list?.data ?? [], url, opts);

  return {
    "@type": "ProductListingPage",
    ...listing,
    ...withPageType(listing.pageInfo, leaf.parent ? "SubCategory" : "Category"),
    breadcrumb: toBreadcrumbList(leaf, categories, origin),
    seo: {
      title: leaf.seo_title || leaf.name,
      description: leaf.seo_description || leaf.description || "",
      canonical: `${origin}${categoryPath(categoryChain(leaf, categories))}`,
    },
  };
}

const withPageType = (
  pageInfo: ProductListingPage["pageInfo"],
  type: "Category" | "SubCategory" | "Search",
) => ({
  pageInfo: { ...pageInfo, pageTypes: [type] },
});
