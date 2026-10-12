import { getShopifyClient } from "../client";
import { getCartCookie, setCartCookie } from "../utils/cart";
import { ShopifyGraphQLError } from "../utils/graphql";
import { CreateCart, GetCart } from "../utils/storefront/queries";
import type { LanguageContextArgs } from "../utils/types";

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
	buyerIdentity?: { countryCode?: string | null; email?: string | null };
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

const isNotFoundError = (error: unknown): boolean =>
	error instanceof ShopifyGraphQLError &&
	error.errors.some((e) => e.extensions?.code === "NOT_FOUND" || e.message === "Not Found");

const fetchCart = (cartId: string, context: LanguageContextArgs) =>
	getShopifyClient()
		.query<{ cart?: ShopifyCart }>(GetCart, {
			id: decodeURIComponent(cartId),
			languageCode: context.languageCode,
			countryCode: context.countryCode,
		})
		.then((data) => data.cart ?? null);

/**
 * Reads the cart from the cookie, creating one when missing. A cookie that
 * points to a cart Shopify no longer knows (NOT_FOUND) is replaced by a new cart.
 */
export async function getCart(
	requestHeaders: Headers,
	responseHeaders?: Headers,
	context: LanguageContextArgs = {},
): Promise<ShopifyCart | null> {
	let cartId = getCartCookie(requestHeaders) ?? (await createCart(context));

	if (!cartId) throw new Error("Missing cart id");

	let cart: ShopifyCart | null;
	try {
		cart = await fetchCart(cartId, context);
	} catch (error) {
		if (!isNotFoundError(error)) throw error;

		cartId = await createCart(context);
		if (!cartId) throw new Error("Failed to create replacement cart");

		cart = await fetchCart(cartId, context);
	}

	if (responseHeaders) {
		setCartCookie(responseHeaders, cartId);
	}

	return cart;
}

export async function createCart(context: LanguageContextArgs = {}): Promise<string | null> {
	const client = getShopifyClient();
	const data = await client.query<{ payload?: { cart?: { id: string } } }>(CreateCart, {
		languageCode: context.languageCode,
		countryCode: context.countryCode,
	});
	return data?.payload?.cart?.id ?? null;
}

// User-specific cart data; must not be cached/shared.
export const cache = "no-store";
