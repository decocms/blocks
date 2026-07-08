/**
 * Cache-time-control helpers — verbatim port of
 * `deco-cx/apps/magento/utils/cacheTimeControl.ts`.
 *
 * Magento product loaders pass the request URL through
 * `filterSearchParamsFromURL` before using it as a cache key, so that
 * tracking parameters (utm_*, gclid, fbclid, etc.) don't fragment the
 * cache across thousands of variants for what is conceptually the
 * same page.
 */

export const DEFAULT_CACHE_MAX_AGE = 3600; // 1h

/**
 * Pattern list (each entry is a regex source) of URL search-param
 * keys that get stripped before a Magento URL goes into the cache key
 * or downstream search-criteria. Mirrors prod byte-for-byte — the
 * `.*` suffixes intentionally match `utm_source`, `utm_medium`, etc.
 */
export const SEARCH_PARAMS_TO_IGNORE = [
	"gclid",
	"gbraid",
	"gdftrk",
	"_ga",
	"mc_.*",
	"trk_.*",
	"utm_.*",
	"sc_.*",
	"dm_i",
	"_ke",
	"fbclid",
	"qitc",
	"queryID",
	"indexName",
	"objectID",
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"gad_.*",
];

/**
 * Filter an array of [key, value] pairs, dropping any whose key matches
 * one of the `SEARCH_PARAMS_TO_IGNORE` regex patterns. Pure function so
 * callers can sort/transform after.
 */
export const filterSearchParams = (params: [string, string][]): [string, string][] => {
	return params.filter(
		([key]) => !SEARCH_PARAMS_TO_IGNORE.find((matchKey) => new RegExp(matchKey).test(key)),
	);
};

/**
 * Strip the tracking params from a URL (or URL string) and return the
 * cleaned `href`. Used by Magento PDP/PLP loaders as the cache key
 * basis so cache lookups don't depend on the visitor's referer chain.
 */
export const filterSearchParamsFromURL = (defaultURL: string | URL): string => {
	const url = new URL(defaultURL);
	const paramsArray = Array.from(url.searchParams.entries());
	const filteredParams = filterSearchParams(paramsArray);

	url.search = "";
	for (const [key, value] of filteredParams) {
		url.searchParams.append(key, value);
	}

	return url.href;
};
