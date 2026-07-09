/**
 * VTEX Collections loader.
 * Pure async function — requires configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/collections/list.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/catalog-api#get-/api/catalog_system/pvt/collection/search
 */
import { vtexFetch } from "../client";
import type { CollectionList } from "../utils/types";

export interface CollectionOption {
	value: string;
	label: string;
}

/**
 * Fetch collections, optionally filtering by search term.
 *
 * Without a term returns up to 3 000 collections; with a term
 * returns the first 15 matches. Results are mapped to a simple
 * `{ value, label }` list suitable for dropdowns / selectors.
 *
 * Note: uses the **pvt** (private) endpoint — requires appKey/appToken.
 */
export async function getCollections(term?: string): Promise<CollectionOption[]> {
	const params = new URLSearchParams();

	if (term) {
		params.set("page", "1");
		params.set("pageSize", "15");
		const list = await vtexFetch<CollectionList>(
			`/api/catalog_system/pvt/collection/search/${encodeURIComponent(term)}?${params}`,
		);
		return mapToOptions(list);
	}

	params.set("page", "1");
	params.set("pageSize", "3000");
	params.set("orderByAsc", "false");
	const list = await vtexFetch<CollectionList>(
		`/api/catalog_system/pvt/collection/search?${params}`,
	);
	return mapToOptions(list);
}

function mapToOptions(list: CollectionList): CollectionOption[] {
	return (
		list.items?.map((c) => ({
			value: `${c.id}`,
			label: `${c.id} - ${c.name}`,
		})) ?? []
	);
}
