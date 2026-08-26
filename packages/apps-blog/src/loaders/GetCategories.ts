import { getRecordsByPath } from "../core/records";
import type { Category } from "../types";

const COLLECTION_PATH = "collections/blog/categories";
const ACCESSOR = "category";

export interface Props {
  /**
   * @title Category Slug
   * @description Get the category data from a specific slug.
   */
  slug?: string;
  /**
   * @title Items count
   * @description Number of categories to return
   */
  count?: number;
  /**
   * @title Sort
   * @description The sorting option. Default is "title_desc"
   */
  sortBy?: "title_asc" | "title_desc";
}

/**
 * @title GetCategories
 * @description Retrieves a list of blog categories.
 */
export default function GetCategories({
  count,
  slug,
  sortBy = "title_desc",
}: Props): Category[] | null {
  const categories = getRecordsByPath<Category>(COLLECTION_PATH, ACCESSOR);

  if (!categories?.length) return null;

  // Records come straight from the CMS, so name/slug are strings only by
  // convention. A record missing either has no route and no label, so it would
  // render as a blank chip linking nowhere — and would throw in the
  // `localeCompare` sort below.
  const validCategories = categories.filter(
    (c) =>
      typeof c?.name === "string" &&
      c.name.length > 0 &&
      typeof c?.slug === "string" &&
      c.slug.length > 0,
  );

  if (slug) {
    return validCategories.filter((c) => c.slug === slug);
  }

  if (!validCategories.length) return null;

  const sortedCategories = validCategories.sort((a, b) => {
    const comparison = a.name.localeCompare(b.name);
    return sortBy.endsWith("_desc") ? comparison : -comparison;
  });

  return count ? sortedCategories.slice(0, count) : sortedCategories;
}
