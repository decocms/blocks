/**
 * VTEX Cart (OrderForm) loader.
 * Pure async function — requires configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/cart.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/checkout-api#get-/api/checkout/pub/orderForm
 */

import { DEFAULT_EXPECTED_SECTIONS } from "../actions/checkout";
import { getVtexConfig, vtexFetch } from "../client";
import { forceHttpsOnAssets } from "../utils/transform";
import type { OrderForm } from "../utils/types";

/**
 * Fetch the current cart (OrderForm).
 *
 * When `orderFormId` is provided the existing cart is retrieved;
 * otherwise a fresh OrderForm is created via POST.
 *
 * @param orderFormId - Optional existing orderForm ID (from checkout cookie)
 * @param salesChannel - Optional sales channel override
 * @param authCookie - Optional cookie string for authenticated requests
 */
export async function getCart(
	orderFormId?: string,
	opts?: { salesChannel?: string; authCookie?: string },
): Promise<OrderForm> {
	const { salesChannel } = getVtexConfig();
	const sc = opts?.salesChannel ?? salesChannel;
	const headers: Record<string, string> = {};
	if (opts?.authCookie) headers.cookie = opts.authCookie;

	const scParam = sc ? `?sc=${sc}` : "";

	const body = JSON.stringify({ expectedOrderFormSections: DEFAULT_EXPECTED_SECTIONS });

	const cart = orderFormId
		? await vtexFetch<OrderForm>(`/api/checkout/pub/orderForm/${orderFormId}${scParam}`, {
				method: "POST",
				headers,
				body,
			})
		: await vtexFetch<OrderForm>(`/api/checkout/pub/orderForm${scParam}`, {
				method: "POST",
				headers,
				body,
			});

	return forceHttpsOnAssets(cart);
}
