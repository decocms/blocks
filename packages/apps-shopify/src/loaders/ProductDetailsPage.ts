import type { ProductDetailsPage } from "@decocms/apps-commerce/types";
import { getShopifyClient } from "../client";
import { GetProduct } from "../utils/storefront/queries";
import { type ProductShopify, toProductPage } from "../utils/transform";
import type { Metafield } from "../utils/types";

export interface Props {
	slug: string;
	metafields?: Metafield[];
}

export default async function productDetailsPageLoader(
	props: Props,
	url?: URL,
): Promise<ProductDetailsPage | null> {
	const client = getShopifyClient();
	const { slug, metafields = [] } = props;

	const splitted = slug?.split("-") ?? [];
	const maybeSkuId = Number(splitted[splitted.length - 1]);
	const handle = splitted.slice(0, maybeSkuId ? -1 : undefined).join("-");

	const data = await client.query<{ product?: ProductShopify }>(GetProduct, {
		handle,
		identifiers: metafields,
	});

	if (!data?.product) return null;

	return toProductPage(data.product, url ?? new URL("https://localhost"), maybeSkuId || undefined);
}
