/**
 * Factory for the legacy invoke-based `useWishlist` hook.
 *
 * Mirrors the deco-cx/apps signal-based wishlist API used by migrated
 * Fresh sites: `wishlist.addItem(productId, productGroupId)`,
 * `removeItem(productId)`, `getItem(productId): boolean`.
 *
 * It is intentionally separate from the canonical `useWishlist` in
 * `vtex/hooks/useWishlist.ts`, which is built on TanStack Query and exposes
 * `{ items, isInWishlist, toggle, add, remove }`. Both can coexist.
 *
 * ## VTEX wishlist arg conventions
 *
 * The legacy hook's `addItem(productId, productGroupId)` argument names
 * are misleading because they were originally derived from analytics
 * `item_id` / `item_group_id`:
 *
 * - `productId` arg → analytics `item_id` → VTEX `sku` field on the wishlist
 * - `productGroupId` arg → analytics `item_group_id` → VTEX `productId`
 *
 * The factory swaps them on the wire so the canonical
 * `vtex/actions/wishlist.addItem` gets the right shape.
 *
 * @example
 * ```ts
 * // src/hooks/useWishlist.ts
 * import { createUseWishlist } from "@decocms/apps/vtex/hooks/createUseWishlist";
 * import { invoke } from "~/server/invoke";
 *
 * export const { useWishlist, resetWishlist } = createUseWishlist({ invoke });
 * export type { WishlistItem } from "@decocms/apps/vtex/loaders/wishlist";
 * ```
 */

import { useEffect, useState } from "react";
import type { WishlistItem } from "../loaders/wishlist";

/**
 * Pure helper: find a wishlist entry by either the SKU id (legacy
 * `productId` arg) or the VTEX productId. Exported for unit testability.
 */
export function findWishlistEntry(
	items: readonly WishlistItem[],
	productId: string,
): WishlistItem | undefined {
	return items.find((it) => it.sku === productId || it.productId === productId);
}

/**
 * Pure helper: convert legacy `addItem(productId, productGroupId)` args
 * into the canonical `{ productId, sku }` shape expected by
 * `vtex/actions/wishlist.addItem`. Exported for unit testability.
 */
export function legacyAddArgsToCanonical(
	legacyProductId: string,
	legacyProductGroupId: string,
): { productId: string; sku: string } {
	// See arg conventions in the file header. The legacy `productId` is
	// the SKU; the legacy `productGroupId` is the VTEX productId.
	return {
		productId: legacyProductGroupId,
		sku: legacyProductId,
	};
}

/** Minimal structural shape of the invoke proxy this hook needs. */
export interface CreateUseWishlistInvoke {
	vtex: {
		loaders: {
			wishlist: () => Promise<WishlistItem[]>;
		};
		actions: {
			addToWishlist: (args: {
				data: { productId: string; sku: string; title?: string };
			}) => Promise<WishlistItem[]>;
			removeFromWishlist: (args: { data: { id: string } }) => Promise<WishlistItem[]>;
		};
	};
}

export interface CreateUseWishlistOptions {
	invoke: CreateUseWishlistInvoke;
}

/** Build a per-site `useWishlist` plus its companions. */
export function createUseWishlist(opts: CreateUseWishlistOptions) {
	const { invoke } = opts;

	let _items: WishlistItem[] = [];
	let _loading = false;
	let _initStarted = false;
	let _initFailed = false;
	const _listeners = new Set<() => void>();

	function notify() {
		for (const fn of _listeners) fn();
	}
	function setItems(items: WishlistItem[]) {
		_items = items;
		notify();
	}
	function setLoading(v: boolean) {
		_loading = v;
		notify();
	}

	function getItem(productId: string): boolean {
		return !!findWishlistEntry(_items, productId);
	}

	async function addItem(productId: string, productGroupId: string): Promise<void> {
		setLoading(true);
		try {
			const updated = await invoke.vtex.actions.addToWishlist({
				data: legacyAddArgsToCanonical(productId, productGroupId),
			});
			setItems(updated);
		} catch (err) {
			console.error("[useWishlist] addItem failed:", err);
			throw err;
		} finally {
			setLoading(false);
		}
	}

	async function removeItem(productId: string): Promise<void> {
		const entry = findWishlistEntry(_items, productId);
		if (!entry?.id) {
			// Either the wishlist hasn't loaded yet or the item isn't there.
			// Either way, nothing to remove.
			return;
		}
		setLoading(true);
		try {
			const updated = await invoke.vtex.actions.removeFromWishlist({
				data: { id: entry.id },
			});
			setItems(updated);
		} catch (err) {
			console.error("[useWishlist] removeItem failed:", err);
			throw err;
		} finally {
			setLoading(false);
		}
	}

	async function refresh(): Promise<WishlistItem[]> {
		setLoading(true);
		try {
			const items = await invoke.vtex.loaders.wishlist();
			setItems(items);
			_initFailed = false;
			return items;
		} catch (err) {
			console.error("[useWishlist] refresh failed:", err);
			_initFailed = true;
			notify();
			return [];
		} finally {
			setLoading(false);
		}
	}

	/** Reset module-level wishlist state so the next useWishlist() re-fetches. */
	function resetWishlist() {
		_items = [];
		_loading = false;
		_initStarted = false;
		_initFailed = false;
		notify();
	}

	function useWishlist() {
		const [, forceRender] = useState(0);

		useEffect(() => {
			const listener = () => forceRender((n) => n + 1);
			_listeners.add(listener);

			if (_items.length === 0 && !_initStarted) {
				_initStarted = true;
				setLoading(true);
				invoke.vtex.loaders
					.wishlist()
					.then((items) => {
						setItems(items);
					})
					.catch((err: unknown) => {
						// 401 / unauthenticated is normal — user just isn't logged in.
						// Real errors get logged.
						console.error("[useWishlist] init failed:", err);
						_initFailed = true;
						notify();
					})
					.finally(() => setLoading(false));
			}

			return () => {
				_listeners.delete(listener);
			};
		}, []);

		return {
			items: {
				get value() {
					return _items;
				},
				set value(v: WishlistItem[]) {
					setItems(v);
				},
			},

			loading: {
				get value() {
					return _loading;
				},
			},

			initFailed: {
				get value() {
					return _initFailed;
				},
			},

			count: {
				get value() {
					return _items.length;
				},
			},

			addItem,
			removeItem,
			getItem,
			refresh,
		};
	}

	return {
		useWishlist,
		resetWishlist,
	};
}
