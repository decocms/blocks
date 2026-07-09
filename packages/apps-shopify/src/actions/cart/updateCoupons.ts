import { getShopifyClient } from "../../client";
import type { ShopifyCart } from "../../loaders/cart";
import { getCartCookie, setCartCookie } from "../../utils/cart";
import { AddCoupon } from "../../utils/storefront/queries";

export interface UpdateCouponsProps {
	discountCodes: string[];
	requestHeaders: Headers;
	responseHeaders?: Headers;
}

export default async function updateCoupons({
	discountCodes,
	requestHeaders,
	responseHeaders,
}: UpdateCouponsProps): Promise<ShopifyCart | null> {
	const client = getShopifyClient();
	const cartId = getCartCookie(requestHeaders);

	if (!cartId) throw new Error("Missing cart cookie");

	const data = await client.query<{
		payload?: { cart?: ShopifyCart };
	}>(AddCoupon, { cartId, discountCodes });

	if (responseHeaders) {
		setCartCookie(responseHeaders, cartId);
	}

	return data.payload?.cart ?? null;
}
