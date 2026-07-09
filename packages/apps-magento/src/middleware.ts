/**
 * Magento middleware — currently a passthrough.
 *
 * The legacy deco-cx/apps middleware reconciled the cart id cookie
 * after checkout (`changeCardIdAfterCheckout`) and seeded the
 * `form_key` for anonymous sessions. Both flows touched response
 * headers and `customer/section/load` endpoints — non-trivial port,
 * deferred to a follow-up PR. Today the consumer site (granadobr-
 * tanstack) handles cart reconciliation on the client.
 *
 * Shape matches `@decocms/apps-commerce/app-types` so it can be
 * plugged into the autoconfig pipeline once magento is registered
 * there.
 */
import type { AppMiddleware } from "@decocms/apps-commerce/app-types";

export const magentoMiddleware: AppMiddleware = async (_request, next) => {
	return next();
};
