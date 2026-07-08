/**
 * VTEX search-related loaders (Intelligent Search + Catalog).
 * Pure async functions — require configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/intelligentSearch/topsearches.ts
 *   vtex/loaders/intelligentSearch/productSearchValidator.ts
 *   vtex/loaders/options/productIdByTerm.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/intelligent-search-api
 */
import { getVtexConfig, intelligentSearch } from "../client";
import type { Suggestion } from "../utils/types";

// ---------------------------------------------------------------------------
// getTopSearches
// ---------------------------------------------------------------------------

/**
 * Fetch the top searches from Intelligent Search.
 *
 * @param locale - BCP-47 locale (defaults to the configured locale or "pt-BR")
 */
export async function getTopSearches(locale?: string): Promise<Suggestion> {
	const cfg = getVtexConfig();
	const effectiveLocale = locale ?? cfg.locale ?? "pt-BR";

	return intelligentSearch<Suggestion>("/top_searches", {
		locale: effectiveLocale,
	});
}

// ---------------------------------------------------------------------------
// validateProductSearch
// ---------------------------------------------------------------------------

export interface FacetsSearchProps {
	query?: string;
	facets?: string;
	sort?: string;
	count?: number;
	page?: number;
	locale?: string;
}

/**
 * Validate whether a product search returns results.
 *
 * Runs the given search parameters against Intelligent Search.
 * If no results are found and the props include facets, retries
 * the search without facets.
 *
 * Returns the raw IS response or `null` when nothing is found.
 */
export async function validateProductSearch<T = unknown>(
	props: FacetsSearchProps,
	fetcher: (props: FacetsSearchProps) => Promise<T[] | null>,
): Promise<T[] | null> {
	const results = await fetcher(props);
	if (results !== null && results.length > 0) return results;

	if (props.facets) {
		return fetcher({ ...props, facets: "" });
	}

	return null;
}

// ---------------------------------------------------------------------------
// getProductIdByTerm
// ---------------------------------------------------------------------------

interface ProductIdOption {
	value: string;
	label: string;
	image?: string;
}

interface ISSuggestionProduct {
	productId: string;
	productName: string;
	brand: string;
	linkText: string;
	items: Array<{
		itemId: string;
		name: string;
		images: Array<{ imageUrl: string; imageText: string }>;
		sellers: Array<{
			commertialOffer: { Price: number; ListPrice: number };
		}>;
	}>;
}

interface ISSuggestionResponse {
	searches: Array<{ term: string; count: number }>;
	products: ISSuggestionProduct[];
}

/**
 * Search for products by free-text term and return a list of
 * `{ value (SKU ID), label, image }` options.
 *
 * Hits the IS autocomplete_suggestions endpoint.
 */
export async function getProductIdByTerm(term?: string): Promise<ProductIdOption[]> {
	const query = (term ?? "").trim();
	if (!query) return [];

	const data = await intelligentSearch<ISSuggestionResponse>("/autocomplete_suggestions/", {
		query,
	});

	if (!data.products?.length) {
		return [{ value: "No products found", label: "No products found" }];
	}

	return data.products.flatMap((product) =>
		(product.items ?? []).map((item) => ({
			value: item.itemId,
			label: `${item.itemId} - ${product.productName} ${item.name} - ${product.productId}`,
			image: item.images?.[0]?.imageUrl,
		})),
	);
}
