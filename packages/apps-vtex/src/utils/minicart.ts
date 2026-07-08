/**
 * Map a VTEX OrderForm to the canonical `Minicart` contract.
 *
 * Pure function — no I/O, fully unit-testable. Pricing is converted from
 * VTEX's native cents to major units (the canonical unit for `Minicart`).
 *
 * Locale and currency come from `orderForm.storePreferencesData` and follow
 * VTEX's `storePreferencesData.countryCode` / `currencyCode` semantics.
 *
 * @example
 * ```ts
 * import { vtexOrderFormToMinicart } from "@decocms/apps/vtex/utils/minicart";
 * import { getCart } from "@decocms/apps/vtex/loaders/cart";
 *
 * const orderForm = await getCart(orderFormId);
 * const minicart = vtexOrderFormToMinicart(orderForm, {
 *   freeShippingTarget: 0,
 *   checkoutHref: "/checkout",
 * });
 * ```
 */

import type { Minicart, MinicartItem } from "@decocms/apps-commerce/types";
import type { OrderForm, OrderFormItem, Totalizer } from "../types";

export interface VtexOrderFormToMinicartOptions {
	/** Free-shipping threshold in major units. `0` disables the progress bar. */
	freeShippingTarget?: number;
	/** Override the OrderForm's `clientPreferencesData.locale` (BCP-47, e.g. `"pt-BR"`). */
	locale?: string;
	/** Where the checkout button sends the user. Default: `/checkout`. */
	checkoutHref?: string;
	/** Whether the UI should expose the coupon input. Default: `true`. */
	enableCoupon?: boolean;
}

const CENTS_PER_MAJOR = 100;

/** Convert VTEX cents to major units. Always returns a finite number. */
function fromCents(cents: number | undefined | null): number {
	if (cents == null || !Number.isFinite(cents)) return 0;
	return cents / CENTS_PER_MAJOR;
}

function findTotalizer(totalizers: Totalizer[] | undefined, id: string): number {
	if (!totalizers) return 0;
	const t = totalizers.find((x) => x.id === id);
	return t?.value ?? 0;
}

/**
 * Locale heuristic. VTEX exposes `clientPreferencesData.locale` when set, but
 * otherwise we synthesize one from `storePreferencesData.countryCode` so the UI
 * always has a usable value for `Intl.NumberFormat`.
 */
function inferLocale(orderForm: OrderForm, override?: string): string {
	if (override) return override;
	const explicit = orderForm.clientPreferencesData?.locale;
	if (explicit) return explicit;

	const country = orderForm.storePreferencesData?.countryCode;
	if (country === "BRA" || country === "BR") return "pt-BR";
	if (country === "USA" || country === "US") return "en-US";
	return "en-US";
}

function vtexItemToMinicartItem(item: OrderFormItem, index: number, coupon?: string): MinicartItem {
	const sellingPrice = fromCents(item.sellingPrice ?? item.price);
	const listPrice = fromCents(item.listPrice ?? item.price);
	const discount = Math.max(0, listPrice - sellingPrice);

	return {
		// AnalyticsItem identifier — VTEX uses productId; sites map to numeric SKU
		// when needed via `Number(item.item_id)` (see bagaggio Minicart).
		item_id: item.id,
		item_group_id: item.productId,
		item_name: item.name ?? item.skuName ?? "",
		item_variant: item.skuName,
		item_brand: item.additionalInfo?.brandName ?? undefined,
		item_url: item.detailUrl,
		coupon,
		affiliation: item.seller,
		index,
		// Cart-required fields
		image: item.imageUrl?.replace(/^http:/, "https:") ?? "",
		listPrice,
		price: sellingPrice,
		quantity: item.quantity,
		discount: Number(discount.toFixed(2)),
		// Platform-specific
		seller: item.seller,
		attachments: item.attachments as MinicartItem["attachments"],
		attachmentOfferings: item.attachmentOfferings as MinicartItem["attachmentOfferings"],
	};
}

/**
 * Map a VTEX `OrderForm` to the canonical platform-agnostic `Minicart`.
 *
 * @param orderForm - Result from `getCart()` or `getOrCreateCart()`.
 * @param opts - Storefront-level overrides (free-shipping target, checkout href, ...).
 */
export function vtexOrderFormToMinicart(
	orderForm: OrderForm,
	opts: VtexOrderFormToMinicartOptions = {},
): Minicart<OrderForm> {
	const totalizers = orderForm.totalizers;
	const subtotal = fromCents(findTotalizer(totalizers, "Items"));
	const discountsRaw = findTotalizer(totalizers, "Discounts");
	const discounts = Math.abs(fromCents(discountsRaw));
	const shippingRaw = findTotalizer(totalizers, "Shipping");
	const shipping = totalizers?.some((t) => t.id === "Shipping")
		? fromCents(shippingRaw)
		: undefined;
	const total = fromCents(orderForm.value);

	const coupon = orderForm.marketingData?.coupon;
	const items = (orderForm.items ?? []).map((item, index) =>
		vtexItemToMinicartItem(item, index, coupon),
	);

	return {
		original: orderForm,
		storefront: {
			items,
			subtotal,
			discounts,
			shipping,
			total,
			coupon,
			locale: inferLocale(orderForm, opts.locale),
			currency: orderForm.storePreferencesData?.currencyCode ?? "BRL",
			enableCoupon: opts.enableCoupon ?? true,
			freeShippingTarget: opts.freeShippingTarget ?? 0,
			checkoutHref: opts.checkoutHref ?? "/checkout",
			postalCode: orderForm.shippingData?.address?.postalCode ?? undefined,
		},
	};
}
