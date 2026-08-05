import { useState, useEffect, useCallback, useRef } from "react";

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
 * const { pages, loadMore, loading, hasMore, error } = useLoadMore(
 *   props.page ?? { products: [], pageInfo: {} },
 *   "apps/vtex.ts/loaders/intelligentSearch/productListingPage.ts",
 *   pageUrl // resetKey: pass the current page URL so accumulated pages reset on filter/sort change
 * )
 * const allProducts = pages.flatMap(p => p.products ?? [])
 * ```
 *
 * The component must be `"use client"` because this hook uses useState.
 *
 * @param resetKey - When this value changes, accumulated pages reset to [initial].
 *   Pass the current page URL (or any value that changes on filter/sort navigation)
 *   to clear the accumulated product list when the user changes filters.
 *   Without resetKey, add `key={pageUrl}` to the section element instead.
 */
export function useLoadMore<T>(initial: T, loaderKey: string, resetKey?: unknown) {
	const [pages, setPages] = useState<T[]>([initial]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	// useRef guard prevents two rapid clicks both passing the !loading check
	// before the async state update propagates (React state is not synchronous).
	const inflight = useRef(false);
	// Skip the reset effect on first mount — pages are already seeded from useState.
	const isFirstRender = useRef(true);

	useEffect(() => {
		if (isFirstRender.current) {
			isFirstRender.current = false;
			return;
		}
		setPages([initial]);
		setError(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [resetKey]);

	const lastPage = pages[pages.length - 1];
	const nextPageRel = getNextPageUrl(lastPage);
	const hasMore = Boolean(nextPageRel);

	const loadMore = useCallback(async () => {
		if (!nextPageRel || inflight.current) return;
		inflight.current = true;
		setLoading(true);
		setError(null);
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
			if (!res.ok) throw new Error(`invoke ${res.status} for ${loaderKey}`);
			const next = (await res.json()) as T;
			setPages((prev) => [...prev, next]);
		} catch (e) {
			setError(e instanceof Error ? e : new Error(String(e)));
		} finally {
			inflight.current = false;
			setLoading(false);
		}
	}, [nextPageRel, loaderKey]);

	return { pages, loadMore, loading, hasMore, error };
}
