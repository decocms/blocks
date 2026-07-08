import type { ProductListingPage } from "@decocms/apps-commerce/types";
import { getShopifyClient } from "../client";
import { ProductsByCollection, SearchProducts } from "../utils/storefront/queries";
import { type ProductShopify, toFilter, toProduct } from "../utils/transform";
import type { Metafield } from "../utils/types";
import {
	getFiltersByUrl,
	searchSortOptions,
	searchSortShopify,
	sortOptions,
	sortShopify,
} from "../utils/utils";

interface PageInfo {
	hasNextPage: boolean;
	hasPreviousPage: boolean;
	endCursor?: string;
	startCursor?: string;
}

interface FilterNode {
	id: string;
	label: string;
	type: string;
	values: Array<{ id: string; label: string; count: number; input: string }>;
}

interface ProductConnection {
	nodes: ProductShopify[];
	pageInfo: PageInfo;
	filters?: FilterNode[];
}

export interface Props {
	query?: string;
	collectionName?: string;
	count: number;
	metafields?: Metafield[];
	pageOffset?: number;
	page?: number;
	startCursor?: string;
	endCursor?: string;
	pageHref?: string;
}

export default async function productListingPageLoader(
	props: Props,
	url?: URL,
): Promise<ProductListingPage | null> {
	const pageUrl = url ?? new URL(props.pageHref || "https://localhost");
	const client = getShopifyClient();

	const count = props.count ?? 12;
	const query = props.query || pageUrl.searchParams.get("q") || "";
	const currentPageoffset = props.pageOffset ?? 1;
	const pageParam = pageUrl.searchParams.get("page")
		? Number(pageUrl.searchParams.get("page")) - currentPageoffset
		: 0;
	const page = props.page || pageParam;
	const endCursor = props.endCursor || pageUrl.searchParams.get("endCursor") || "";
	const startCursor = props.startCursor || pageUrl.searchParams.get("startCursor") || "";
	const metafields = props.metafields || [];

	const isSearch = Boolean(query);
	let hasNextPage = false;
	let hasPreviousPage = false;
	let shopifyProducts: ProductConnection | undefined;
	let shopifyFilters: FilterNode[] | undefined;
	let records: number | undefined;
	let collectionTitle: string | undefined;
	let collectionDescription: string | undefined;

	const sort = pageUrl.searchParams.get("sort") ?? "";

	if (isSearch) {
		const data = await client.query<{
			search: ProductConnection & { totalCount?: number; productFilters?: FilterNode[] };
		}>(SearchProducts, {
			...(!endCursor && { first: count }),
			...(endCursor && { last: count }),
			...(startCursor && { after: startCursor }),
			...(endCursor && { before: endCursor }),
			query,
			productFilters: getFiltersByUrl(pageUrl),
			identifiers: metafields,
			...searchSortShopify[sort],
		});

		shopifyProducts = data.search;
		shopifyFilters = data.search?.productFilters;
		records = data.search?.totalCount;
		hasNextPage = Boolean(data.search?.pageInfo.hasNextPage);
		hasPreviousPage = Boolean(data.search?.pageInfo.hasPreviousPage);
	} else {
		const pathname = props.collectionName || pageUrl.pathname.split("/")[1];

		const data = await client.query<{
			collection?: {
				title?: string;
				description?: string;
				products: ProductConnection;
			};
		}>(ProductsByCollection, {
			...(!endCursor && { first: count }),
			...(endCursor && { last: count }),
			...(startCursor && { after: startCursor }),
			...(endCursor && { before: endCursor }),
			identifiers: metafields,
			handle: pathname,
			filters: getFiltersByUrl(pageUrl),
			...sortShopify[sort],
		});

		shopifyProducts = data.collection?.products;
		shopifyFilters = data.collection?.products?.filters;
		hasNextPage = Boolean(data.collection?.products.pageInfo.hasNextPage);
		hasPreviousPage = Boolean(data.collection?.products.pageInfo.hasPreviousPage);
		collectionTitle = data.collection?.title;
		collectionDescription = data.collection?.description;
	}

	const products = shopifyProducts?.nodes?.map((p) => toProduct(p, p.variants.nodes[0], pageUrl));

	const nextPage = new URLSearchParams(pageUrl.searchParams);
	const previousPage = new URLSearchParams(pageUrl.searchParams);

	if (hasNextPage) {
		nextPage.set("page", (page + currentPageoffset + 1).toString());
		nextPage.set("startCursor", shopifyProducts?.pageInfo.endCursor ?? "");
		nextPage.delete("endCursor");
	}

	if (hasPreviousPage) {
		previousPage.set("page", (page + currentPageoffset - 1).toString());
		previousPage.set("endCursor", shopifyProducts?.pageInfo.startCursor ?? "");
		previousPage.delete("startCursor");
	}

	const filters = shopifyFilters?.map((filter) => toFilter(filter, pageUrl));
	const currentPage = page + currentPageoffset;

	return {
		"@type": "ProductListingPage",
		breadcrumb: {
			"@type": "BreadcrumbList",
			itemListElement: [
				{
					"@type": "ListItem" as const,
					name: isSearch ? query : pageUrl.pathname.split("/")[1],
					item: isSearch ? pageUrl.href : pageUrl.pathname,
					position: 2,
				},
			],
			numberOfItems: 1,
		},
		filters: filters ?? [],
		products: products ?? [],
		pageInfo: {
			nextPage: hasNextPage ? `?${nextPage}` : undefined,
			previousPage: hasPreviousPage ? `?${previousPage}` : undefined,
			currentPage,
			records,
			recordPerPage: count,
		},
		sortOptions: isSearch ? searchSortOptions : sortOptions,
		seo: {
			title: collectionTitle || "",
			description: collectionDescription || "",
			canonical: `${pageUrl.origin}${pageUrl.pathname}${page >= 1 ? `?page=${page}` : ""}`,
		},
	};
}
