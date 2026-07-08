/**
 * Product list loader using VTEX Intelligent Search + shared transform pipeline.
 * Maps IS response to schema.org Product[] following deco-cx/apps pattern.
 *
 * Supports: query search, collection IDs, SKU IDs, facets, sort, and
 * hideUnavailableItems — matching the original productList.ts behavior.
 */

import type { Product } from "@decocms/apps-commerce/types";
import { getVtexConfig, intelligentSearch, toFacetPath } from "../client";
import { pickSku, sortProducts, toProduct } from "../utils/transform";
import type { Product as ProductVTEX } from "../utils/types";

export interface ProductListProps {
	props?: CollectionProps | QueryProps | ProductIDProps | FacetsProps;
}

/** @title Collection ID */
export interface CollectionProps {
	/** VTEX product cluster id (e.g. `"150"`). */
	collection: string;
	count?: number;
	sort?: string;
	hideUnavailableItems?: boolean;
}

/** @title Keyword Search */
export interface QueryProps {
	query: string;
	count?: number;
	sort?: string;
	/** Pass either a raw IS fuzzy value (`"0" | "1" | "auto"`) or call `mapLabelledFuzzyToFuzzy()`. */
	fuzzy?: string;
	hideUnavailableItems?: boolean;
}

/** @title Product IDs */
export interface ProductIDProps {
	ids: string[];
	hideUnavailableItems?: boolean;
}

/** @title Advanced Facets */
export interface FacetsProps {
	query?: string;
	/** Facets path (e.g. `category-1/moda-feminina/category-2/calcados`). */
	facets: string;
	count?: number;
	sort?: string;
	hideUnavailableItems?: boolean;
}

function isCollectionProps(p: any): p is CollectionProps {
	return typeof p?.collection === "string";
}
function isProductIDProps(p: any): p is ProductIDProps {
	return Array.isArray(p?.ids) && p.ids.length > 0;
}
function isFacetsProps(p: any): p is FacetsProps {
	return typeof p?.facets === "string";
}

function resolveParams(props: ProductListProps): {
	query: string;
	count: number;
	sort: string;
	facetPath: string;
	fuzzy?: string;
	hideUnavailableItems: boolean;
	ids?: string[];
} {
	const inner = props.props ?? props;

	if (isProductIDProps(inner)) {
		return {
			query: `sku:${inner.ids.join(";")}`,
			count: inner.ids.length,
			sort: "",
			facetPath: "",
			hideUnavailableItems: inner.hideUnavailableItems ?? false,
			ids: inner.ids,
		};
	}

	if (isFacetsProps(inner)) {
		return {
			query: inner.query ?? "",
			count: inner.count ?? 12,
			sort: inner.sort ?? "",
			facetPath: inner.facets,
			hideUnavailableItems: inner.hideUnavailableItems ?? false,
		};
	}

	if (isCollectionProps(inner)) {
		return {
			query: "",
			count: inner.count ?? 12,
			sort: inner.sort ?? "",
			facetPath: toFacetPath([{ key: "productClusterIds", value: inner.collection }]),
			hideUnavailableItems: inner.hideUnavailableItems ?? false,
		};
	}

	return {
		query: (inner as any).query ?? "",
		count: (inner as any).count ?? 12,
		sort: (inner as any).sort ?? "",
		facetPath: "",
		fuzzy: (inner as any).fuzzy,
		hideUnavailableItems: (inner as any).hideUnavailableItems ?? false,
	};
}

export default async function vtexProductList(props: ProductListProps): Promise<Product[] | null> {
	try {
		const { query, count, sort, facetPath, fuzzy, hideUnavailableItems, ids } =
			resolveParams(props);

		const config = getVtexConfig();
		const locale = config.locale ?? "pt-BR";

		const params: Record<string, string> = {
			page: "1",
			count: String(count),
			locale,
			hideUnavailableItems: String(hideUnavailableItems),
		};
		if (query) params.query = query;
		if (sort) params.sort = sort;
		if (fuzzy) params.fuzzy = fuzzy;

		const endpoint = facetPath ? `/product_search/${facetPath}` : "/product_search/";

		const data = await intelligentSearch<{ products: ProductVTEX[] }>(endpoint, params);

		const vtexProducts = data.products ?? [];
		const baseUrl = config.publicUrl
			? `https://${config.publicUrl}`
			: `https://${config.account}.vtexcommercestable.${config.domain ?? "com.br"}`;

		let products = vtexProducts.map((p) => {
			const fetchedSkus = ids ? new Set(ids) : null;
			const preferredSku = fetchedSkus
				? (p.items.find((item) => fetchedSkus.has(item.itemId)) ?? pickSku(p))
				: pickSku(p);
			return toProduct(p, preferredSku, 0, { baseUrl, priceCurrency: "BRL" });
		});

		if (ids) {
			products = sortProducts(products, ids, "sku");
		}

		return products;
	} catch (error) {
		console.error("[VTEX] ProductList error:", error);
		return null;
	}
}
