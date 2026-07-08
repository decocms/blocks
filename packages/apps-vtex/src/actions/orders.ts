/**
 * VTEX Order management actions.
 * Ported from deco-cx/apps:
 *   - vtex/actions/orders/cancel.ts
 * @see https://developers.vtex.com/docs/api-reference/orders-api
 */
import { getVtexConfig, vtexFetch } from "../client";
import { buildAuthCookieHeader } from "../utils/vtexId";

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Cancel an order on behalf of the authenticated user.
 * Hits POST /api/checkout/pub/orders/{orderId}/user-cancel-request
 * on vtexcommercestable.com.br.
 */
export async function cancelOrder(
	orderId: string,
	reason: string,
	authCookie?: string,
): Promise<void> {
	const headers: Record<string, string> = {};
	if (authCookie) {
		headers.Cookie = buildAuthCookieHeader(authCookie, getVtexConfig().account);
	}

	await vtexFetch<unknown>(`/api/checkout/pub/orders/${orderId}/user-cancel-request`, {
		method: "POST",
		body: JSON.stringify({ reason }),
		headers,
	});
}
