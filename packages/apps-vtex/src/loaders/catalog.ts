/**
 * VTEX Catalog System API loaders.
 * Pure async functions using vtexFetch. Require configureVtex() to have been called.
 *
 * Ported from deco-cx/apps vtex/loaders/legacy/*.ts and vtex/utils/client.ts
 * @see https://developers.vtex.com/docs/api-reference/catalog-api
 */
import { getVtexConfig, vtexFetch } from "../client";

// ---------------------------------------------------------------------------
// Product search (public)
// ---------------------------------------------------------------------------

export type LegacySort =
	| ""
	| "OrderByTopSaleDESC"
	| "OrderByReleaseDateDESC"
	| "OrderByBestDiscountDESC"
	| "OrderByPriceDESC"
	| "OrderByPriceASC"
	| "OrderByNameASC"
	| "OrderByNameDESC"
	| "OrderByScoreDESC";

export interface SearchProductsOpts {
	fq?: string | string[];
	ft?: string;
	sort?: LegacySort;
	from?: number;
	to?: number;
}

/**
 * Search products using the VTEX Catalog API.
 * @see https://developers.vtex.com/docs/api-reference/search-api#get-/api/catalog_system/pub/products/search
 */
export async function searchProducts<T = any>(opts: SearchProductsOpts = {}): Promise<T[]> {
	const params = new URLSearchParams();
	const fqs = Array.isArray(opts.fq) ? opts.fq : opts.fq ? [opts.fq] : [];
	for (const f of fqs) params.append("fq", f);
	if (opts.ft) params.set("ft", opts.ft);
	if (opts.sort) params.set("O", opts.sort);
	if (opts.from != null) params.set("_from", String(opts.from));
	if (opts.to != null) params.set("_to", String(opts.to));

	const { salesChannel } = getVtexConfig();
	if (salesChannel) params.set("sc", salesChannel);

	return vtexFetch<T[]>(`/api/catalog_system/pub/products/search/?${params}`);
}

/**
 * Get a product by productId or skuId.
 * @see https://developers.vtex.com/docs/api-reference/search-api#get-/api/catalog_system/pub/products/search
 */
export async function getProductByIdOrSku<T = any>(opts: {
	productId?: string;
	skuId?: string;
}): Promise<T | null> {
	let fq: string;
	if (opts.productId) fq = `productId:${opts.productId}`;
	else if (opts.skuId) fq = `skuId:${opts.skuId}`;
	else throw new Error("Neither productId nor skuId provided.");

	const results = await searchProducts<T>({ fq });
	return results[0] ?? null;
}

// ---------------------------------------------------------------------------
// Product variations (public)
// ---------------------------------------------------------------------------

/**
 * Get product SKU variations.
 * @see https://developers.vtex.com/docs/api-reference/catalog-api#get-/api/catalog_system/pub/products/variations/-productId-
 */
export async function getProductVariations<T = any>(productId: string): Promise<T> {
	return vtexFetch<T>(`/api/catalog_system/pub/products/variations/${productId}`);
}

// ---------------------------------------------------------------------------
// Product specification (private — requires appKey/appToken)
// ---------------------------------------------------------------------------

/**
 * Get product specifications (private API).
 * @see https://developers.vtex.com/docs/api-reference/catalog-api#get-/api/catalog_system/pvt/products/-productId-/specification
 */
export async function getProductSpecification<T = any>(productId: string): Promise<T> {
	return vtexFetch<T>(`/api/catalog_system/pvt/products/${productId}/Specification`);
}

// ---------------------------------------------------------------------------
// Cross-selling
// ---------------------------------------------------------------------------

export type CrossSellingType =
	| "similars"
	| "suggestions"
	| "accessories"
	| "whosawalsosaw"
	| "whosawalsobought"
	| "whoboughtalsobought"
	| "showtogether";

/**
 * Get cross-selling products.
 * @see https://developers.vtex.com/docs/api-reference/catalog-api#get-/api/catalog_system/pub/products/crossselling/-type-/-productId-
 */
export async function getCrossSelling<T = any>(
	type: CrossSellingType,
	productId: string,
): Promise<T[]> {
	return vtexFetch<T[]>(`/api/catalog_system/pub/products/crossselling/${type}/${productId}`);
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Get the category tree up to a given depth level.
 * @see https://developers.vtex.com/docs/api-reference/catalog-api#get-/api/catalog_system/pub/category/tree/-categoryLevels-
 */
export async function getCategoryTree<T = any>(levels = 3): Promise<T[]> {
	return vtexFetch<T[]>(`/api/catalog_system/pub/category/tree/${levels}`);
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

/**
 * Get all brands.
 * @see https://developers.vtex.com/docs/api-reference/catalog-api#get-/api/catalog_system/pub/brand/list
 */
export async function getBrands<T = any>(): Promise<T[]> {
	return vtexFetch<T[]>("/api/catalog_system/pub/brand/list");
}

// ---------------------------------------------------------------------------
// Page type
// ---------------------------------------------------------------------------

/**
 * Get the page type for a given term/path.
 * @see https://developers.vtex.com/docs/api-reference/catalog-api#get-/api/catalog_system/pub/portal/pagetype/-term-
 */
export async function getPageType<T = any>(term: string): Promise<T> {
	return vtexFetch<T>(`/api/catalog_system/pub/portal/pagetype/${term}`);
}

// ---------------------------------------------------------------------------
// Facets (legacy)
// ---------------------------------------------------------------------------

/**
 * Get facets/filters for a search term.
 * @see https://developers.vtex.com/docs/api-reference/search-api#get-/api/catalog_system/pub/facets/search/-term-
 */
export async function getFacets<T = any>(term: string): Promise<T> {
	return vtexFetch<T>(`/api/catalog_system/pub/facets/search/${term}`);
}
