/**
 * Client-side autocomplete hook for VTEX Intelligent Search.
 *
 * Uses TanStack Query with debounced input to fetch search suggestions.
 * Ported from deco-cx/apps vtex/hooks/useAutocomplete.ts
 *
 * @example
 * ```tsx
 * import { useAutocomplete } from "@decocms/apps/vtex/hooks/useAutocomplete";
 *
 * function SearchBar() {
 *   const { setSearch, suggestions, loading } = useAutocomplete();
 *   return (
 *     <input
 *       onChange={(e) => setSearch(e.target.value)}
 *       placeholder="Search..."
 *     />
 *   );
 * }
 * ```
 */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import type { Suggestion } from "@decocms/apps-commerce/types";

export interface UseAutocompleteOptions {
	/** Debounce delay in ms @default 250 */
	debounceMs?: number;
	/** Max products to return @default 4 */
	count?: number;
	/** Custom fetch function — defaults to calling the inline-loader on the server */
	fetchSuggestions?: (query: string, count: number) => Promise<Suggestion | null>;
}

const AUTOCOMPLETE_QUERY_KEY = "vtex-autocomplete";

function useDebounce<T>(value: T, delay: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return debounced;
}

async function defaultFetchSuggestions(query: string, _count: number): Promise<Suggestion | null> {
	const params = new URLSearchParams({ query });
	const res = await fetch(`/api/vtex/suggestions?${params}`);
	if (!res.ok) return null;
	return res.json();
}

export function useAutocomplete(opts?: UseAutocompleteOptions) {
	const debounceMs = opts?.debounceMs ?? 250;
	const count = opts?.count ?? 4;
	const fetchFn = opts?.fetchSuggestions ?? defaultFetchSuggestions;

	const [rawQuery, setRawQuery] = useState("");
	const debouncedQuery = useDebounce(rawQuery.trim(), debounceMs);

	const { data, isLoading, isFetching } = useQuery({
		queryKey: [AUTOCOMPLETE_QUERY_KEY, debouncedQuery, count],
		queryFn: () => fetchFn(debouncedQuery, count),
		enabled: debouncedQuery.length > 0,
		staleTime: 60_000,
	});

	const setSearch = useCallback((query: string) => {
		setRawQuery(query);
	}, []);

	return {
		/** Set the search query (will be debounced automatically) */
		setSearch,
		/** Current raw (un-debounced) query */
		query: rawQuery,
		/** Suggestion result (searches + products) */
		suggestions: data ?? null,
		/** True while initial fetch is in progress */
		loading: isLoading || isFetching,
	};
}
