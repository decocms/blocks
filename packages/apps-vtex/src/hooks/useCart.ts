/**
 * Client-side cart hook for VTEX.
 *
 * Uses TanStack Query for SWR, optimistic updates, and cache invalidation.
 * Returns BOTH the raw `OrderForm` (back-compat for existing consumers) AND
 * the canonical `Minicart` shape (preferred for new code).
 *
 * @example Reading the cart
 * ```tsx
 * import { useCart } from "@decocms/apps/vtex/hooks/useCart";
 *
 * function CartButton() {
 *   const { minicart, isLoading } = useCart({ freeShippingTarget: 200 });
 *   const count = minicart?.storefront.items.length ?? 0;
 *   return <button disabled={isLoading}>{count} items</button>;
 * }
 * ```
 *
 * @example Mutations
 * ```tsx
 * const { addItems, removeItem, addCoupons } = useCart();
 * addItems.mutate([{ id: "123", seller: "1", quantity: 1 }]);
 * ```
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Minicart } from "@decocms/apps-commerce/types";
import type { OrderForm, OrderFormItem } from "../types";
import { vtexOrderFormToMinicart } from "../utils/minicart";

/** Re-exported from `vtex/types` for back-compat. New code should import directly. */
export type { OrderForm } from "../types";

/**
 * Slim cart-item shape used by mutations.
 * @deprecated Use `OrderFormItem` from `@decocms/apps/vtex/types` for full fidelity,
 *   or `MinicartItem` from `@decocms/apps/commerce/types` for the canonical contract.
 */
export type CartItem = Pick<OrderFormItem, "id" | "quantity" | "seller">;

const CART_QUERY_KEY = ["vtex", "cart"] as const;

const DEFAULT_EXPECTED_SECTIONS = [
	"items",
	"totalizers",
	"clientProfileData",
	"shippingData",
	"paymentData",
	"sellers",
	"messages",
	"marketingData",
	"clientPreferencesData",
	"storePreferencesData",
	"giftRegistryData",
	"ratesAndBenefitsData",
	"openTextField",
	"commercialConditionData",
	"customData",
];

function getScParam(): string {
	if (typeof window !== "undefined") {
		const match = document.cookie.match(/(?:^|;\s*)VTEXSC=([^;]+)/);
		return match?.[1] ?? "";
	}
	return "";
}

function appendSc(url: string): string {
	const sc = getScParam();
	if (!sc) return url;
	return url.includes("?") ? `${url}&sc=${sc}` : `${url}?sc=${sc}`;
}

async function fetchCart(): Promise<OrderForm> {
	const res = await fetch(appendSc("/api/checkout/pub/orderForm"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ expectedOrderFormSections: DEFAULT_EXPECTED_SECTIONS }),
		credentials: "include",
	});
	if (!res.ok) throw new Error(`Cart fetch failed: ${res.status}`);
	return res.json();
}

async function addItemsToCart(
	orderFormId: string,
	items: Array<{ id: string; quantity: number; seller: string }>,
): Promise<OrderForm> {
	const params = new URLSearchParams();
	params.append("allowedOutdatedData", "paymentData");
	const sc = getScParam();
	if (sc) params.set("sc", sc);

	const res = await fetch(`/api/checkout/pub/orderForm/${orderFormId}/items?${params}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ orderItems: items }),
		credentials: "include",
	});
	if (!res.ok) throw new Error(`Add to cart failed: ${res.status}`);
	return res.json();
}

async function addCouponsToCart(orderFormId: string, text: string): Promise<OrderForm> {
	const params = new URLSearchParams();
	const sc = getScParam();
	if (sc) params.set("sc", sc);

	const res = await fetch(`/api/checkout/pub/orderForm/${orderFormId}/coupons?${params}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
		credentials: "include",
	});
	if (!res.ok) throw new Error(`Add coupon failed: ${res.status}`);
	return res.json();
}

async function updateItemQuantity(
	orderFormId: string,
	index: number,
	quantity: number,
): Promise<OrderForm> {
	const params = new URLSearchParams();
	params.append("allowedOutdatedData", "paymentData");
	const sc = getScParam();
	if (sc) params.set("sc", sc);

	const res = await fetch(`/api/checkout/pub/orderForm/${orderFormId}/items/update?${params}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ orderItems: [{ index, quantity }] }),
		credentials: "include",
	});
	if (!res.ok) throw new Error(`Update quantity failed: ${res.status}`);
	return res.json();
}

export interface UseCartOptions {
	/** Enable automatic refetching. @default true */
	enabled?: boolean;
	/** Stale time in ms. @default 30000 */
	staleTime?: number;
	/** Free-shipping threshold in major units, surfaced on `minicart.storefront`. @default 0 */
	freeShippingTarget?: number;
	/** Override the OrderForm's locale (BCP-47, e.g. `"pt-BR"`). */
	locale?: string;
	/** Where the checkout button sends the user. @default "/checkout" */
	checkoutHref?: string;
	/** Whether to surface the coupon input. @default true */
	enableCoupon?: boolean;
}

export function useCart(options?: UseCartOptions) {
	const queryClient = useQueryClient();

	const query = useQuery({
		queryKey: CART_QUERY_KEY,
		queryFn: fetchCart,
		staleTime: options?.staleTime ?? 30_000,
		enabled: options?.enabled !== false,
	});

	const cart = query.data ?? null;

	const minicart: Minicart<OrderForm> | null = useMemo(() => {
		if (!cart) return null;
		return vtexOrderFormToMinicart(cart, {
			freeShippingTarget: options?.freeShippingTarget,
			locale: options?.locale,
			checkoutHref: options?.checkoutHref,
			enableCoupon: options?.enableCoupon,
		});
	}, [
		cart,
		options?.freeShippingTarget,
		options?.locale,
		options?.checkoutHref,
		options?.enableCoupon,
	]);

	const addItems = useMutation({
		mutationFn: (items: Array<{ id: string; quantity: number; seller: string }>) => {
			const orderFormId = query.data?.orderFormId;
			if (!orderFormId) throw new Error("Cart not loaded");
			return addItemsToCart(orderFormId, items);
		},
		onSuccess: (data) => {
			queryClient.setQueryData(CART_QUERY_KEY, data);
		},
	});

	const updateQuantity = useMutation({
		mutationFn: ({ index, quantity }: { index: number; quantity: number }) => {
			const orderFormId = query.data?.orderFormId;
			if (!orderFormId) throw new Error("Cart not loaded");
			return updateItemQuantity(orderFormId, index, quantity);
		},
		onSuccess: (data) => {
			queryClient.setQueryData(CART_QUERY_KEY, data);
		},
	});

	const removeItem = useMutation({
		mutationFn: (index: number) => {
			const orderFormId = query.data?.orderFormId;
			if (!orderFormId) throw new Error("Cart not loaded");
			return updateItemQuantity(orderFormId, index, 0);
		},
		onSuccess: (data) => {
			queryClient.setQueryData(CART_QUERY_KEY, data);
		},
	});

	const addCoupons = useMutation({
		mutationFn: (text: string) => {
			const orderFormId = query.data?.orderFormId;
			if (!orderFormId) throw new Error("Cart not loaded");
			return addCouponsToCart(orderFormId, text);
		},
		onSuccess: (data) => {
			queryClient.setQueryData(CART_QUERY_KEY, data);
		},
	});

	return {
		/** Raw VTEX OrderForm — escape hatch for platform-specific reads. */
		cart,
		/** Canonical platform-agnostic minicart. Prefer this in new UI code. */
		minicart,
		isLoading: query.isLoading,
		isError: query.isError,
		error: query.error,
		refetch: query.refetch,
		addItems,
		addCoupons,
		updateQuantity,
		removeItem,
		itemCount: cart?.items?.length ?? 0,
	};
}
