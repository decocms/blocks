import { getShopifyClient } from "../client";
import { GetShopInfo } from "../utils/storefront/queries";
import type { Metafield } from "../utils/types";

export interface Shop {
	name: string;
	description?: string;
	privacyPolicy?: { title: string; body: string };
	refundPolicy?: { title: string; body: string };
	shippingPolicy?: { title: string; body: string };
	subscriptionPolicy?: { title: string; body: string };
	termsOfService?: { title: string; body: string };
	metafields?: Array<{
		description?: string | null;
		key: string;
		namespace: string;
		type: string;
		value: string;
		reference?: { image?: { url: string } } | null;
		references?: { edges: Array<{ node: { image?: { url: string } } }> } | null;
	} | null>;
}

export interface Props {
	metafields?: Metafield[];
}

export default async function shopLoader(props?: Props): Promise<Shop> {
	const client = getShopifyClient();
	const metafields = props?.metafields || [];

	const data = await client.query<{ shop: Shop }>(GetShopInfo, { identifiers: metafields });

	return data.shop;
}
