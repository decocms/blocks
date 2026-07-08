/**
 * VTEX Navbar (category tree) loader.
 * Pure async function — requires configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/navbar.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/catalog-api#get-/api/catalog_system/pub/category/tree/-categoryLevels-
 */

import type { SiteNavigationElement } from "@decocms/apps-commerce/types";
import { vtexFetch } from "../client";
import { categoryTreeToNavbar } from "../utils/transform";
import type { Category } from "../utils/types";

/**
 * Fetch the category tree and transform it into an array of
 * `SiteNavigationElement` nodes suitable for navigation menus.
 *
 * @param levels - Depth of the category tree (default: 2)
 */
export async function getNavbar(levels: number = 2): Promise<SiteNavigationElement[]> {
	const tree = await vtexFetch<Category[]>(`/api/catalog_system/pub/category/tree/${levels}`);

	return categoryTreeToNavbar(tree);
}
