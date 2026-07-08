/**
 * VTEX page type resolver.
 *
 * Given a URL path, determines if it corresponds to a product, category,
 * brand, department, collection, search, or 404 in VTEX's catalog.
 *
 * @see https://developers.vtex.com/docs/api-reference/catalog-api#get-/api/catalog_system/pub/portal/pagetype/-path-
 */
import { type PageType, vtexFetch } from "../client";

export type { PageType };

export type VtexPageKind =
	| "product"
	| "category"
	| "department"
	| "subcategory"
	| "brand"
	| "collection"
	| "search"
	| "fulltext"
	| "notfound";

/**
 * Resolve a URL path to a VTEX page type.
 *
 * @param urlPath - The path to resolve (e.g., "/shoes/running")
 * @returns The page type with kind normalization, or null on error
 */
export async function resolvePageType(
	urlPath: string,
): Promise<{ pageType: PageType; kind: VtexPageKind } | null> {
	const cleanPath = urlPath.replace(/^\//, "").replace(/\/$/, "");
	if (!cleanPath) return null;

	try {
		const pt = await vtexFetch<PageType>(`/api/catalog_system/pub/portal/pagetype/${cleanPath}`);

		const kind = normalizeKind(pt.pageType);
		return { pageType: pt, kind };
	} catch {
		return null;
	}
}

function normalizeKind(pageType: PageType["pageType"]): VtexPageKind {
	switch (pageType) {
		case "Product":
			return "product";
		case "Category":
			return "category";
		case "Department":
			return "department";
		case "SubCategory":
			return "subcategory";
		case "Brand":
			return "brand";
		case "Collection":
		case "Cluster":
			return "collection";
		case "Search":
			return "search";
		case "FullText":
			return "fulltext";
		default:
			return "notfound";
	}
}
