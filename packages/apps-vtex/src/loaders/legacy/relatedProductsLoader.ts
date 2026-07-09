/**
 * Related/cross-selling products loader using Legacy Catalog API + shared transform.
 * Maps VTEX catalog response to schema.org Product[] following deco-cx/apps pattern.
 *
 * Includes in-flight dedup for slug→productId resolution so multiple sections
 * on the same page (similars, suggestions, whoboughtalsobought, etc.) share a
 * single search/{slug}/p call instead of each doing their own.
 */

import type { Product } from "@decocms/apps-commerce/types";
import { getVtexConfig, vtexCachedFetch } from "../../client";
import { resolveProductIdBySlug } from "../../utils/slugCache";
import { pickSku, toProduct } from "../../utils/transform";
import type { LegacyProduct } from "../../utils/types";

export type CrossSellingType =
	| "similars"
	| "suggestions"
	| "accessories"
	| "whosawalsosaw"
	| "whosawalsobought"
	| "whoboughtalsobought"
	| "showtogether";

export interface RelatedProductsProps {
	slug?: string;
	productId?: string;
	crossSelling?: CrossSellingType;
	count?: number;
	hideUnavailableItems?: boolean;
}

function fetchCrossSelling(
	type: CrossSellingType,
	productId: string,
): Promise<LegacyProduct[] | null> {
	return vtexCachedFetch<LegacyProduct[]>(
		`/api/catalog_system/pub/products/crossselling/${type}/${productId}`,
	);
}

export default async function vtexRelatedProducts(
	props: RelatedProductsProps,
): Promise<Product[] | null> {
	const { slug, crossSelling = "similars", count = 8 } = props;

	let productId = props.productId;

	if (!productId) {
		if (!slug) return null;
		const linkText = slug.replace(/\/p$/, "").replace(/^\//, "");
		productId = (await resolveProductIdBySlug(linkText)) ?? undefined;
		if (!productId) return null;
	}

	try {
		const related = await fetchCrossSelling(crossSelling, productId);
		if (!related?.length) return [];

		const config = getVtexConfig();
		const baseUrl = config.publicUrl
			? `https://${config.publicUrl}`
			: `https://${config.account}.vtexcommercestable.${config.domain ?? "com.br"}`;

		let result = related.slice(0, count).map((p) => {
			const sku = pickSku(p);
			return toProduct(p, sku, 0, { baseUrl, priceCurrency: "BRL" });
		});

		if (props.hideUnavailableItems) {
			result = result.filter((p) =>
				p.offers?.offers?.some((o) => o.availability === "https://schema.org/InStock"),
			);
		}

		return result;
	} catch (error) {
		console.error("[VTEX] Related products error:", error);
		return null;
	}
}
