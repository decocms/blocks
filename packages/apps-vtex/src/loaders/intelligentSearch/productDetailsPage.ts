/**
 * PDP loader using Legacy Catalog API + shared transform pipeline.
 * Maps VTEX catalog response to schema.org ProductDetailsPage
 * following the same pattern as deco-cx/apps.
 */

import type { ProductDetailsPage } from "@decocms/apps-commerce/types";
import { getVtexConfig, vtexCachedFetch } from "../../client";
import { searchBySlug } from "../../utils/slugCache";
import { pickSku, toProductPage } from "../../utils/transform";
import type { LegacyProduct } from "../../utils/types";

export interface PDPProps {
	slug?: string;
	skuId?: string;
	/** When true, PDP pages with ?skuId remain indexable */
	indexingSkus?: boolean;
	/** Use product.description instead of metaTagDescription for SEO */
	preferDescription?: boolean;
	/**
	 * Use lean variant transform for hasVariant[]. Defaults to false on PDPs:
	 * variant selectors need image[] and real inventoryLevel to render thumbnails
	 * and per-SKU stock state, so a full toProduct(level=1) is the safe default.
	 * Opt-in only if payload size becomes a problem.
	 */
	leanVariants?: boolean;
	/** When leanVariants is true, still include image[0] on each variant. Default true. */
	variantIncludeImage?: boolean;
	/** When leanVariants is true, still include inventoryLevel on each variant. Default true. */
	variantIncludeInventory?: boolean;
}

export default async function vtexProductDetailsPage(
	props: PDPProps,
): Promise<ProductDetailsPage | null> {
	const {
		slug,
		skuId,
		indexingSkus,
		preferDescription,
		leanVariants = false,
		variantIncludeImage = true,
		variantIncludeInventory = true,
	} = props;
	if (!slug) return null;

	try {
		const linkText = slug.replace(/\/p$/, "").replace(/^\//, "").toLowerCase();
		const config = getVtexConfig();
		const sc = config.salesChannel;

		const products = await searchBySlug(linkText);

		if (!products || products.length === 0) {
			return null;
		}

		const product = products[0];
		const baseUrl = config.publicUrl
			? `https://${config.publicUrl}`
			: `https://${config.account}.vtexcommercestable.${config.domain ?? "com.br"}`;

		const sku = pickSku(product, skuId);

		const kitItems: LegacyProduct[] =
			Array.isArray(sku.kitItems) && sku.kitItems.length > 0
				? ((await vtexCachedFetch<LegacyProduct[]>(
						`/api/catalog_system/pub/products/search/?fq=${sku.kitItems.map((item: any) => `skuId:${item.itemId}`).join("&fq=")}&_from=0&_to=49${sc ? `&sc=${sc}` : ""}`,
					)) ?? [])
				: [];

		const page = toProductPage(product, sku, kitItems, {
			baseUrl,
			priceCurrency: "BRL",
			leanVariants,
			variantIncludeImage,
			variantIncludeInventory,
		});

		return {
			...page,
			seo: {
				title: product.productTitle || product.productName,
				description: preferDescription
					? product.description
					: product.metaTagDescription || product.description?.substring(0, 160) || "",
				canonical: `/${product.linkText}/p`,
				noIndexing: indexingSkus ? false : !!skuId,
			},
		};
	} catch (error) {
		console.error("[VTEX] PDP error:", error);
		return null;
	}
}
