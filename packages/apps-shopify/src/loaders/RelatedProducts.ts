import type { Product } from "@decocms/apps-commerce/types";
import { getShopifyClient } from "../client";
import { GetProduct, ProductRecommendations } from "../utils/storefront/queries";
import { type ProductShopify, toProduct } from "../utils/transform";
import type { LanguageContextArgs, Metafield } from "../utils/types";
import { parseProductSlug } from "../utils/utils";

export interface Props extends LanguageContextArgs {
	slug: string;
	count?: number;
	metafields?: Metafield[];
}

export default async function relatedProductsLoader(
	props: Props,
	url?: URL,
): Promise<Product[] | null> {
	const client = getShopifyClient();
	const { slug, count = 10, metafields = [], languageCode, countryCode } = props;

	const { handle } = parseProductSlug(slug);

	const productData = await client.query<{ product?: ProductShopify }>(GetProduct, {
		handle,
		identifiers: metafields,
		languageCode,
		countryCode,
	});

	if (!productData?.product) return [];

	const data = await client.query<{
		productRecommendations?: ProductShopify[];
	}>(ProductRecommendations, {
		productId: productData.product.id,
		identifiers: metafields,
		languageCode,
		countryCode,
	});

	if (!data?.productRecommendations) return [];

	const baseUrl = url ?? new URL("https://localhost");

	return data.productRecommendations
		.map((p) => toProduct(p, p.variants.nodes[0], baseUrl))
		.slice(0, count);
}
