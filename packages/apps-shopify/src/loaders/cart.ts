import { getShopifyClient } from "../client";
import { getCartCookie, setCartCookie } from "../utils/cart";
import { CreateCart, GetCart } from "../utils/storefront/queries";

export interface CartLine {
	id: string;
	quantity: number;
	merchandise: {
		id: string;
		title: string;
		image?: { url: string; altText?: string | null } | null;
		product: { title: string; handle: string; onlineStoreUrl?: string | null };
		price: { amount: string; currencyCode: string };
	};
	discountAllocations?: Array<{
		code?: string;
		discountedAmount?: { amount: string; currencyCode: string };
	}>;
	cost?: {
		totalAmount: { amount: string; currencyCode: string };
		subtotalAmount: { amount: string; currencyCode: string };
		amountPerQuantity?: { amount: string; currencyCode: string };
		compareAtAmountPerQuantity?: { amount: string; currencyCode: string } | null;
	};
}

export interface ShopifyCart {
	id: string;
	checkoutUrl: string;
	totalQuantity: number;
	lines: { nodes: CartLine[] };
	cost: {
		totalTaxAmount?: { amount: string; currencyCode: string };
		subtotalAmount: { amount: string; currencyCode: string };
		totalAmount: { amount: string; currencyCode: string };
		checkoutChargeAmount?: { amount: string; currencyCode: string };
	};
	discountCodes?: Array<{ applicable: boolean; code: string }>;
	discountAllocations?: Array<{
		discountedAmount: { amount: string; currencyCode: string };
	}>;
}

export async function getCart(
	requestHeaders: Headers,
	responseHeaders?: Headers,
): Promise<ShopifyCart | null> {
	const client = getShopifyClient();
	const maybeCartId = getCartCookie(requestHeaders);

	const cartId =
		maybeCartId ??
		(await client
			.query<{ payload?: { cart?: { id: string } } }>(CreateCart)
			.then((data) => data.payload?.cart?.id));

	if (!cartId) throw new Error("Missing cart id");

	const cart = await client
		.query<{ cart?: ShopifyCart }>(GetCart, { id: decodeURIComponent(cartId) })
		.then((data) => data.cart ?? null);

	if (responseHeaders) {
		setCartCookie(responseHeaders, cartId);
	}

	return cart;
}

export async function createCart(): Promise<string | null> {
	const client = getShopifyClient();
	const data = await client.query<{ payload?: { cart?: { id: string } } }>(CreateCart);
	return data?.payload?.cart?.id ?? null;
}
