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

	if (slug) {
		return categories.filter((c) => c.slug === slug);
	}

	const sortedCategories = categories.sort((a, b) => {
		const comparison = a.name.localeCompare(b.name);
		return sortBy.endsWith("_desc") ? comparison : -comparison;
	});

	return count ? sortedCategories.slice(0, count) : sortedCategories;
}
