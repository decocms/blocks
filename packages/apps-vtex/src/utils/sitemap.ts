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

import { type FetchFn, withFetchTimeout } from "@decocms/blocks/sdk/fetchTimeout";
import { getAllPages, matchPath } from "@decocms/blocks/cms";
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
	 * `<sitemap>` entries inserted at the TOP of the root index, each stamped
	 * with today's `<lastmod>` — the `include` of deco-cx
	 * `vtex/handlers/sitemap.ts` (site.json `includeSiteMapWithHandler`),
	 * for sitemaps the storefront itself serves (CMS pages, blog posts).
	 * Leading-slash paths become `${origin}${path}`; absolute URLs are used
	 * as-is. `extraSitemaps` appends undated entries at the bottom instead.
	 *
	 * @example ["/sitemap/deco.xml", "/sitemap/the-post-posts.xml"]
	 */
	include?: string[];

	/**
	 * Drops every `<sitemap>` of the root index whose `<loc>` contains or ends
	 * with one of these — deco-cx's `excludeSiteMapEntry`.
	 *
	 * @example ["/custom-user-routes-1.xml", "/brand-0.xml"]
	 */
	excludeSiteMapEntry?: string[];

	/**
	 * Drops every `<url>` of a sub-sitemap whose path no CMS page answers —
	 * deco-cx's `removeEntriesWithoutPage`. The platform's category tree and
	 * the storefront's pages are maintained by different teams, so a
	 * category created upstream reaches the sitemap before its page exists
	 * and answers 404; announcing it to crawlers is worse than omitting it.
	 * Catch-all pages (`/*`, the 404 page) are not counted as answering.
	 * `<sitemap>` entries of the index are never touched.
	 *
	 * Pass `{ servesPath }` for paths served outside the CMS (VTEX proxies,
	 * custom handlers) that should also count as answered.
	 */
	removeEntriesWithoutPage?: boolean | { servesPath?: (pathname: string) => boolean };

	/**
	 * Drops `<lastmod>` from every `<url>` — deco-cx's `removeUrlLastmod`.
	 * VTEX stamps each entry with the day the file was generated, which says
	 * nothing about the page; crawlers that notice learn to ignore the field
	 * for the whole site. `<sitemap>` blocks of the index keep theirs.
	 */
	removeUrlLastmod?: boolean;

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
	fetchImpl?: FetchFn;
}

const DEFAULT_SITEMAP_CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";

function normalizeExtraSitemap(entry: string, origin: string): string {
	if (entry.startsWith("http://") || entry.startsWith("https://")) return entry;
	const path = entry.startsWith("/") ? entry : `/${entry}`;
	return `${origin}${path}`;
}

const SITEMAP_INDEX_OPEN = /<sitemapindex[^>]*>/i;

/** Same insertion as deco-cx: right after the opening tag, dated today. */
export function includeSitemaps(xml: string, origin: string, includes: string[]): string {
	if (!includes.length) return xml;
	const today = new Date().toISOString().substring(0, 10);
	const tags = includes
		.map(
			(include) =>
				`\n  <sitemap>\n    <loc>${normalizeExtraSitemap(include, origin)}</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>`,
		)
		.join("\n");
	return xml.replace(SITEMAP_INDEX_OPEN, (open) => `${open}${tags}`);
}

export function excludeSitemapEntries(xml: string, exclude: string[]): string {
	if (!exclude.length) return xml;
	return xml.replace(
		/<sitemap>\s*<loc>([^<]*)<\/loc>[\s\S]*?<\/sitemap>/gi,
		(block, loc: string) =>
			exclude.some((entry) => loc.includes(entry) || loc.endsWith(entry)) ? "" : block,
	);
}

/** Drops `<lastmod>` from every `<url>`; `<sitemap>` blocks of an index keep theirs. */
export function dropUrlLastmod(xml: string): string {
	return xml.replace(/<url>[\s\S]*?<\/url>/gi, (block) =>
		block.replace(/\s*<lastmod>[^<]*<\/lastmod>/gi, ""),
	);
}

const XML_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
};

/**
 * A <loc> holds XML, so its URL arrives entity-encoded: the router would be
 * handed "?a=1&b=2" where the document says "?a=1&amp;b=2".
 */
const decodeXmlEntities = (value: string) =>
	value.replace(/&(?:amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (entity, dec, hex) => {
		if (dec) return String.fromCodePoint(Number(dec));
		if (hex) return String.fromCodePoint(parseInt(hex, 16));
		return XML_ENTITIES[entity.toLowerCase()] ?? entity;
	});

/**
 * What tells a catch-all apart from any other route is that it answers paths
 * of differing depth. Only a page answering all three of these is one no URL
 * can fail to match — "/:department/:category" answers the second alone.
 */
const CATCH_ALL_PROBES = ["/9d2f7b1e-probe", "/9d2f7b1e-probe/a", "/9d2f7b1e-probe/a/b/c"];
const PATTERN_SYNTAX = /[:*(){}+?[\]\\|]/;

/** Enough to act on without letting a large sitemap write megabytes of log. */
const SAMPLE_SIZE = 20;

/**
 * Drops the `<url>` entries no CMS page answers (see
 * `removeEntriesWithoutPage`). Static page paths go to a set so a sitemap of
 * tens of thousands of URLs does not walk hundreds of routes per entry.
 */
export function dropEntriesWithoutPage(
	xml: string,
	servesPath: (pathname: string) => boolean = () => false,
	sitemap = "",
): string {
	const staticPaths = new Set<string>();
	const patterns: string[] = [];

	for (const { page } of getAllPages()) {
		const path = page.path;
		if (!path) continue;
		try {
			if (CATCH_ALL_PROBES.every((probe) => matchPath(path, probe) !== null)) continue;
			if (PATTERN_SYNTAX.test(path)) patterns.push(path);
			else staticPaths.add(path);
		} catch {
			// A page the router itself could not compile matches nothing.
		}
	}

	// No page to compare against says the pages could not be read, not that
	// the site has none — keep the sitemap whole rather than empty it.
	if (staticPaths.size + patterns.length === 0) {
		console.error("[vtex-sitemap] no page to check entries against", { sitemap });
		return xml;
	}

	let count = 0;
	const sample: string[] = [];

	const filtered = xml.replace(/<url>\s*<loc>([^<]*)<\/loc>[\s\S]*?<\/url>\s*/gi, (block, loc: string) => {
		const href = decodeXmlEntities(loc);
		if (!URL.canParse(href)) return block;
		const { pathname } = new URL(href);
		const served =
			staticPaths.has(pathname) ||
			servesPath(pathname) ||
			patterns.some((pattern) => matchPath(pattern, pathname) !== null);
		if (served) return block;
		count += 1;
		if (sample.length < SAMPLE_SIZE) sample.push(href);
		return "";
	});

	if (count > 0) {
		console.warn("[vtex-sitemap] entries removed because no page answers their path", {
			sitemap,
			count,
			sample,
			truncated: count > sample.length,
		});
	}

	return filtered;
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
	const include = config.include ?? [];
	const excludeEntries = config.excludeSiteMapEntry ?? [];
	const removeWithoutPage = config.removeEntriesWithoutPage ?? false;
	const servesPath =
		typeof removeWithoutPage === "object" ? removeWithoutPage.servesPath : undefined;
	const removeUrlLastmod = config.removeUrlLastmod ?? false;
	const fetchImpl = config.fetchImpl ?? withFetchTimeout();

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

			if (url.pathname === "/sitemap.xml") {
				xml = excludeSitemapEntries(includeSitemaps(xml, url.origin, include), excludeEntries);
				if (extraSitemaps.length > 0) {
					const extraEntries = extraSitemaps
						.map(
							(s) =>
								`  <sitemap>\n    <loc>${normalizeExtraSitemap(s, url.origin)}</loc>\n  </sitemap>`,
						)
						.join("\n");
					xml = xml.replace("</sitemapindex>", `${extraEntries}\n</sitemapindex>`);
				}
			} else {
				if (removeWithoutPage) {
					try {
						xml = dropEntriesWithoutPage(xml, servesPath, url.pathname);
					} catch (err) {
						console.error("[vtex-sitemap] failed to check entries against the pages:", err);
					}
				}
				if (removeUrlLastmod) xml = dropUrlLastmod(xml);
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
