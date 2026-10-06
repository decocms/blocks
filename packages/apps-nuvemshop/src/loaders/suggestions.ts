import type { Suggestion } from "@decocms/apps-commerce/types";
import type { PageProps } from "../utils/request";
import productList from "./productList";

export interface Props extends PageProps {
  query?: string;
  /** @default 6 (same as the theme's search suggestions) */
  count?: number;
}

/**
 * @title Nuvemshop - Search Suggestions
 * @description Autocomplete: top products for the typed term.
 */
export default async function suggestions(props: Props, req?: Request): Promise<Suggestion | null> {
  const query = props.query?.trim();
  if (!query) return null;
  const products = await productList({ ...props, query, count: props.count ?? 6 }, req);
  return {
    searches: [{ term: query, href: `/search/?q=${encodeURIComponent(query)}` }],
    products,
    hits: products.length,
  };
}
