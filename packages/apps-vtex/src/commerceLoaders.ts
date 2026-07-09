/**
 * Standard VTEX commerce loader map factory for CMS block resolution.
 *
 * Wraps all VTEX loaders with createCachedLoader, applies universal
 * workarounds (slug fallback, IS sort sanitization, map=productClusterIds),
 * and registers both `.ts` and `.ts`-less aliases.
 *
 * Sites call `createVtexCommerceLoaders()` instead of manually wiring ~30
 * individual loader entries. Site-specific loaders are merged via `extra`.
 */

import { createCachedLoader } from "@decocms/blocks/sdk/cachedLoader";
import type { CacheProfileName } from "@decocms/blocks/sdk/cacheHeaders";
import { getCategoryTree } from "./loaders/catalog";
import vtexProductDetailsPage from "./loaders/intelligentSearch/productDetailsPage";
import vtexProductListShelf from "./loaders/intelligentSearch/productList";
import vtexProductListingPage from "./loaders/intelligentSearch/productListingPage";
import vtexSuggestions from "./loaders/intelligentSearch/suggestions";
import vtexRelatedProducts from "./loaders/legacy/relatedProductsLoader";
import vtexProductList from "./loaders/productListFull";
import vtexWorkflowProducts from "./loaders/workflow/products";
import { VALID_IS_SORTS } from "./utils/intelligentSearch";

export type CommerceLoaderFn = (props: any) => Promise<any>;

export interface VtexCommerceLoadersOptions {
	/** Override cache profiles per loader type. */
	cacheProfiles?: {
		listing?: CacheProfileName;
		product?: CacheProfileName;
		search?: CacheProfileName;
		static?: CacheProfileName;
	};
	/** Additional loaders to merge into the map (site-specific). */
	extra?: Record<string, CommerceLoaderFn>;
}

/**
 * Bridge __pagePath → slug when CMS doesn't set slug explicitly.
 * VTEX PDP pages receive __pagePath (e.g. "/produto-slug/p") but the
 * inline loader only reads the `slug` field.
 */
function pdpWithSlugFallback(props: any): Promise<any> {
	if ((!props.slug || props.slug.length === 0) && props.__pagePath) {
		props = { ...props, slug: props.__pagePath };
	}
	return vtexProductDetailsPage(props);
}

/**
 * Extract collection name from PLP product data.
 * Products carry cluster info in additionalProperty with name="cluster".
 */
function extractCollectionName(result: any, collectionId: string): string | null {
	if (!result?.products?.length) return null;
	for (const product of result.products) {
		const props = product.additionalProperty || product.isVariantOf?.additionalProperty || [];
		for (const prop of props) {
			if (prop.name === "cluster" && prop.propertyID === collectionId) {
				return prop.value || null;
			}
		}
	}
	return null;
}

/**
 * Returns the standard VTEX commerce loader map for CMS resolution.
 *
 * Includes all Intelligent Search, legacy, category tree, and navbar loaders
 * with SWR caching. Also registers `.ts`-less aliases for invoke compatibility.
 *
 * @example
 * ```ts
 * import { createVtexCommerceLoaders } from "@decocms/apps/vtex/commerceLoaders";
 *
 * const COMMERCE_LOADERS = {
 *   ...createVtexCommerceLoaders(),
 *   // site-specific only:
 *   "site/loaders/myCustomLoader": async (props) => { ... },
 * };
 * registerCommerceLoaders(COMMERCE_LOADERS);
 * ```
 */
export function createVtexCommerceLoaders(
	options?: VtexCommerceLoadersOptions,
): Record<string, CommerceLoaderFn> {
	const profiles = {
		listing: options?.cacheProfiles?.listing ?? "listing",
		product: options?.cacheProfiles?.product ?? "product",
		search: options?.cacheProfiles?.search ?? "search",
		static: options?.cacheProfiles?.static ?? "static",
	};

	const _cachedProductList = createCachedLoader(
		"vtex/productList",
		vtexProductList,
		profiles.listing,
	);
	const cachedProductListShelf = createCachedLoader(
		"vtex/productListShelf",
		vtexProductListShelf,
		profiles.listing,
	);
	const cachedPDP = createCachedLoader(
		"vtex/productDetailsPage",
		pdpWithSlugFallback,
		profiles.product,
	);
	const _cachedPLP = createCachedLoader(
		"vtex/productListingPage",
		vtexProductListingPage,
		profiles.listing,
	);
	const cachedSuggestions = createCachedLoader(
		"vtex/suggestions",
		vtexSuggestions,
		profiles.search,
	);
	const cachedRelatedProducts = createCachedLoader(
		"vtex/relatedProducts",
		vtexRelatedProducts,
		profiles.product,
	);
	const cachedWorkflowProducts = createCachedLoader(
		"vtex/workflowProducts",
		vtexWorkflowProducts,
		profiles.listing,
	);

	/**
	 * PLP wrapper: handles `map=productClusterIds` legacy URLs and sanitizes
	 * IS sort parameters that would cause VTEX API 400 errors.
	 */
	const cachedPLP: CommerceLoaderFn = async (props) => {
		if (props.__pageUrl && !props.selectedFacets?.length) {
			try {
				const pageUrl = new URL(props.__pageUrl, "https://localhost");
				const mapParam = pageUrl.searchParams.get("map");
				if (mapParam && props.__pagePath) {
					const segments = props.__pagePath.split("/").filter(Boolean);
					const mapValues = mapParam.split(",");
					const facets: Array<{ key: string; value: string }> = [];
					for (let i = 0; i < Math.min(segments.length, mapValues.length); i++) {
						const key = mapValues[i].trim();
						const value = decodeURIComponent(segments[i]);
						if (key && value) facets.push({ key, value });
					}
					if (facets.length) {
						const rawSort = pageUrl.searchParams.get("sort") ?? "";
						const cleanSort = VALID_IS_SORTS.has(rawSort) ? rawSort : "";

						if (rawSort !== cleanSort) {
							if (cleanSort) {
								pageUrl.searchParams.set("sort", cleanSort);
							} else {
								pageUrl.searchParams.delete("sort");
							}
						}

						const result = await _cachedPLP({
							...props,
							selectedFacets: facets,
							sort: cleanSort || undefined,
							__pageUrl: pageUrl.toString(),
						});

						const clusterFacet = facets.find((f) => f.key === "productClusterIds");
						if (result && clusterFacet) {
							const collectionName = extractCollectionName(result, clusterFacet.value);
							if (collectionName) {
								result.breadcrumb = {
									"@type": "BreadcrumbList",
									itemListElement: [
										{
											"@type": "ListItem",
											name: collectionName,
											item: props.__pagePath || "/",
											position: 1,
										},
									],
									numberOfItems: 1,
								};
								result.seo = { ...result.seo, title: collectionName };
							}
						}
						return result;
					}
				}
			} catch (e) {
				console.error("[PLP] Error parsing map param:", e);
			}
		}
		return _cachedPLP(props);
	};

	/**
	 * Related products wrapper: extracts slug from __pagePath when the CMS
	 * requestToParam stub returns null (standard in TanStack sites).
	 */
	const relatedWithSlugFallback: CommerceLoaderFn = (props) => {
		if (!props.slug && props.__pagePath) {
			const path = props.__pagePath.replace(/\/p$/, "").replace(/^\//, "");
			props = { ...props, slug: path };
		}
		return cachedRelatedProducts(props);
	};

	const loaders: Record<string, CommerceLoaderFn> = {
		// Intelligent Search loaders
		"vtex/loaders/intelligentSearch/productListingPage.ts": cachedPLP,
		"vtex/loaders/intelligentSearch/productList.ts": cachedProductListShelf,
		"vtex/loaders/intelligentSearch/productDetailsPage.ts": cachedPDP,
		"vtex/loaders/intelligentSearch/suggestions.ts": cachedSuggestions,
		// Legacy loaders (map to same cached functions)
		"vtex/loaders/legacy/productDetailsPage.ts": cachedPDP,
		"vtex/loaders/legacy/productList.ts": cachedProductListShelf,
		"vtex/loaders/legacy/relatedProductsLoader.ts": relatedWithSlugFallback,
		// Workflow
		"vtex/loaders/workflow/products.ts": cachedWorkflowProducts,
		// Top-level aliases (used by some CMS block configs)
		"vtex/loaders/ProductList.ts": cachedProductListShelf,
		"vtex/loaders/ProductDetailsPage.ts": cachedPDP,
		"vtex/loaders/ProductListingPage.ts": cachedPLP,
		// Category tree
		"vtex/loaders/categories/tree": (props: any) => getCategoryTree(props?.categoryLevels ?? 3),
		// Commerce passthrough loaders
		"commerce/loaders/navbar.ts": async (props: any) => props.items ?? [],
		"commerce/loaders/product/extensions/detailsPage.ts": async (props: any) => {
			const data = props.data;
			if (data?.product) return data;
			return cachedPDP({ __pagePath: props.__pagePath });
		},
		// requestToParam stub — unresolvable in TanStack, pdpWithSlugFallback bridges it
		"website/functions/requestToParam.ts": async () => null,
	};

	// Register .ts-less aliases for invoke compatibility
	const withAliases: Record<string, CommerceLoaderFn> = { ...loaders };
	for (const key of Object.keys(loaders)) {
		if (key.endsWith(".ts")) {
			withAliases[key.slice(0, -3)] = loaders[key];
		}
	}

	if (options?.extra) {
		Object.assign(withAliases, options.extra);
	}

	return withAliases;
}

/**
 * Exposes the cached PDP loader for site-specific section loaders that need
 * to call it directly (e.g. ProductDescription fallback).
 *
 * Returns a new instance each call — sites should cache the reference.
 */
export function createCachedPDPLoader(profile: CacheProfileName = "product"): CommerceLoaderFn {
	return createCachedLoader("vtex/productDetailsPage", pdpWithSlugFallback, profile);
}
