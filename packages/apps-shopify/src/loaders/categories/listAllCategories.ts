import { getShopifyClient } from "../../client";
import { ListAllCategories } from "../../utils/storefront/queries";
import type { CollectionSortKeys } from "../../utils/storefront/storefront.graphql.gen";
import type { CollectionNode } from "../../utils/transform";

export interface Props {
	/**
	 * @title After
	 * @description Returns the elements that come after the specified cursor.
	 */
	after?: string;
	/**
	 * @title Before
	 * @description Returns the elements that come before the specified cursor.
	 */
	before?: string;
	/**
	 * @title First
	 * @description Returns up to the first n elements from the list.
	 */
	first?: number;
	/**
	 * @title Last
	 * @description Returns up to the last n elements from the list.
	 */
	last?: number;
	/**
	 * @title Query
	 * @description Apply one or multiple filters to the query. Refer to the detailed search syntax for more information about using filters.
	 */
	query?: string;
	/**
	 * @title Reverse
	 * @description Reverse the order of the underlying list.
	 * @default false
	 */
	reverse?: boolean;
	/**
	 * @title Sort Key
	 * @description Sort the underlying list by the given key.
	 * @default ID
	 */
	sortKey?: CollectionSortKeys;
}

interface PageInfo {
	hasNextPage: boolean;
	hasPreviousPage: boolean;
	endCursor?: string | null;
	startCursor?: string | null;
}

export interface Category {
	id: string;
	name: string;
	url: string;
	image?: string;
	pageInfo: Partial<PageInfo>;
}

export default async function listAllCategoriesLoader(
	props: Props = {},
	url?: URL,
): Promise<Category[]> {
	const client = getShopifyClient();
	const { after, before, first, last, query, reverse, sortKey } = props;

	const data = await client.query<{
		collections?: { nodes: CollectionNode[]; pageInfo: PageInfo };
	}>(ListAllCategories, {
		after,
		before,
		first: first === undefined && last === undefined ? 250 : first,
		last,
		query,
		reverse,
		sortKey,
	});

	const origin = (url ?? new URL("https://localhost")).origin;
	const { hasNextPage, hasPreviousPage, endCursor, startCursor } =
		data?.collections?.pageInfo ?? {};

	return (data?.collections?.nodes ?? []).map((collection) => ({
		id: collection.handle,
		name: collection.title,
		url: `${origin}/collections/${collection.handle}`,
		image: collection.image?.url,
		pageInfo: { hasNextPage, hasPreviousPage, endCursor, startCursor },
	}));
}

export const cache = "stale-while-revalidate";

export const cacheKey = (props: Props = {}, req?: Request): string => {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(props)) {
		if (value !== undefined) params.set(key, String(value));
	}
	params.sort();

	const origin = req ? new URL(req.url).origin : "";
	return `shopify:listAllCategories:${origin}?${params}`;
};
