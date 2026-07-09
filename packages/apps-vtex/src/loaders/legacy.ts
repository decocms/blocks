/**
 * Legacy VTEX Catalog Search loaders.
 * Pure async functions — require configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/legacy/productDetailsPage.ts
 *   vtex/loaders/legacy/productList.ts
 *   vtex/loaders/legacy/productListingPage.ts
 *   vtex/loaders/legacy/suggestions.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/search-api
 */
import type {
	Filter,
	Product,
	ProductDetailsPage,
	ProductListingPage,
	Suggestion,
} from "@decocms/apps-commerce/types";
import { getVtexConfig, vtexFetch, vtexFetchResponse } from "../client";
import {
	getMapAndTerm,
	getValidTypesFromPageTypes,
	pageTypesFromPathname,
	pageTypesToBreadcrumbList,
	pageTypesToSeo,
} from "../utils/legacy";
import {
	legacyFacetToFilter,
	parsePageType,
	pickSku,
	sortProducts,
	toProduct,
	toProductPage,
} from "../utils/transform";
import type { LegacyFacet, LegacyItem, LegacyProduct, LegacySort, PageType } from "../utils/types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MAX_ALLOWED_PAGES = 500;

function salesChannelParam(): string {
	return getVtexConfig().salesChannel ?? "1";
}

function buildSearchParams(
	extra: Record<string, string | string[] | number | undefined>,
): URLSearchParams {
	const params = new URLSearchParams();
	const sc = salesChannelParam();
	if (sc) params.set("sc", sc);

	for (const [key, val] of Object.entries(extra)) {
		if (val == null) continue;
		if (Array.isArray(val)) {
			for (const v of val) params.append(key, v);
		} else {
			params.set(key, String(val));
		}
	}
	return params;
}

// ---------------------------------------------------------------------------
// legacyProductDetailsPage
// ---------------------------------------------------------------------------

export interface LegacyPDPOptions {
	slug: string;
	skuId?: string;
	/** Base URL for building canonical/absolute links. Defaults to the page URL. */
	baseUrl?: string;
	priceCurrency?: string;
	includeOriginalAttributes?: string[];
	preferDescription?: boolean;
	/** When true, pages with ?skuId are still indexable */
	indexingSkus?: boolean;
	/**
	 * Injected by the framework resolver into every commerce loader — not user-configurable.
	 * @hide true
	 */
	__pageUrl?: string;
}

/**
 * Fetch a product details page using the legacy Catalog search API.
 *
 * @see https://developers.vtex.com/docs/api-reference/search-api#get-/api/catalog_system/pub/products/search/-slug-/p
 * Ported from: vtex/loaders/legacy/productDetailsPage.ts
 */
export async function legacyProductDetailsPage(
	opts: LegacyPDPOptions,
): Promise<ProductDetailsPage | null> {
	const {
		slug,
		skuId,
		priceCurrency = "BRL",
		includeOriginalAttributes,
		preferDescription,
		indexingSkus,
	} = opts;

	// Ported from deco-cx, where baseUrl came from `req.url`. Here the resolver
	// injects __pageUrl into every commerce loader instead.
	const baseUrl = opts.baseUrl ?? opts.__pageUrl;
	if (!baseUrl) {
		throw new Error("legacyProductDetailsPage requires baseUrl or __pageUrl");
	}

	const lowercaseSlug = slug.toLowerCase();
	const qs = buildSearchParams({});

	const response = await vtexFetch<LegacyProduct[]>(
		`/api/catalog_system/pub/products/search/${lowercaseSlug}/p?${qs}`,
	);

	if (response && !Array.isArray(response)) {
		throw new Error(`Error while fetching VTEX data ${JSON.stringify(response)}`);
	}

	const [product] = response;
	if (!product) return null;

	const sku = pickSku(product, skuId);

	const kitItems: LegacyProduct[] =
		Array.isArray(sku.kitItems) && sku.kitItems.length > 0
			? await vtexFetch<LegacyProduct[]>(
					`/api/catalog_system/pub/products/search/?${buildSearchParams({
						_from: 0,
						_to: 49,
						fq: sku.kitItems.map((item) => `skuId:${item.itemId}`),
					})}`,
				)
			: [];

	const page = toProductPage(product, sku, kitItems, {
		baseUrl,
		priceCurrency,
		includeOriginalAttributes,
	});

	const url = new URL(baseUrl);

	return {
		...page,
		seo: {
			title: product.productTitle || product.productName,
			description: preferDescription ? product.description : product.metaTagDescription,
			canonical: new URL(`/${product.linkText}/p`, url.origin).href,
			noIndexing: indexingSkus ? false : !!skuId,
		},
	};
}

// ---------------------------------------------------------------------------
// legacyProductList
// ---------------------------------------------------------------------------

export type LegacyProductListQuery =
	| { collection: string; count: number; sort?: LegacySort }
	| { term?: string; count: number; sort?: LegacySort }
	| { fq: string[]; count: number; sort?: LegacySort }
	| { skuIds: string[] }
	| { productIds: string[] };

export interface LegacyProductListOptions {
	query: LegacyProductListQuery;
	/** Base URL for building canonical/absolute links. Defaults to the page URL. */
	baseUrl?: string;
	priceCurrency?: string;
	/**
	 * Injected by the framework resolver into every commerce loader — not user-configurable.
	 * @hide true
	 */
	__pageUrl?: string;
}

function isCollectionQuery(
	q: LegacyProductListQuery,
): q is { collection: string; count: number; sort?: LegacySort } {
	return "collection" in q && typeof (q as any).collection === "string";
}
function isSkuIdsQuery(q: LegacyProductListQuery): q is { skuIds: string[] } {
	return "skuIds" in q && Array.isArray((q as any).skuIds);
}
function isProductIdsQuery(q: LegacyProductListQuery): q is { productIds: string[] } {
	return "productIds" in q && Array.isArray((q as any).productIds);
}
function isFqQuery(
	q: LegacyProductListQuery,
): q is { fq: string[]; count: number; sort?: LegacySort } {
	return "fq" in q && Array.isArray((q as any).fq);
}
function isTermQuery(
	q: LegacyProductListQuery,
): q is { term?: string; count: number; sort?: LegacySort } {
	return "term" in q || ("count" in q && !isCollectionQuery(q as any) && !isFqQuery(q as any));
}

function queryToSearchParams(
	query: LegacyProductListQuery,
): Record<string, string | string[] | number | undefined> {
	if (isSkuIdsQuery(query)) {
		return {
			fq: query.skuIds.map((id) => `skuId:${id}`),
			_from: 0,
			_to: Math.max(query.skuIds.length - 1, 0),
		};
	}

	if (isProductIdsQuery(query)) {
		return {
			fq: query.productIds.map((id) => `productId:${id}`),
			_from: 0,
			_to: Math.max(query.productIds.length - 1, 0),
		};
	}

	const count = "count" in query ? (query.count ?? 12) : 12;
	const sort = "sort" in query ? query.sort : undefined;
	const base: Record<string, string | string[] | number | undefined> = {
		_from: 0,
		_to: Math.max(count - 1, 0),
		O: sort,
	};

	if (isCollectionQuery(query)) {
		base.fq = [`productClusterIds:${query.collection}`];
		return base;
	}

	if (isFqQuery(query)) {
		base.fq = query.fq;
		return base;
	}

	if (isTermQuery(query) && query.term) {
		base.ft = encodeURIComponent(query.term);
	}

	return base;
}

/**
 * Fetch a product list using the legacy Catalog search API.
 *
 * @see https://developers.vtex.com/docs/api-reference/search-api#get-/api/catalog_system/pub/products/search
 * Ported from: vtex/loaders/legacy/productList.ts
 */
export async function legacyProductList(opts: LegacyProductListOptions): Promise<Product[] | null> {
	const { query, priceCurrency = "BRL" } = opts;

	// Ported from deco-cx, where baseUrl came from `req.url`. Here the resolver
	// injects __pageUrl into every commerce loader instead.
	const baseUrl = opts.baseUrl ?? opts.__pageUrl;
	if (!baseUrl) {
		throw new Error("legacyProductList requires baseUrl or __pageUrl");
	}

	const searchArgs = queryToSearchParams(query);
	const qs = buildSearchParams(searchArgs);

	const vtexProducts = await vtexFetch<LegacyProduct[]>(
		`/api/catalog_system/pub/products/search/?${qs}`,
	);

	if (vtexProducts && !Array.isArray(vtexProducts)) {
		throw new Error(`Error while fetching VTEX data ${JSON.stringify(vtexProducts)}`);
	}

	const preferredSKU = (items: LegacyItem[]): LegacyItem => {
		if (isSkuIdsQuery(query)) {
			const fetchedSkus = new Set(query.skuIds);
			return items.find((item) => fetchedSkus.has(item.itemId)) || items[0];
		}
		return items[0];
	};

	let products = vtexProducts.map((p) =>
		toProduct(p, preferredSKU(p.items), 0, { baseUrl, priceCurrency }),
	);

	if (isSkuIdsQuery(query)) {
		products = sortProducts(products, query.skuIds, "sku");
	}
	if (isProductIdsQuery(query)) {
		products = sortProducts(products, query.productIds, "inProductGroupWithID");
	}

	return products;
}

// ---------------------------------------------------------------------------
// legacyProductListingPage
// ---------------------------------------------------------------------------

export const LEGACY_SORT_OPTIONS = [
	{ label: "price:desc", value: "OrderByPriceDESC" },
	{ label: "price:asc", value: "OrderByPriceASC" },
	{ label: "orders:desc", value: "OrderByTopSaleDESC" },
	{ label: "name:desc", value: "OrderByNameDESC" },
	{ label: "name:asc", value: "OrderByNameASC" },
	{ label: "release:desc", value: "OrderByReleaseDateDESC" },
	{ label: "discount:desc", value: "OrderByBestDiscountDESC" },
	{ label: "relevance:desc", value: "OrderByScoreDESC" },
] as const;

const IS_TO_LEGACY: Record<string, LegacySort> = {
	"price:desc": "OrderByPriceDESC",
	"price:asc": "OrderByPriceASC",
	"orders:desc": "OrderByTopSaleDESC",
	"name:desc": "OrderByNameDESC",
	"name:asc": "OrderByNameASC",
	"release:desc": "OrderByReleaseDateDESC",
	"discount:desc": "OrderByBestDiscountDESC",
	"relevance:desc": "OrderByScoreDESC",
};

const formatPriceFromPathToFacet = (term: string) =>
	term.replace(/de-\d+[,]?[\d]+-a-\d+[,]?[\d]+/, (match) => match.replaceAll(",", "."));

const removeForwardSlash = (str: string) => str.slice(str.startsWith("/") ? 1 : 0);

const getTerm = (path: string, map: string) => {
	const mapSegments = map.split(",");
	const pathSegments = removeForwardSlash(path).split("/");
	const term = pathSegments.slice(0, mapSegments.length).join("/");
	return mapSegments.includes("priceFrom") ? formatPriceFromPathToFacet(term) : term;
};

export const getFirstItemAvailable = (item: LegacyItem) =>
	!!item?.sellers?.find((s) => s.commertialOffer?.AvailableQuantity > 0);

const getTermFallback = (url: URL, isPage: boolean, hasFilters: boolean) => {
	const pathList = url.pathname.split("/").slice(1);
	if (!isPage && !hasFilters && pathList.length === 1) return pathList[0];
	return "";
};

export interface LegacyPLPOptions {
	/** URL of the page being rendered (used for filter links, pagination, etc.). Defaults to __pageUrl. */
	url?: URL;
	/** Override the search term (path). Defaults to url.pathname */
	term?: string;
	/** Items per page */
	count?: number;
	/** Current page number (0-indexed internally; see pageOffset) */
	page?: number;
	/** Starting page offset. Defaults to 1. */
	pageOffset?: number;
	sort?: LegacySort;
	/** FullText search term */
	ft?: string;
	/** Filter query */
	fq?: string;
	/** Map parameter */
	map?: string;
	/** Filter behavior: dynamic (default) or static */
	filters?: "dynamic" | "static";
	/** Base URL for building canonical/absolute links. Defaults to the page URL origin. */
	baseUrl?: string;
	priceCurrency?: string;
	/** Use collection name as page title */
	useCollectionName?: boolean;
	/** Ignore case when checking if a facet is selected */
	ignoreCaseSelected?: boolean;
	includeOriginalAttributes?: string[];
	/**
	 * Injected by the framework resolver into every commerce loader — not user-configurable.
	 * @hide true
	 */
	__pageUrl?: string;
}

/**
 * Fetch a product listing page (PLP) using the legacy Catalog search API.
 * Handles categories, departments, brands, collections, and full-text search.
 *
 * @see https://developers.vtex.com/docs/api-reference/search-api#get-/api/catalog_system/pub/products/search
 * Ported from: vtex/loaders/legacy/productListingPage.ts
 */
export async function legacyProductListingPage(
	opts: LegacyPLPOptions,
): Promise<ProductListingPage | null> {
	const {
		priceCurrency = "BRL",
		filters: filtersBehavior = "dynamic",
		ignoreCaseSelected,
		useCollectionName,
		includeOriginalAttributes,
	} = opts;

	// Ported from deco-cx, where the URL came from `req`. Here the resolver
	// injects __pageUrl into every commerce loader instead.
	const url = opts.url ?? (opts.__pageUrl ? new URL(opts.__pageUrl) : undefined);
	if (!url) {
		throw new Error("legacyProductListingPage requires url or __pageUrl");
	}
	const baseUrl = opts.baseUrl ?? url.origin;

	const currentPageOffset = opts.pageOffset ?? 1;
	const countFromSearchParams = url.searchParams.get("PS");
	const count = Number(countFromSearchParams ?? opts.count ?? 12);

	const maybeMap = opts.map || url.searchParams.get("map") || undefined;
	const maybeTerm = opts.term || url.pathname || "";

	const pageParam = url.searchParams.get("page")
		? Number(url.searchParams.get("page")) - currentPageOffset
		: 0;
	const page = opts.page ?? pageParam;
	const O: LegacySort =
		(url.searchParams.get("O") as LegacySort) ??
		IS_TO_LEGACY[url.searchParams.get("sort") ?? ""] ??
		opts.sort ??
		(LEGACY_SORT_OPTIONS[0].value as LegacySort);
	const fq = [...new Set([...(opts.fq ? [opts.fq] : []), ...url.searchParams.getAll("fq")])];
	const _from = page * count;
	const _to = (page + 1) * count - 1;

	const allPageTypes = await pageTypesFromPathname(maybeTerm);
	const pageTypes = getValidTypesFromPageTypes(allPageTypes);
	const pageType: PageType = pageTypes.at(-1) || pageTypes[0];

	const missingParams = typeof maybeMap !== "string" || !maybeTerm;
	const [map, term] =
		missingParams && fq.length > 0
			? ["", ""]
			: missingParams
				? getMapAndTerm(pageTypes)
				: [maybeMap, maybeTerm];

	const isPage = pageTypes.length > 0;
	const hasFilters = fq.length > 0 || !map;
	const ftFallback = getTermFallback(url, isPage, hasFilters);
	const ft = opts.ft || url.searchParams.get("ft") || url.searchParams.get("q") || ftFallback;
	const isInSearchFormat = ft;

	if (!isPage && !hasFilters && !isInSearchFormat) return null;

	const fmap = url.searchParams.get("fmap") ?? map;
	const sc = salesChannelParam();
	const searchBase: Record<string, string | string[] | number | undefined> = {
		_from,
		_to,
		O,
		ft: ft || undefined,
		fq: fq.length > 0 ? fq : undefined,
		map,
		sc,
	};

	const [vtexProductsResponse, vtexFacets] = await Promise.all([
		vtexFetchResponse(
			`/api/catalog_system/pub/products/search/${getTerm(term, map)}?${buildSearchParams(searchBase)}`,
		),
		vtexFetch<{
			CategoriesTrees: LegacyFacet[];
			Departments: LegacyFacet[];
			Brands: LegacyFacet[];
			SpecificationFilters: Record<string, LegacyFacet[]>;
			PriceRanges: LegacyFacet[];
		}>(
			`/api/catalog_system/pub/facets/search/${getTerm(term, fmap)}?${buildSearchParams({
				...searchBase,
				map: fmap,
			})}`,
		),
	]);

	const vtexProducts = (await vtexProductsResponse.json()) as LegacyProduct[];
	const resources = vtexProductsResponse.headers.get("resources") ?? "";
	const [, _total] = resources.split("/");

	if (vtexProducts && !Array.isArray(vtexProducts)) {
		throw new Error(`Error while fetching VTEX data ${JSON.stringify(vtexProducts)}`);
	}

	const products = vtexProducts.map((p) =>
		toProduct(p, p.items.find(getFirstItemAvailable) ?? p.items[0], 0, {
			baseUrl,
			priceCurrency,
			includeOriginalAttributes,
		}),
	);

	const currentPageTypes = !useCollectionName
		? pageTypes
		: pageTypes.map((pt) => {
				if (pt.id !== pageTypes.at(-1)?.id) return pt;
				const name =
					products?.[0]?.additionalProperty?.find(
						(property) => property.name === "cluster" && property.propertyID === pt.name,
					)?.value ?? pt.name;
				return { ...pt, name };
			});

	const getFlatCategories = (trees: LegacyFacet[]): Record<string, LegacyFacet[]> => {
		const flat: Record<string, LegacyFacet[]> = {};
		trees.forEach((cat) => (flat[cat.Name] = cat.Children || []));
		return flat;
	};

	const getCategoryFacets = (trees: LegacyFacet[], isDeptOrCat: boolean): LegacyFacet[] => {
		if (!isDeptOrCat) return [];
		for (const category of trees) {
			if (category.Id === Number(pageType?.id)) return category.Children || [];
			if (category.Children?.length) {
				const child = getCategoryFacets(category.Children, isDeptOrCat);
				if (child.length) return child;
			}
		}
		return [];
	};

	const isDeptOrCat =
		pageType?.pageType === "Department" ||
		pageType?.pageType === "Category" ||
		pageType?.pageType === "SubCategory";

	const flatCategories = !isDeptOrCat ? getFlatCategories(vtexFacets.CategoriesTrees) : {};

	const filters = Object.entries({
		Departments: vtexFacets.Departments,
		Categories: getCategoryFacets(vtexFacets.CategoriesTrees, isDeptOrCat),
		Brands: vtexFacets.Brands,
		...vtexFacets.SpecificationFilters,
		PriceRanges: vtexFacets.PriceRanges,
		...flatCategories,
	})
		.flatMap(([name, facets]) =>
			legacyFacetToFilter(
				name,
				facets,
				url,
				map,
				term,
				filtersBehavior,
				ignoreCaseSelected,
				name === "Categories",
			),
		)
		.filter((x): x is Filter => Boolean(x));

	const itemListElement = pageTypesToBreadcrumbList(pageTypes, baseUrl);
	const totalRecords = parseInt(_total, 10);
	const hasMoreResources = _to < totalRecords - 1;
	const hasNextPage = page < MAX_ALLOWED_PAGES && hasMoreResources;
	const hasPreviousPage = page > 0;

	const nextPage = new URLSearchParams(url.searchParams);
	const previousPage = new URLSearchParams(url.searchParams);
	if (hasNextPage) nextPage.set("page", String(page + currentPageOffset + 1));
	if (hasPreviousPage) previousPage.set("page", String(page + currentPageOffset - 1));

	const currentPage = page + currentPageOffset;

	return {
		"@type": "ProductListingPage",
		breadcrumb: {
			"@type": "BreadcrumbList",
			itemListElement,
			numberOfItems: itemListElement.length,
		},
		filters,
		products,
		pageInfo: {
			nextPage: hasNextPage ? `${url.pathname}?${nextPage.toString()}` : undefined,
			previousPage: hasPreviousPage ? `${url.pathname}?${previousPage.toString()}` : undefined,
			currentPage,
			records: totalRecords,
			recordPerPage: count,
			pageTypes: allPageTypes.map(parsePageType),
		},
		sortOptions: LEGACY_SORT_OPTIONS.map((o) => ({ ...o })),
		seo: pageTypesToSeo(currentPageTypes, baseUrl, hasPreviousPage ? currentPage : undefined),
	};
}

// ---------------------------------------------------------------------------
// legacySuggestions
// ---------------------------------------------------------------------------

export interface LegacySuggestionsOptions {
	query?: string;
	/** Max results. Defaults to 4. */
	count?: number;
}

interface AutocompleteItem {
	productId: string;
	itemId: string;
	name: string;
	nameComplete: string;
	imageUrl: string;
}

interface AutocompleteResult {
	name: string;
	href: string;
	items: AutocompleteItem[];
}

interface AutocompleteResponse {
	itemsReturned: AutocompleteResult[];
}

/**
 * Fetch legacy autocomplete/search suggestions.
 *
 * @see https://developers.vtex.com/docs/api-reference/search-api#get-/buscaautocomplete
 * Ported from: vtex/loaders/legacy/suggestions.ts
 */
export async function legacySuggestions(
	opts: LegacySuggestionsOptions = {},
): Promise<Suggestion | null> {
	const { count = 4, query } = opts;

	const params = new URLSearchParams({
		maxRows: String(count),
		productNameContains: encodeURIComponent(query ?? ""),
		suggestionsStack: "",
	});

	const { salesChannel } = getVtexConfig();
	if (salesChannel) params.set("sc", salesChannel);

	const suggestions = await vtexFetch<AutocompleteResponse>(`/buscaautocomplete?${params}`);

	const searches: Suggestion["searches"] = suggestions.itemsReturned
		.filter(({ items }) => !items?.length)
		.map(({ name, href }) => ({ term: name, href }));

	const products: Suggestion["products"] = suggestions.itemsReturned
		.filter(({ items }) => !!items.length)
		.map(({ items: [{ productId, itemId, imageUrl, name, nameComplete }], href }): Product => {
			const parsedUrl = new URL(href, "https://placeholder.com");
			return {
				"@type": "Product",
				productID: itemId,
				sku: itemId,
				inProductGroupWithID: productId,
				isVariantOf: {
					"@type": "ProductGroup",
					name: nameComplete,
					url: parsedUrl.pathname,
					hasVariant: [],
					additionalProperty: [],
					productGroupID: productId,
				},
				image: [{ "@type": "ImageObject", url: imageUrl }],
				name,
				url: parsedUrl.pathname + parsedUrl.search + parsedUrl.hash,
			};
		});

	return { searches, products };
}

// ---------------------------------------------------------------------------
// Short aliases — sites use invoke.vtex.loaders.legacy.productDetailsPage()
// ---------------------------------------------------------------------------

export {
	legacyProductDetailsPage as productDetailsPage,
	legacyProductList as productList,
	legacyProductListingPage as productListingPage,
	legacySuggestions as suggestions,
};
