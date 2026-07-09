/**
 * Factory for the legacy invoke-based `useCart` hook.
 *
 * This is the API shape that migrated Fresh sites depend on:
 *   - module-level singleton state (no QueryClient required)
 *   - listener-based re-render (`forceRender` on a useState counter)
 *   - awaitable async actions (`await addItem(...)`) instead of TanStack mutations
 *   - signal-shaped accessors (`cart.value`, `cart.value = ...`)
 *
 * It is intentionally separate from the canonical `useCart` in
 * `vtex/hooks/useCart.ts`, which is built on TanStack Query and exposes the
 * `Minicart` shape. Both can coexist in a single site.
 *
 * @example
 * ```ts
 * // src/hooks/useCart.ts
 * import { createUseCart } from "@decocms/apps/vtex/hooks/createUseCart";
 * import { invoke } from "~/server/invoke";
 *
 * export const { useCart, resetCart, itemToAnalyticsItem } = createUseCart({
 *   invoke,
 * });
 * export type { OrderForm, OrderFormItem } from "@decocms/apps/vtex/types";
 * ```
 */

import { useEffect, useState } from "react";
import type { OrderForm, OrderFormItem } from "../types";

/** Minimal structural shape of the invoke proxy this hook needs. */
export interface CreateUseCartInvoke {
	vtex: {
		actions: {
			getOrCreateCart: (args: { data: { orderFormId?: string } }) => Promise<OrderForm>;
			addItemsToCart: (args: {
				data: {
					orderFormId: string;
					orderItems: Array<{ id: string; seller: string; quantity: number }>;
				};
			}) => Promise<OrderForm>;
			updateCartItems: (args: {
				data: {
					orderFormId: string;
					orderItems: Array<{ index: number; quantity: number }>;
				};
			}) => Promise<OrderForm>;
			addCouponToCart: (args: {
				data: { orderFormId: string; text: string };
			}) => Promise<OrderForm>;
			updateOrderFormAttachment: (args: {
				data: {
					orderFormId: string;
					attachment: string;
					body: Record<string, unknown>;
				};
			}) => Promise<OrderForm>;
			simulateCart: (args: {
				data: {
					items: Array<{ id: string; quantity: number; seller: string }>;
					postalCode: string;
					country: string;
				};
			}) => Promise<unknown>;
		};
	};
}

export interface CreateUseCartOptions {
	invoke: CreateUseCartInvoke;
	/**
	 * Override the orderFormId cookie name. VTEX standard is
	 * `checkout.vtex.com__orderFormId`, which is the default.
	 */
	orderFormCookieName?: string;
	/** Override the cookie max-age in seconds. Default: 7 days. */
	orderFormCookieMaxAge?: number;
}

/** Build a per-site `useCart` plus its companions. */
export function createUseCart(opts: CreateUseCartOptions) {
	const { invoke } = opts;
	const COOKIE_NAME = opts.orderFormCookieName ?? "checkout.vtex.com__orderFormId";
	const COOKIE_MAX_AGE = opts.orderFormCookieMaxAge ?? 7 * 24 * 3600;

	let _orderForm: OrderForm | null = null;
	let _loading = false;
	let _initStarted = false;
	let _initFailed = false;
	const _listeners = new Set<() => void>();

	function notify() {
		for (const fn of _listeners) fn();
	}
	function setOrderForm(of: OrderForm | null) {
		_orderForm = of;
		notify();
	}
	function setLoading(v: boolean) {
		_loading = v;
		notify();
	}

	function escapeRegex(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	function getOrderFormIdFromCookie(): string | null {
		if (typeof document === "undefined") return null;
		const re = new RegExp(`${escapeRegex(COOKIE_NAME)}=([^;]*)`);
		const match = document.cookie.match(re);
		return match ? decodeURIComponent(match[1]) : null;
	}

	function setOrderFormIdCookie(id: string) {
		if (typeof document === "undefined") return;
		document.cookie = `${COOKIE_NAME}=${encodeURIComponent(id)}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
	}

	async function ensureOrderForm(): Promise<string> {
		if (_orderForm?.orderFormId) return _orderForm.orderFormId;

		const existing = getOrderFormIdFromCookie();
		const of = await invoke.vtex.actions.getOrCreateCart({
			data: { orderFormId: existing || undefined },
		});
		setOrderForm(of);
		if (of?.orderFormId) setOrderFormIdCookie(of.orderFormId);
		return of.orderFormId;
	}

	function itemToAnalyticsItem(item: OrderFormItem & { coupon?: string }, index: number) {
		return {
			item_id: item.productId,
			item_group_id: item.productId,
			item_name: item.name ?? item.skuName ?? "",
			item_variant: item.skuName,
			item_brand: item.additionalInfo?.brandName ?? "",
			price: (item.sellingPrice ?? item.price ?? 0) / 100,
			discount: Number(((item.listPrice - item.sellingPrice) / 100).toFixed(2)),
			quantity: item.quantity,
			coupon: item.coupon,
			affiliation: item.seller,
			index,
		};
	}

	/** Reset all module-level cart state so the next useCart() re-fetches. */
	function resetCart() {
		_orderForm = null;
		_loading = false;
		_initStarted = false;
		_initFailed = false;
		notify();
	}

	function useCart() {
		const [, forceRender] = useState(0);

		useEffect(() => {
			const listener = () => forceRender((n) => n + 1);
			_listeners.add(listener);

			if (!_orderForm && !_initStarted) {
				_initStarted = true;
				const ofId = getOrderFormIdFromCookie();
				setLoading(true);
				invoke.vtex.actions
					.getOrCreateCart({ data: { orderFormId: ofId || undefined } })
					.then((of) => {
						setOrderForm(of);
						if (of?.orderFormId) setOrderFormIdCookie(of.orderFormId);
					})
					.catch((err: unknown) => {
						console.error("[useCart] init failed:", err);
						// Keep previous orderForm if we had one (e.g. after SPA navigation)
						// so user data isn't lost on transient VTEX 503s.
						if (!_orderForm) {
							_initFailed = true;
							notify();
						}
					})
					.finally(() => setLoading(false));
			}

			return () => {
				_listeners.delete(listener);
			};
		}, []);

		return {
			cart: {
				get value() {
					return _orderForm;
				},
				set value(v: OrderForm | null) {
					setOrderForm(v);
				},
			},

			loading: {
				get value() {
					return _loading;
				},
				set value(v: boolean) {
					setLoading(v);
				},
			},

			initFailed: {
				get value() {
					return _initFailed;
				},
			},

			addItem: async (params: { id: string; seller: string; quantity?: number }) => {
				setLoading(true);
				try {
					const ofId = await ensureOrderForm();
					const updated = await invoke.vtex.actions.addItemsToCart({
						data: {
							orderFormId: ofId,
							orderItems: [
								{
									id: params.id,
									seller: params.seller,
									quantity: params.quantity ?? 1,
								},
							],
						},
					});
					setOrderForm(updated);
					if (updated?.orderFormId) setOrderFormIdCookie(updated.orderFormId);
				} catch (err) {
					console.error("[useCart] addItem failed:", err);
					throw err;
				} finally {
					setLoading(false);
				}
			},

			addItems: async (params: {
				orderItems: Array<{ id: string; seller: string; quantity: number }>;
			}) => {
				setLoading(true);
				try {
					const ofId = await ensureOrderForm();
					const updated = await invoke.vtex.actions.addItemsToCart({
						data: { orderFormId: ofId, orderItems: params.orderItems },
					});
					setOrderForm(updated);
					if (updated?.orderFormId) setOrderFormIdCookie(updated.orderFormId);
				} catch (err) {
					console.error("[useCart] addItems failed:", err);
					throw err;
				} finally {
					setLoading(false);
				}
			},

			updateItems: async (params: { orderItems: Array<{ index: number; quantity: number }> }) => {
				const ofId = _orderForm?.orderFormId || getOrderFormIdFromCookie();
				if (!ofId) return;
				setLoading(true);
				try {
					const updated = await invoke.vtex.actions.updateCartItems({
						data: { orderFormId: ofId, orderItems: params.orderItems },
					});
					setOrderForm(updated);
				} catch (err) {
					console.error("[useCart] updateItems failed:", err);
				} finally {
					setLoading(false);
				}
			},

			removeItem: async (index: number) => {
				const ofId = _orderForm?.orderFormId || getOrderFormIdFromCookie();
				if (!ofId) return;
				setLoading(true);
				try {
					const updated = await invoke.vtex.actions.updateCartItems({
						data: {
							orderFormId: ofId,
							orderItems: [{ index, quantity: 0 }],
						},
					});
					setOrderForm(updated);
				} catch (err) {
					console.error("[useCart] removeItem failed:", err);
				} finally {
					setLoading(false);
				}
			},

			addCouponsToCart: async ({ text }: { text: string }) => {
				const ofId = _orderForm?.orderFormId || getOrderFormIdFromCookie();
				if (!ofId) return;
				setLoading(true);
				try {
					const updated = await invoke.vtex.actions.addCouponToCart({
						data: { orderFormId: ofId, text },
					});
					setOrderForm(updated);
				} catch (err) {
					console.error("[useCart] addCoupon failed:", err);
				} finally {
					setLoading(false);
				}
			},

			sendAttachment: async (params: { attachment: string; body: Record<string, unknown> }) => {
				const ofId = _orderForm?.orderFormId || getOrderFormIdFromCookie();
				if (!ofId) return;
				setLoading(true);
				try {
					const updated = await invoke.vtex.actions.updateOrderFormAttachment({
						data: {
							orderFormId: ofId,
							attachment: params.attachment,
							body: params.body,
						},
					});
					setOrderForm(updated);
				} catch (err) {
					console.error("[useCart] sendAttachment failed:", err);
				} finally {
					setLoading(false);
				}
			},

			simulate: async (data: {
				items: Array<{ id: string; quantity: number; seller: string }>;
				postalCode: string;
				country: string;
			}) => {
				return await invoke.vtex.actions.simulateCart({
					data: {
						items: data.items.map((i) => ({
							id: i.id,
							quantity: i.quantity,
							seller: i.seller,
						})),
						postalCode: data.postalCode,
						country: data.country,
					},
				});
			},

			mapItemsToAnalyticsItems: (orderForm: OrderForm | null) => {
				return (orderForm?.items || []).map((item, index) => itemToAnalyticsItem(item, index));
			},
		};
	}

	return {
		useCart,
		resetCart,
		itemToAnalyticsItem,
	};
}
