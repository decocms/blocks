import { getShopifyClient } from "../../client";
import type { ShopifyCart } from "../../loaders/cart";
import { getCartCookie, setCartCookie } from "../../utils/cart";
import { UpdateItems } from "../../utils/storefront/queries";

export interface UpdateItemsProps {
	lines: Array<{ id: string; quantity: number }>;
	requestHeaders: Headers;
	responseHeaders?: Headers;
}

export default async function updateItems({
	lines,
	requestHeaders,
	responseHeaders,
}: UpdateItemsProps): Promise<ShopifyCart | null> {
	const client = getShopifyClient();
	const cartId = getCartCookie(requestHeaders);

	if (!cartId) throw new Error("Missing cart cookie");

	const data = await client.query<{
		payload?: { cart?: ShopifyCart };
	}>(UpdateItems, { cartId, lines });

	if (responseHeaders) {
		setCartCookie(responseHeaders, cartId);
	}

	return data.payload?.cart ?? null;
}
