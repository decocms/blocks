import type { Product } from "@decocms/apps-commerce/types";
import { getShopifyClient } from "../client";
import { ProductsByCollection, SearchProducts } from "../utils/storefront/queries";
import { type ProductShopify, toProduct } from "../utils/transform";
import type { Metafield } from "../utils/types";
import {
	type CollectionSortKeys,
	type SearchSortKeys,
	searchSortShopify,
	sortShopify,
} from "../utils/utils";

export interface QueryProps {
	query: string;
	count: number;
	sort?: SearchSortKeys;
}

export interface CollectionProps {
	collection: string;
	count: number;
	sort?: CollectionSortKeys;
}

export interface FilterProps {
	tags?: string[];
	productTypes?: string[];
	productVendors?: string[];
	priceMin?: number;
	priceMax?: number;
	variantOptions?: { name: string; value: string }[];
}

export type Props = {
	props: QueryProps | CollectionProps;
	filters?: FilterProps;
	metafields?: Metafield[];
};

const isQueryList = (p: QueryProps | CollectionProps): p is QueryProps =>
	"query" in p && typeof p.query === "string" && typeof p.count === "number";

export default async function productListLoader(
	expandedProps: Props,
	url?: URL,
): Promise<Product[] | null> {
	const client = getShopifyClient();

	const props = expandedProps.props ?? (expandedProps as unknown as Props["props"]);

	const count = props.count ?? 12;
	const metafields = expandedProps.metafields || [];
	const sort = props.sort ?? "";

	const filters: Record<string, unknown>[] = [];
	for (const tag of expandedProps.filters?.tags ?? []) {
		filters.push({ tag });
	}
	for (const productType of expandedProps.filters?.productTypes ?? []) {
		filters.push({ productType });
	}
	for (const productVendor of expandedProps.filters?.productVendors ?? []) {
		filters.push({ productVendor });
	}
	if (expandedProps.filters?.priceMin != null)
		filters.push({ price: { min: expandedProps.filters.priceMin } });
	if (expandedProps.filters?.priceMax != null)
		filters.push({ price: { max: expandedProps.filters.priceMax } });
	for (const variantOption of expandedProps.filters?.variantOptions ?? []) {
		filters.push({ variantOption });
	}

	let shopifyProducts: { nodes: ProductShopify[] } | undefined;

	if (isQueryList(props)) {
		const data = await client.query<{ search: { nodes: ProductShopify[] } }>(SearchProducts, {
			first: count,
			query: props.query,
			productFilters: filters,
			identifiers: metafields,
			...searchSortShopify[sort],
		});
		shopifyProducts = data.search;
	} else {
		const data = await client.query<{
			collection?: { products: { nodes: ProductShopify[] } };
		}>(ProductsByCollection, {
			first: count,
			handle: (props as CollectionProps).collection,
			filters,
			identifiers: metafields,
			...sortShopify[sort],
		});
		shopifyProducts = data.collection?.products;
	}

	const baseUrl = url ?? new URL("https://localhost");

	const products = shopifyProducts?.nodes.map((p) => toProduct(p, p.variants.nodes[0], baseUrl));

	return products ?? [];
}
