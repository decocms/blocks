import { useState } from "react";

/**
 * Extract the next-page URL from a loader result.
 * Handles both conventions used by commerce loaders:
 * - pageInfo.nextPage (VTEX, Blog, most standard loaders)
 * - nextPage (flat, some legacy loaders)
 */
export function getNextPageUrl(data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const d = data as Record<string, unknown>;
	if (d.pageInfo && typeof d.pageInfo === "object") {
		const pi = d.pageInfo as Record<string, unknown>;
		if (typeof pi.nextPage === "string" && pi.nextPage) return pi.nextPage;
	}
	if (typeof d.nextPage === "string" && d.nextPage) return d.nextPage;
	return undefined;
}

/**
 * Accumulates pages of loader data for "Ver mais" / load-more pagination.
 *
 * Fresh's `usePartialSection({ mode: "append" })` appended HTML without a
 * page reload. This hook is the TanStack equivalent: it calls the loader
 * via POST /deco/invoke — passing the nextPage URL as `__pageUrl` so the
 * loader reconstructs query, sort, and filter state from it — then pushes
 * the result into local state.
 *
 * Usage in a migrated section:
 * ```tsx
 * "use client"
 * const { pages, loadMore, loading, hasMore } = useLoadMore(
 *   props.page ?? { products: [], pageInfo: {} },
 *   "apps/vtex.ts/loaders/intelligentSearch/productListingPage.ts"
 * )
 * const allProducts = pages.flatMap(p => p.products ?? [])
 * ```
 *
 * The component must be `"use client"` because this hook uses useState.
 */
export function useLoadMore<T>(initial: T, loaderKey: string) {
	const [pages, setPages] = useState<T[]>([initial]);
	const [loading, setLoading] = useState(false);

	const lastPage = pages[pages.length - 1];
	const nextPageRel = getNextPageUrl(lastPage);
	const hasMore = Boolean(nextPageRel);

	async function loadMore() {
		if (!nextPageRel || loading) return;
		setLoading(true);
		try {
			const abs = new URL(nextPageRel, location.href);
			const res = await fetch("/deco/invoke", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					key: loaderKey,
					props: { __pageUrl: abs.href, __pagePath: abs.pathname },
				}),
			});
			if (!res.ok) throw new Error(`invoke ${res.status}`);
			const next = (await res.json()) as T;
			setPages((prev) => [...prev, next]);
		} finally {
			setLoading(false);
		}
	}

	return { pages, loadMore, loading, hasMore };
}
