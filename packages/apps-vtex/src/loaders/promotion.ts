/**
 * VTEX Promotion loader.
 * Pure async function — requires configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/getPromotionById.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/promotions-and-taxes-api
 */
import { vtexFetch } from "../client";
import type { Document } from "../utils/types";

/**
 * Fetch a promotion / calculator-configuration by its ID.
 *
 * Note: uses the **pvt** (private) endpoint — requires appKey/appToken
 * or a valid authentication cookie.
 *
 * @param promotionId - The `idCalculatorConfiguration` of the promotion
 * @param authCookie  - Optional cookie string for authenticated requests
 */
export async function getPromotionById(
	promotionId: string,
	authCookie?: string,
): Promise<Document[]> {
	const headers: Record<string, string> = {};
	if (authCookie) headers.cookie = authCookie;

	return vtexFetch<Document[]>(`/api/rnb/pvt/calculatorconfiguration/${promotionId}`, { headers });
}
