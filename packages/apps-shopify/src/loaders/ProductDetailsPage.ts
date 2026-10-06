import type { ProductDetailsPage } from "@decocms/apps-commerce/types";
import { getShopifyClient } from "../client";
import { GetProduct } from "../utils/storefront/queries";
import { type ProductShopify, toProductPage } from "../utils/transform";
import type { LanguageContextArgs, Metafield } from "../utils/types";
import { parseProductSlug } from "../utils/utils";

export interface Props extends LanguageContextArgs {
	slug: string;
	metafields?: Metafield[];
}

export default async function productDetailsPageLoader(
	props: Props,
	url?: URL,
): Promise<ProductDetailsPage | null> {
	const client = getShopifyClient();
	const { slug, metafields = [], languageCode, countryCode } = props;

	const { handle, skuId: maybeSkuId } = parseProductSlug(slug);

	const data = await client.query<{ product?: ProductShopify }>(GetProduct, {
		handle,
		identifiers: metafields,
		languageCode,
		countryCode,
	});

	if (!data?.product) return null;

	return toProductPage(data.product, url ?? new URL("https://localhost"), maybeSkuId);
}
