import { getShopifyClient } from "../../client";
import type { ShopifyCart } from "../../loaders/cart";
import { getCartCookie, setCartCookie } from "../../utils/cart";
import { AddItemToCart } from "../../utils/storefront/queries";

export interface AddItemProps {
	lines: {
		merchandiseId: string;
		attributes?: Array<{ key: string; value: string }>;
		quantity?: number;
		sellingPlanId?: string;
	};
	requestHeaders: Headers;
	responseHeaders?: Headers;
}

export default async function addItems({
	lines,
	requestHeaders,
	responseHeaders,
}: AddItemProps): Promise<ShopifyCart | null> {
	const client = getShopifyClient();
	const cartId = getCartCookie(requestHeaders);

	if (!cartId) throw new Error("Missing cart cookie");

	const data = await client.query<{
		payload?: { cart?: ShopifyCart };
	}>(AddItemToCart, { cartId, lines });

	if (responseHeaders) {
		setCartCookie(responseHeaders, cartId);
	}

	return data.payload?.cart ?? null;
}
