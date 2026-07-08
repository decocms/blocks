import { vtexFetch } from "../client";
import type { PageType, SelectedFacet, SimulationBehavior, Sort } from "./types";

export const SESSION_COOKIE = "vtex_is_session";
export const ANONYMOUS_COOKIE = "vtex_is_anonymous";

export const withDefaultFacets = (allFacets: readonly SelectedFacet[]) => {
	return [...allFacets];
};

export const toPath = (facets: SelectedFacet[]) =>
	facets.map(({ key, value }) => (key ? `${key}/${value}` : value)).join("/");

interface Params {
	query: string;
	page: number;
	count: number;
	sort: Sort;
	fuzzy: string;
	locale: string;
	hideUnavailableItems: boolean;
	simulationBehavior: SimulationBehavior;
}

export const withDefaultParams = ({
	query = "",
	page = 0,
	count = 12,
	sort = "",
	fuzzy = "auto",
	locale = "pt-BR",
	hideUnavailableItems,
	simulationBehavior = "default",
}: Partial<Params>) => ({
	page: page + 1,
	count,
	query,
	sort,
	...(fuzzy ? { fuzzy } : {}),
	locale,
	hideUnavailableItems: hideUnavailableItems ?? false,
	simulationBehavior,
});

export const isFilterParam = (keyFilter: string): boolean => keyFilter.startsWith("filter.");

/**
 * Valid VTEX Intelligent Search sort values.
 * Anything else (e.g. "orders:desc)" with a trailing paren from legacy URLs)
 * causes IS API to return 400.
 */
export const VALID_IS_SORTS = new Set([
	"",
	"orders:desc",
	"price:asc",
	"price:desc",
	"name:asc",
	"name:desc",
	"release:desc",
	"discount:desc",
]);

/** Sanitize an IS sort parameter — returns empty string for invalid values. */
export function sanitizeISSort(sort: string): string {
	return VALID_IS_SORTS.has(sort) ? sort : "";
}

const segmentsFromTerm = (term: string) => term.split("/").filter(Boolean);

const segmentsFromSearchParams = (url: string) => {
	const searchParams = new URLSearchParams(url).entries();

	const categories = Array.from(searchParams)
		.sort()
		.reduce((acc, [key, value]) => {
			if (key.includes("filter.category")) {
				acc.push(value);
			}

			return acc;
		}, [] as string[]);

	return categories.length ? categories : segmentsFromTerm(url);
};

export const pageTypesFromUrl = async (url: string): Promise<PageType[]> => {
	const segments = segmentsFromSearchParams(url);

	return await Promise.all(
		segments.map((_, index) =>
			vtexFetch<PageType>(
				`/api/catalog_system/pub/portal/pagetype/${segments.slice(0, index + 1).join("/")}`,
			),
		),
	);
};
