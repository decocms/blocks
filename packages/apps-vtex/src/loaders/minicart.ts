/**
 * SSR loader returning the canonical `Minicart` for the current request.
 *
 * Reads `orderFormId` from the `checkout.vtex.com__orderFormId` cookie and
 * fetches the corresponding OrderForm via `getOrCreateCart`. When no
 * orderFormId cookie exists (first-time visitor, no items added yet), returns
 * an empty `Minicart` shell — we deliberately avoid creating a new OrderForm
 * server-side to prevent zero-item carts on every page view.
 *
 * Configurable via Props (free-shipping target, locale, checkout URL).
 *
 * @example
 * ```ts
 * // setup/commerce-loaders.ts
 * import minicart from "@decocms/apps/vtex/loaders/minicart";
 * registerInlineLoader("vtex/loaders/minicart", minicart);
 * ```
 */

import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import type { Minicart } from "@decocms/apps-commerce/types";
import { getOrCreateCart } from "../actions/checkout";
import type { OrderForm } from "../types";
import { vtexOrderFormToMinicart } from "../utils/minicart";

const ORDER_FORM_COOKIE = "checkout.vtex.com__orderFormId";

export interface MinicartProps {
	/** Free-shipping threshold in major units. `0` disables the progress bar. */
	freeShippingTarget?: number;
	/** Override the OrderForm's locale (BCP-47, e.g. `"pt-BR"`). */
	locale?: string;
	/** Where the checkout button sends the user. Default: `/checkout`. */
	checkoutHref?: string;
	/** Whether the UI should expose the coupon input. Default: `true`. */
	enableCoupon?: boolean;
}

function readOrderFormIdFromRequest(): string | undefined {
	const ctx = RequestContext.current;
	const cookieHeader = ctx?.request.headers.get("cookie");
	if (!cookieHeader) return undefined;
	const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${ORDER_FORM_COOKIE}=([^;]+)`));
	return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/** Empty cart shell returned when no orderFormId is yet associated with the visitor. */
function emptyMinicart(opts: MinicartProps): Minicart<OrderForm | null> {
	return {
		original: null,
		storefront: {
			items: [],
			subtotal: 0,
			discounts: 0,
			total: 0,
			locale: opts.locale ?? "pt-BR",
			currency: "BRL",
			enableCoupon: opts.enableCoupon ?? true,
			freeShippingTarget: opts.freeShippingTarget ?? 0,
			checkoutHref: opts.checkoutHref ?? "/checkout",
		},
	};
}

export default async function vtexMinicart(
	props: MinicartProps = {},
): Promise<Minicart<OrderForm | null>> {
	const orderFormId = readOrderFormIdFromRequest();
	if (!orderFormId) return emptyMinicart(props);

	const orderForm = await getOrCreateCart({ orderFormId });
	return vtexOrderFormToMinicart(orderForm, {
		freeShippingTarget: props.freeShippingTarget,
		locale: props.locale,
		checkoutHref: props.checkoutHref,
		enableCoupon: props.enableCoupon,
	});
}
