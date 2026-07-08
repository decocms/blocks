/**
 * Client-side wishlist hook for VTEX.
 *
 * Reads the wishlist via the invoke proxy and provides
 * add/remove mutations with automatic cache invalidation.
 *
 * @example
 * ```tsx
 * import { useWishlist } from "@decocms/apps/vtex/hooks/useWishlist";
 *
 * function WishlistButton({ productId, sku }: Props) {
 *   const { isInWishlist, toggle, isLoading } = useWishlist();
 *   const wishlisted = isInWishlist(productId);
 *   return (
 *     <button onClick={() => toggle({ productId, sku })} disabled={isLoading}>
 *       {wishlisted ? "♥" : "♡"}
 *     </button>
 *   );
 * }
 * ```
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface WishlistItem {
	id: string;
	productId: string;
	sku: string;
}

const WISHLIST_QUERY_KEY = ["vtex", "wishlist"] as const;

async function fetchWishlist(): Promise<WishlistItem[]> {
	const res = await fetch("/deco/invoke/vtex/loaders/wishlist", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({}),
		credentials: "include",
	});
	if (!res.ok) {
		if (res.status === 401) return [];
		throw new Error(`Wishlist fetch failed: ${res.status}`);
	}
	return res.json();
}

async function addToWishlist(item: { productId: string; sku: string }): Promise<void> {
	const res = await fetch("/deco/invoke/vtex/actions/wishlist/addItem", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(item),
		credentials: "include",
	});
	if (!res.ok) throw new Error(`Add to wishlist failed: ${res.status}`);
}

async function removeFromWishlist(id: string): Promise<void> {
	const res = await fetch("/deco/invoke/vtex/actions/wishlist/removeItem", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id }),
		credentials: "include",
	});
	if (!res.ok) throw new Error(`Remove from wishlist failed: ${res.status}`);
}

export interface UseWishlistOptions {
	enabled?: boolean;
	staleTime?: number;
}

export function useWishlist(options?: UseWishlistOptions) {
	const queryClient = useQueryClient();

	const query = useQuery({
		queryKey: WISHLIST_QUERY_KEY,
		queryFn: fetchWishlist,
		staleTime: options?.staleTime ?? 60_000,
		enabled: options?.enabled !== false,
	});

	const items = query.data ?? [];
	const productIdSet = new Set(items.map((i) => i.productId));

	const addMutation = useMutation({
		mutationFn: addToWishlist,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: WISHLIST_QUERY_KEY }),
	});

	const removeMutation = useMutation({
		mutationFn: removeFromWishlist,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: WISHLIST_QUERY_KEY }),
	});

	function isInWishlist(productId: string): boolean {
		return productIdSet.has(productId);
	}

	function toggle(item: { productId: string; sku: string }) {
		const existing = items.find((i) => i.productId === item.productId);
		if (existing) {
			removeMutation.mutate(existing.id);
		} else {
			addMutation.mutate(item);
		}
	}

	return {
		items,
		isLoading: query.isLoading || addMutation.isPending || removeMutation.isPending,
		isError: query.isError,
		isInWishlist,
		toggle,
		add: addMutation,
		remove: removeMutation,
		refetch: query.refetch,
		count: items.length,
	};
}
