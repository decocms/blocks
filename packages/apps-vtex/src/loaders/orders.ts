/**
 * VTEX Orders API loaders.
 * Pure async functions — require configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/orders/getById.ts
 *   vtex/loaders/orders/list.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/orders-api
 */
import { vtexFetch } from "../client";

// ---------------------------------------------------------------------------
// getOrderById (authenticated — REST)
// ---------------------------------------------------------------------------

/**
 * Fetch a single user order by its ID.
 * The user must be authenticated or the caller must have OMS permissions.
 *
 * @see https://developers.vtex.com/docs/api-reference/orders-api#get-/api/oms/user/orders/-orderId-
 */
export async function getOrderById<T = any>(orderId: string, authCookie: string): Promise<T> {
	return vtexFetch<T>(`/api/oms/user/orders/${orderId}`, {
		headers: { cookie: authCookie },
	});
}

// ---------------------------------------------------------------------------
// listOrders (authenticated — REST)
// ---------------------------------------------------------------------------

export interface ListOrdersOpts {
	clientEmail: string;
	page?: string;
	perPage?: string;
}

/**
 * List orders for a given client e-mail.
 * The user must be authenticated or the caller must have OMS permissions.
 *
 * @see https://developers.vtex.com/docs/api-reference/orders-api#get-/api/oms/user/orders
 */
export async function listOrders<T = any>(opts: ListOrdersOpts, authCookie: string): Promise<T> {
	const { clientEmail, page = "0", perPage = "15" } = opts;
	const params = new URLSearchParams({
		clientEmail,
		page,
		per_page: perPage,
	});

	return vtexFetch<T>(`/api/oms/user/orders?${params}`, {
		headers: { cookie: authCookie },
	});
}

// ---------------------------------------------------------------------------
// getOrderPlaced (order confirmation — Checkout API)
// ---------------------------------------------------------------------------

/**
 * Fetch order details for the order-placed / confirmation page.
 *
 * Accepts either:
 *  - An **order group ID** (no hyphen) → returns all orders in the group
 *  - A single **order ID** (contains hyphen) → returns that order wrapped in an array
 *
 * The caller must supply an `authCookie` containing at least the
 * VtexIdclientAutCookie, CheckoutDataAccess, and Vtex_CHKO_Auth cookies
 * that VTEX sets after checkout.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/orderplaced.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/checkout-api#get-/api/checkout/pub/orders/order-group/-orderGroupId-
 */
export async function getOrderPlaced<T = any>(orderId: string, authCookie: string): Promise<T[]> {
	const isOrderGroup = !orderId.includes("-");

	if (isOrderGroup) {
		return vtexFetch<T[]>(`/api/checkout/pub/orders/order-group/${orderId}`, {
			headers: { cookie: authCookie },
		});
	}

	const order = await vtexFetch<T>(`/api/checkout/pub/orders/${orderId}`, {
		headers: { cookie: authCookie },
	});

	return [order];
}
