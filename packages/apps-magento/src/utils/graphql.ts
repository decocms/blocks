/**
 * GraphQL helpers for Magento product loaders.
 *
 * Ported from `deco-cx/apps/magento/utils/graphql.ts` (Fresh/Deno
 * prod). Pure functions — no I/O, no client state — so behavior is
 * pinned by `__tests__/graphql.test.ts` and shared across PDP, PLP,
 * list, and relatedProducts loaders.
 *
 *  - `transformSortGraphQL(ProductSort)` → `ProductSortInput`
 *  - `transformFilterGraphQL(url, customFilters, fromLoader)` →
 *    `ProductFilterInput` — merges URL-derived + loader-derived filters.
 *  - `transformFilterValueGraphQL(value, type)` → typed Filter*Input.
 *  - `formatUrlSuffix(str)` → ensures a path ends with `/` (used as
 *    `defaultPath` for the Magento URL rewrite resolver).
 *  - `getCustomFields(CustomFields, fallback)` → resolved custom
 *    attribute list for product projection.
 */

import type { FiltersGraphQL } from "../client";
import { DEFAULT_GRAPHQL_FILTERS } from "./constants";
import type {
	CustomFields,
	FilterEqualTypeInput,
	FilterMatchTypeInput,
	FilterProps,
	FilterRangeTypeInput,
	ProductFilterInput,
	ProductSort,
	ProductSortInput,
} from "./graphql-types";

export const typeChecker = <T extends object>(v: T, prop: keyof T): boolean => prop in v;

export const transformSortGraphQL = ({
	sortBy,
	order,
}: Partial<ProductSort>): ProductSortInput | undefined => {
	if (!sortBy) {
		return undefined;
	}
	return {
		[sortBy.value]: order ?? "ASC",
	};
};

/**
 * Compose the GraphQL `filter` payload from two sources, in order:
 *
 *   1. URL search params crossed against `DEFAULT_GRAPHQL_FILTERS`
 *      (+ any `customFilters` the site extends with).
 *   2. Explicit `fromLoader` filters the CMS section pinned at config
 *      time.
 *
 * Loader-derived filters shadow URL-derived ones on key collisions
 * (intentional — a section that hard-codes `sale=true` should ignore
 * any conflicting URL hint).
 */
export const transformFilterGraphQL = (
	url: URL,
	customFilters?: Array<FiltersGraphQL>,
	fromLoader?: Array<FilterProps>,
): ProductFilterInput | undefined => ({
	...filtersFromUrlGraphQL(url, customFilters),
	...filtersFromLoaderGraphQL(fromLoader),
});

export const filtersFromLoaderGraphQL = (
	fromLoader?: Array<FilterProps>,
): ProductFilterInput | undefined =>
	fromLoader?.reduce<ProductFilterInput>(
		(acc, f) => ({
			...acc,
			[f.name]: f.type,
		}),
		{},
	) ?? {};

export const filtersFromUrlGraphQL = (
	url: URL,
	customFilters?: Array<FiltersGraphQL>,
): ProductFilterInput =>
	DEFAULT_GRAPHQL_FILTERS.concat(customFilters ?? []).reduce<ProductFilterInput>(
		(acc, { type, value }) => {
			const fromUrl = url.searchParams.get(value);
			if (!fromUrl) {
				return acc;
			}
			return {
				...acc,
				[value]: transformFilterValueGraphQL(fromUrl, type),
			};
		},
		{},
	);

export const transformFilterValueGraphQL = (
	value: string,
	type: "EQUAL" | "MATCH" | "RANGE",
): FilterEqualTypeInput | FilterMatchTypeInput | FilterRangeTypeInput => {
	if (type === "EQUAL") {
		return { eq: value } as FilterEqualTypeInput;
	}

	if (type === "MATCH") {
		return { match: value } as FilterMatchTypeInput;
	}

	if (type === "RANGE") {
		const splitterIndex = value.indexOf("_");
		return {
			from: value.substring(0, splitterIndex),
			to: value.substring(splitterIndex + 1),
		} as FilterRangeTypeInput;
	}

	return {} as FilterEqualTypeInput;
};

/**
 * Normalize a URL path into the form Magento's
 * `urlResolver(url: "<path>/")` expects:
 *   - Strip a single leading slash (the resolver doesn't want it).
 *   - Ensure the path ends with `/`.
 *
 * Used by PLP / PDP / list / relatedProducts loaders as `defaultPath`
 * when `useSuffix` is enabled.
 */
export const formatUrlSuffix = (str: string): string => {
	let s = str;
	if (s.startsWith("/")) s = s.slice(1);
	if (!s.endsWith("/")) s = `${s}/`;
	return s;
};

/**
 * Resolve which custom-attribute list a loader should request:
 *
 *  - disabled (`active: false`) → undefined (loader projects nothing custom).
 *  - explicit override list set → return that list as-is.
 *  - otherwise → fall back to the global list provided by the loader.
 */
export const getCustomFields = (
	{ active, overrideList }: CustomFields = { active: false, overrideList: [] },
	customFields?: Array<string>,
): Array<string> | undefined => {
	if (!active) {
		return undefined;
	}

	if (overrideList && overrideList.length > 0) {
		return overrideList;
	}

	return customFields;
};
