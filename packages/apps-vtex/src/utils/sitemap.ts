/**
 * VTEX Sitemap utilities.
 *
 * Two flavors:
 * - `getVtexSitemapEntries()` — flatten VTEX sub-sitemaps into a single
 *   `SitemapEntry[]` list, for composition with the CMS sitemap generator.
 * - `createVtexSitemapProxy()` — proxy `/sitemap.xml` and `/sitemap/*`
 *   straight from VTEX's commerce-stable origin, preserving the sitemap-index
 *   shape (so crawlers stay within Google's per-file size limit). This is the
 *   right choice when the storefront has no native sitemap renderer and just
 *   needs to expose VTEX's existing crawl tree to the public hostname.
 */

import { getVtexConfig, vtexFetchResponse, vtexHost } from "../client";

export interface SitemapEntry {
	loc: string;
	lastmod?: string;
	changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
	priority?: number;
}

/**
 * Fetch sitemap entries from VTEX's sitemap API.
 *
 * VTEX exposes /sitemap.xml which contains links to sub-sitemaps
 * (products, categories, brands, etc.). This function fetches the
 * main sitemap index and extracts all <loc> entries from the
 * referenced sub-sitemaps.
 *
 * @param origin - The storefront origin (e.g., "https://www.mystore.com")
 * @param options.maxDepth - How many levels of sub-sitemaps to follow (default: 1)
 * @param options.rewriteHost - Whether to rewrite VTEX hostnames to the storefront origin (default: true)
 */
export async function getVtexSitemapEntries(
	origin: string,
	options?: {
		maxDepth?: number;
		rewriteHost?: boolean;
		includeBrands?: boolean;
		includeCategories?: boolean;
		includeProducts?: boolean;
	},
): Promise<SitemapEntry[]> {
	const config = getVtexConfig();
	const vtexSitemapHost = vtexHost("vtexcommercestable", config);
	const rewrite = options?.rewriteHost !== false;
	const includeProducts = options?.includeProducts !== false;
	const includeCategories = options?.includeCategories !== false;
	const includeBrands = options?.includeBrands !== false;

	try {
		const mainSitemapUrl = `https://${vtexSitemapHost}/sitemap.xml`;
		const mainResponse = await vtexFetchResponse(mainSitemapUrl);
		const mainXml = await mainResponse.text();

		const subSitemapUrls = extractLocs(mainXml);
		const entries: SitemapEntry[] = [];

		const filteredUrls = subSitemapUrls.filter((url) => {
			const lower = url.toLowerCase();
			if (!includeProducts && lower.includes("product")) return false;
			if (!includeCategories && lower.includes("categor")) return false;
			if (!includeBrands && lower.includes("brand")) return false;
			return true;
		});

		const maxDepth = options?.maxDepth ?? 1;
		if (maxDepth < 1) {
			return filteredUrls.map((url) => ({
				loc: rewrite ? rewriteUrl(url, vtexSitemapHost, origin) : url,
				changefreq: "daily" as const,
				priority: 0.5,
			}));
		}

		const settled = await Promise.allSettled(
			filteredUrls.map(async (subUrl) => {
				try {
					const resp = await vtexFetchResponse(subUrl);
					const xml = await resp.text();
					return extractLocs(xml);
				} catch {
					return [];
				}
			}),
		);

		const today = new Date().toISOString().split("T")[0];

		for (const result of settled) {
			if (result.status !== "fulfilled") continue;
			for (const loc of result.value) {
				entries.push({
					loc: rewrite ? rewriteUrl(loc, vtexSitemapHost, origin) : loc,
					lastmod: today,
					changefreq: "daily",
					priority: 0.5,
				});
			}
		}

		return entries;
	} catch (error) {
		console.error("[VTEX Sitemap] Failed to fetch VTEX sitemap:", error);
		return [];
	}
}

function extractLocs(xml: string): string[] {
	const locs: string[] = [];
	const regex = /<loc>\s*(.*?)\s*<\/loc>/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(xml)) !== null) {
		if (match[1]) locs.push(match[1].trim());
	}
	return locs;
}

function rewriteUrl(url: string, vtexSitemapHost: string, origin: string): string {
	try {
		const parsed = new URL(url);
		const originParsed = new URL(origin);
		const config = getVtexConfig();
		const domain = config.domain ?? "com.br";
		if (
			parsed.hostname === vtexSitemapHost ||
			parsed.hostname.endsWith(`.vtexcommercestable.${domain}`)
		) {
			parsed.protocol = originParsed.protocol;
			parsed.hostname = originParsed.hostname;
			parsed.port = originParsed.port;
		}
		return parsed.toString();
	} catch {
		return url.replace(`https://${vtexSitemapHost}`, origin);
	}
}

// ---------------------------------------------------------------------------
// VTEX sitemap proxy factory
// ---------------------------------------------------------------------------

/**
 * Returns true if `pathname` is one of the proxied sitemap paths
 * (`/sitemap.xml` or any `/sitemap/*` sub-sitemap).
 */
export function isVtexSitemapPath(pathname: string): boolean {
	return pathname === "/sitemap.xml" || pathname.startsWith("/sitemap/");
}

export interface VtexSitemapProxyConfig {
	/**
	 * Extra `<sitemap>` entries to inject into the root sitemap index
	 * (`/sitemap.xml` only — sub-sitemaps are passed through untouched).
	 *
	 * Useful for site-managed sitemaps such as a static search-result
	 * index (`sitemap-busca.xml`) that VTEX doesn't generate.
	 *
	 * Each value is normalized to an absolute URL on the storefront
	 * origin: leading-slash paths become `${origin}${path}`, and bare
	 * names become `${origin}/${name}`. Absolute URLs are used as-is.
	 *
	 * @example ["/sitemap-busca.xml"]
	 */
	extraSitemaps?: string[];

	/**
	 * VTEX environment for the upstream sitemap fetch.
	 * @default "vtexcommercestable"
	 */
	environment?: "vtexcommercestable" | "vtexcommercebeta";

	/**
	 * `Cache-Control` header to set on proxied responses. The default
	 * favors edge caching (Cloudflare honors `s-maxage`) with a long
	 * stale-while-revalidate window so a slow VTEX origin never blocks
	 * crawlers.
	 *
	 * @default "public, s-maxage=3600, stale-while-revalidate=86400"
	 */
	cacheControl?: string;

	/**
	 * Optional fetch override — primarily for tests. Defaults to the
	 * platform `fetch`.
	 */
	fetchImpl?: typeof fetch;
}

const DEFAULT_SITEMAP_CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";

function normalizeExtraSitemap(entry: string, origin: string): string {
	if (entry.startsWith("http://") || entry.startsWith("https://")) return entry;
	const path = entry.startsWith("/") ? entry : `/${entry}`;
	return `${origin}${path}`;
}

/**
 * Creates a sitemap proxy handler that mirrors VTEX's `/sitemap.xml`
 * (and sub-sitemaps) onto the storefront origin.
 *
 * Returns a function compatible with `createDecoWorkerEntry`'s
 * `proxyHandler`: it returns `null` for non-sitemap paths, so it
 * composes naturally with other proxy handlers
 * (`createVtexCheckoutProxy`, custom logic, etc.).
 *
 * The VTEX account is read from the `configureVtex(...)` call done at
 * worker startup — no per-call account configuration is needed.
 *
 * @example
 * ```ts
 * import { createVtexSitemapProxy } from "@decocms/apps/vtex/utils/sitemap";
 * import {
 *   createVtexCheckoutProxy,
 *   shouldProxyToVtex,
 * } from "@decocms/apps/vtex/utils/proxy";
 *
 * const proxySitemap = createVtexSitemapProxy({
 *   extraSitemaps: ["/sitemap-busca.xml"], // optional, site-managed
 * });
 * const proxyCheckout = createVtexCheckoutProxy({ ... });
 *
 * createDecoWorkerEntry(serverEntry, {
 *   proxyHandler: async (request, url) => {
 *     const sitemap = await proxySitemap(request, url);
 *     if (sitemap) return sitemap;
 *
 *     if (!shouldProxyToVtex(url.pathname)) return null;
 *     return proxyCheckout(request, url);
 *   },
 * });
 * ```
 */
export function createVtexSitemapProxy(
	config: VtexSitemapProxyConfig = {},
): (request: Request, url: URL) => Promise<Response | null> {
	const environment = config.environment ?? "vtexcommercestable";
	const cacheControl = config.cacheControl ?? DEFAULT_SITEMAP_CACHE_CONTROL;
	const extraSitemaps = config.extraSitemaps ?? [];
	const fetchImpl = config.fetchImpl ?? fetch;

	return async (_request: Request, url: URL): Promise<Response | null> => {
		if (!isVtexSitemapPath(url.pathname)) return null;

		// vtexHost() reads the configured account from configureVtex().
		const vtexSitemapHost = vtexHost(environment);
		const target = `https://${vtexSitemapHost}${url.pathname}`;

		try {
			const resp = await fetchImpl(target);
			if (!resp.ok) {
				console.error(`[vtex-sitemap] VTEX returned ${resp.status} for ${url.pathname}`);
				return new Response("Sitemap temporarily unavailable", { status: 502 });
			}

			let xml = await resp.text();
			xml = xml.replaceAll(`https://${vtexSitemapHost}`, url.origin);

			if (url.pathname === "/sitemap.xml" && extraSitemaps.length > 0) {
				const extraEntries = extraSitemaps
					.map(
						(s) =>
							`  <sitemap>\n    <loc>${normalizeExtraSitemap(s, url.origin)}</loc>\n  </sitemap>`,
					)
					.join("\n");
				xml = xml.replace("</sitemapindex>", `${extraEntries}\n</sitemapindex>`);
			}

			return new Response(xml, {
				status: 200,
				headers: {
					"Content-Type": "application/xml; charset=utf-8",
					"Cache-Control": cacheControl,
				},
			});
		} catch (err) {
			console.error("[vtex-sitemap] Failed to proxy VTEX sitemap:", err);
			return new Response("Sitemap temporarily unavailable", { status: 502 });
		}
	};
}
