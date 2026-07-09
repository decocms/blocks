/**
 * Product Extension Pipeline.
 *
 * Composable middleware-style pipeline to enrich products after the
 * initial search/catalog fetch. Covers real-time price simulation
 * (for B2B/promotional pricing) and wishlist annotation.
 *
 * @example
 * ```ts
 * import {
 *   createProductPipeline,
 *   withSimulation,
 *   withWishlist,
 * } from "@decocms/apps/vtex/utils/enrichment";
 *
 * const enrich = createProductPipeline(
 *   withSimulation(),
 *   withWishlist(),
 * );
 *
 * const products = await vtexProductList(props);
 * const enriched = await enrich(products, { request });
 * ```
 */

import type { Product, ProductLeaf } from "@decocms/apps-commerce/types";
import { getVtexConfig, vtexFetch, vtexIOGraphQL } from "../client";
import { listBrands } from "../loaders/brands";
import { batch } from "./batch";
import { withIsSimilarTo } from "./similars";
import { pickSku, toInventories, toProduct, toReview } from "./transform";
import type { LegacyProduct } from "./types";
import { buildAuthCookieHeader, VTEX_AUTH_COOKIE } from "./vtexId";

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

/** VTEX prices come in cents — divide by this to get the currency value. */
const CENTS_DIVISOR = 100;

/** Default number of products per simulation API call. */
const DEFAULT_SIMULATION_BATCH_SIZE = 50;

/** Maximum wishlist items to fetch in a single query. */
const WISHLIST_MAX_ITEMS = 500;

/** Batch size for kit-item product lookups. */
const KIT_ITEMS_BATCH_SIZE = 10;

/** Batch size for variant product lookups. */
const VARIANTS_BATCH_SIZE = 15;

/** Number of reviews to fetch per product. */
const REVIEWS_PAGE_SIZE = 10;

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export interface EnrichmentContext {
	/** The incoming HTTP request (for cookies, auth tokens). */
	request?: Request;
	/** Sales channel override. */
	salesChannel?: string;
}

/**
 * A product enricher takes a list of products and returns an enriched list.
 * Enrichers are composed via `createProductPipeline`.
 */
export type ProductEnricher = (products: Product[], ctx: EnrichmentContext) => Promise<Product[]>;

// -------------------------------------------------------------------------
// Pipeline
// -------------------------------------------------------------------------

/**
 * Compose multiple enrichers into a single pipeline.
 *
 * Enrichers run sequentially -- each receives the output of the previous.
 * This is intentional: some enrichers depend on previous enrichments
 * (e.g., wishlist may need SKU IDs added by simulation).
 */
export function createProductPipeline(...enrichers: ProductEnricher[]): ProductEnricher {
	return async (products, ctx) => {
		if (!products.length) return products;

		let result = products;
		for (const enricher of enrichers) {
			try {
				result = await enricher(result, ctx);
			} catch (error) {
				console.error(
					`[ProductPipeline] Enricher failed, continuing with unenriched data:`,
					error instanceof Error ? error.message : error,
				);
			}
		}
		return result;
	};
}

// -------------------------------------------------------------------------
// Simulation Enricher
// -------------------------------------------------------------------------

interface SimulationItem {
	itemIndex: number;
	id: string;
	quantity: number;
	seller: string;
}

interface SimulationResult {
	items: Array<{
		itemIndex: number;
		listPrice: number;
		sellingPrice: number;
		price: number;
		availability: string;
		quantity: number;
	}>;
}

/**
 * Enrich products with real-time prices from VTEX simulation API.
 *
 * The search index may have stale prices. Simulation returns the
 * actual price the user would pay, accounting for promotions,
 * trade policies, price tables, and regional pricing.
 *
 * @param options.batchSize - Max products per simulation call. @default 50
 */
export function withSimulation(options?: { batchSize?: number }): ProductEnricher {
	const batchSize = options?.batchSize ?? DEFAULT_SIMULATION_BATCH_SIZE;

	return async (products, ctx) => {
		const config = getVtexConfig();
		const sc = ctx.salesChannel ?? config.salesChannel ?? "1";

		const skuItems: SimulationItem[] = [];
		const skuToProductIndex = new Map<string, { productIdx: number; offerIdx: number }>();

		for (let pi = 0; pi < products.length; pi++) {
			const product = products[pi];
			const aggOffer = product.offers;
			if (!aggOffer?.offers) continue;

			for (let oi = 0; oi < aggOffer.offers.length; oi++) {
				const offer = aggOffer.offers[oi];
				const skuId = product.sku ?? product.productID;
				const seller = offer.seller ?? "1";

				if (skuId) {
					skuItems.push({
						itemIndex: skuItems.length,
						id: skuId,
						quantity: 1,
						seller,
					});
					skuToProductIndex.set(`${skuId}-${seller}`, {
						productIdx: pi,
						offerIdx: oi,
					});
				}
			}
		}

		if (!skuItems.length) return products;

		const result = [...products];
		const batches: SimulationItem[][] = [];
		for (let i = 0; i < skuItems.length; i += batchSize) {
			batches.push(skuItems.slice(i, i + batchSize));
		}

		for (const batch of batches) {
			try {
				const sim = await vtexFetch<SimulationResult>(
					`/api/checkout/pub/orderForms/simulation?sc=${sc}&RnbBehavior=1`,
					{
						method: "POST",
						body: JSON.stringify({
							items: batch,
							country: config.country ?? "BRA",
						}),
					},
				);

				for (const simItem of sim.items) {
					const original = batch[simItem.itemIndex];
					if (!original) continue;

					const key = `${original.id}-${original.seller}`;
					const mapping = skuToProductIndex.get(key);
					if (!mapping) continue;

					const product = { ...result[mapping.productIdx] };
					const aggOffer = product.offers;
					if (!aggOffer) continue;

					const offers = [...aggOffer.offers];
					const offer = { ...offers[mapping.offerIdx] };

					offer.price = simItem.sellingPrice / CENTS_DIVISOR;
					if (simItem.listPrice) {
						(offer as any).priceSpecification = [
							...(Array.isArray((offer as any).priceSpecification)
								? (offer as any).priceSpecification
								: []),
						].map((spec: any) => {
							if (spec?.priceType === "https://schema.org/ListPrice") {
								return { ...spec, price: simItem.listPrice / CENTS_DIVISOR };
							}
							if (spec?.priceType === "https://schema.org/SalePrice") {
								return { ...spec, price: simItem.sellingPrice / CENTS_DIVISOR };
							}
							return spec;
						});
					}
					offer.availability =
						simItem.availability === "available"
							? "https://schema.org/InStock"
							: "https://schema.org/OutOfStock";

					offers[mapping.offerIdx] = offer;
					product.offers = { ...aggOffer, offers };
					result[mapping.productIdx] = product;
				}
			} catch (error) {
				console.error("[Simulation] Batch failed:", error instanceof Error ? error.message : error);
			}
		}

		return result;
	};
}

// -------------------------------------------------------------------------
// Wishlist Enricher
// -------------------------------------------------------------------------

const WISHLIST_QUERY = `query GetWishlist($shopperId: String!, $name: String!, $from: Int!, $to: Int!) {
  viewList(shopperId: $shopperId, name: $name, from: $from, to: $to)
    @context(provider: "vtex.wish-list@1.x") {
    data {
      id
      productId
      sku
    }
  }
}`;

interface WishlistData {
	viewList: {
		data: Array<{ id: string; productId: string; sku: string }> | null;
	};
}

function getCookieValue(cookieHeader: string, name: string): string | null {
	const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
	return match?.[1] ?? null;
}

/**
 * Enrich products with wishlist status.
 *
 * Reads the user's wishlist and adds `isInWishlist: true` as an
 * additionalProperty on products that are wishlisted.
 *
 * Requires the user to be logged in (reads VtexIdclientAutCookie).
 * For anonymous users, this is a no-op.
 */
export function withWishlist(): ProductEnricher {
	return async (products, ctx) => {
		if (!ctx.request) return products;

		const cookies = ctx.request.headers.get("cookie") ?? "";
		const authCookie = getCookieValue(cookies, VTEX_AUTH_COOKIE);
		if (!authCookie) return products;

		let email: string | undefined;
		try {
			const parts = authCookie.split(".");
			if (parts.length === 3) {
				const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
				email = payload.sub ?? payload.userId;
			}
		} catch {
			return products;
		}

		if (!email) return products;

		try {
			const data = await vtexIOGraphQL<WishlistData>(
				{
					query: WISHLIST_QUERY,
					variables: { shopperId: email, name: "Wishlist", from: 0, to: WISHLIST_MAX_ITEMS },
				},
				{ Cookie: buildAuthCookieHeader(authCookie, getVtexConfig().account) },
			);

			const wishlistItems = data.viewList?.data ?? [];
			const wishlistSkus = new Set(wishlistItems.map((i) => i.sku));
			const wishlistProductIds = new Set(wishlistItems.map((i) => i.productId));

			return products.map((product) => {
				const isWishlisted =
					(product.sku && wishlistSkus.has(product.sku)) ||
					(product.productID && wishlistProductIds.has(product.productID));

				if (!isWishlisted) return product;

				return {
					...product,
					additionalProperty: [
						...(product.additionalProperty ?? []),
						{
							"@type": "PropertyValue" as const,
							name: "isInWishlist",
							value: "true",
							propertyID: "WISHLIST",
						},
					],
				};
			});
		} catch (error) {
			console.error(
				"[Wishlist] Failed to fetch wishlist:",
				error instanceof Error ? error.message : error,
			);
			return products;
		}
	};
}

// -------------------------------------------------------------------------
// Similars Enricher
// -------------------------------------------------------------------------

/**
 * Enrich products with similar product data from Legacy Catalog API.
 * Ported from deco-cx/apps vtex/loaders/product/extend.ts (similarsExt)
 */
export function withSimilars(): ProductEnricher {
	return async (products) => {
		return Promise.all(products.map((p) => withIsSimilarTo(p)));
	};
}

// -------------------------------------------------------------------------
// Kit Items Enricher
// -------------------------------------------------------------------------

/**
 * Enrich products with kit item details (isAccessoryOrSparePartFor).
 * Fetches full product data for referenced accessories via Legacy Catalog.
 * Ported from deco-cx/apps vtex/loaders/product/extend.ts (kitItemsExt)
 */
export function withKitItems(): ProductEnricher {
	return async (products) => {
		const productIDs = new Set<string>();

		for (const product of products) {
			for (const item of product.isAccessoryOrSparePartFor ?? []) {
				if (item.productID) productIDs.add(item.productID);
			}
		}

		if (!productIDs.size) return products;

		const config = getVtexConfig();
		const baseUrl = config.publicUrl
			? `https://${config.publicUrl}`
			: `https://${config.account}.vtexcommercestable.${config.domain ?? "com.br"}`;

		const batches = batch([...productIDs], KIT_ITEMS_BATCH_SIZE);
		const productsById = new Map<string, ProductLeaf>();

		for (const ids of batches) {
			try {
				const fq = ids.map((id) => `productId:${id}`);
				const raw = await vtexFetch<LegacyProduct[]>(
					`/api/catalog_system/pub/products/search/?${fq.map((f) => `fq=${f}`).join("&")}&_from=0&_to=${ids.length - 1}`,
				);
				for (const p of raw) {
					const sku = pickSku(p);
					const product = toProduct(p, sku, 0, {
						baseUrl,
						priceCurrency: "BRL",
					});
					for (const leaf of product.isVariantOf?.hasVariant ?? []) {
						productsById.set(leaf.productID, leaf);
					}
				}
			} catch (e) {
				console.error("[KitItems] Batch failed:", e instanceof Error ? e.message : e);
			}
		}

		return products.map((p) => ({
			...p,
			isAccessoryOrSparePartFor: p.isAccessoryOrSparePartFor
				?.map((item) => productsById.get(item.productID))
				.filter((item): item is ProductLeaf => Boolean(item)),
		}));
	};
}

// -------------------------------------------------------------------------
// Variants Enricher
// -------------------------------------------------------------------------

/**
 * Enrich products with full variant data from Legacy Catalog.
 * When products come from IS, they may lack variant details.
 * Ported from deco-cx/apps vtex/loaders/product/extend.ts (variantsExt)
 */
export function withVariants(): ProductEnricher {
	return async (products) => {
		const productIDs = new Set<string>();
		for (const product of products) {
			if (product.productID) productIDs.add(product.productID);
		}

		if (!productIDs.size) return products;

		const config = getVtexConfig();
		const baseUrl = config.publicUrl
			? `https://${config.publicUrl}`
			: `https://${config.account}.vtexcommercestable.${config.domain ?? "com.br"}`;

		const batches = batch([...productIDs], VARIANTS_BATCH_SIZE);
		const productsById = new Map<string, Product>();

		for (const ids of batches) {
			try {
				const fq = ids.map((id) => `productId:${id}`);
				const raw = await vtexFetch<LegacyProduct[]>(
					`/api/catalog_system/pub/products/search/?${fq.map((f) => `fq=${f}`).join("&")}&_from=0&_to=${ids.length - 1}`,
				);
				for (const p of raw) {
					const sku = pickSku(p);
					const product = toProduct(p, sku, 0, {
						baseUrl,
						priceCurrency: "BRL",
					});
					productsById.set(product.productID, product);
				}
			} catch (e) {
				console.error("[Variants] Batch failed:", e instanceof Error ? e.message : e);
			}
		}

		return products.map((p) => ({
			...productsById.get(p.productID),
			...p,
			isVariantOf: productsById.get(p.productID)?.isVariantOf,
		}));
	};
}

// -------------------------------------------------------------------------
// Reviews Enricher
// -------------------------------------------------------------------------

/**
 * Enrich products with reviews and ratings from VTEX Reviews & Ratings app.
 * Ported from deco-cx/apps vtex/loaders/product/extend.ts (reviewsExt)
 */
export function withReviews(): ProductEnricher {
	return async (products) => {
		const config = getVtexConfig();
		const myHost = `${config.account}.myvtex.com`;

		const reviewPromises = products.map((product) =>
			vtexFetch<any>(
				`https://${myHost}/reviews-and-ratings/api/reviews?product_id=${product.inProductGroupWithID ?? ""}&from=0&to=${REVIEWS_PAGE_SIZE}&status=true`,
			).catch((error) => {
				console.error(
					"[Reviews] Failed for product",
					product.inProductGroupWithID,
					error instanceof Error ? error.message : error,
				);
				return {};
			}),
		);

		const ratingPromises = products.map((product) =>
			vtexFetch<any>(
				`https://${myHost}/reviews-and-ratings/api/rating/${product.inProductGroupWithID ?? ""}`,
			).catch((error) => {
				console.error(
					"[Ratings] Failed for product",
					product.inProductGroupWithID,
					error instanceof Error ? error.message : error,
				);
				return {};
			}),
		);

		const [reviews, ratings] = await Promise.all([
			Promise.all(reviewPromises),
			Promise.all(ratingPromises),
		]);

		return toReview(products, ratings, reviews);
	};
}

// -------------------------------------------------------------------------
// Inventory Enricher
// -------------------------------------------------------------------------

/**
 * Enrich products with inventory/stock data from VTEX Logistics API.
 * Ported from deco-cx/apps vtex/loaders/product/extend.ts (inventoryExt)
 */
export function withInventory(): ProductEnricher {
	return async (products) => {
		const inventories = await Promise.all(
			products.map((product) => {
				if (!product.sku) return Promise.resolve({});
				return vtexFetch<any>(`/api/logistics/pvt/inventory/skus/${product.sku}`).catch((error) => {
					console.error(
						"[Inventory] Failed for SKU",
						product.sku,
						error instanceof Error ? error.message : error,
					);
					return {};
				});
			}),
		);

		return toInventories(products, inventories);
	};
}

// -------------------------------------------------------------------------
// Brands Enricher
// -------------------------------------------------------------------------

/**
 * Enrich products with brand information from Legacy Catalog.
 * Useful for Intelligent Search results that may lack brand details.
 * Ported from deco-cx/apps vtex/loaders/product/extend.ts (brandsExt)
 */
export function withBrands(): ProductEnricher {
	return async (products) => {
		const brands = await listBrands();
		if (!brands?.length) return products;

		return products.map((p) => {
			const match = brands.find((b) => b["@id"] === p.brand?.["@id"]);
			return match ? { ...p, brand: match } : p;
		});
	};
}
