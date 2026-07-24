/**
 * VTEX API Client for TanStack Start.
 * Uses VTEX's public REST APIs (Intelligent Search + Catalog + Checkout).
 */

import { withFetchTimeout } from "@decocms/blocks/sdk/fetchTimeout";
import type {
	InstrumentedFetch,
	InstrumentedFetchInit,
} from "@decocms/blocks/sdk/instrumentedFetch";
import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { sanitizeOutboundCookieHeader, warnDroppedCookies } from "./utils/cookieSanitizer";
import { type FetchCacheOptions, fetchWithCache } from "./utils/fetchCache";
import { ANONYMOUS_COOKIE, SESSION_COOKIE } from "./utils/intelligentSearch";
import { parseSegment, SEGMENT_COOKIE_NAME } from "./utils/segment";

/**
 * Outgoing response headers for the active request, or `null` when
 * called outside a request scope (which happens during module init).
 * `RequestContext.responseHeaders` was added to `@decocms/start` in
 * v0.39.0; we now require >=2.5.0 as a devDep so the property is
 * always typed/present.
 */
function getResponseHeaders(): Headers | null {
	const ctx = RequestContext.current;
	return ctx ? ctx.responseHeaders : null;
}

/**
 * Hostname of the active storefront request, or `null` outside a request
 * scope. Used to rewrite the `Domain` attribute of VTEX `Set-Cookie`
 * headers so server-function cookies are scoped identically to the ones
 * `createVtexCheckoutProxy` emits (`rewriteSetCookieDomain` → `url.hostname`)
 * and to what VTEX itself sets natively (`domain=<host>`).
 */
function getRequestHost(): string | null {
	const ctx = RequestContext.current;
	if (!ctx) return null;
	try {
		return new URL(ctx.request.url).hostname;
	} catch {
		return null;
	}
}

/**
 * Normalize a VTEX `Set-Cookie` so the browser accepts it on the storefront
 * host AND so it lands at the SAME cookie scope as the checkout proxy.
 *
 * VTEX sets `checkout.vtex.com` / `CheckoutOrderFormOwnership` with
 * `domain=<vtex-host>` (e.g. `casaevideonewio.vtexcommercestable.com.br`),
 * which the browser would reject on the storefront host. There are two ways
 * to make it acceptable:
 *
 *   - strip the `Domain` attribute   → host-only cookie
 *   - rewrite `Domain` to `<host>`    → domain-scoped cookie
 *
 * The checkout proxy does the latter. If this path does the former, the
 * cart's cookie (host-only) and the proxy's cookie (domain-scoped) become
 * TWO DISTINCT cookies in the browser: they don't overwrite each other, can
 * drift to different orderForm ids, and VTEX reads whichever is sent last
 * (RFC 6265 §5.4 orders by creation time) — a nondeterministic empty-cart
 * bug. Rewriting (instead of stripping) keeps both writers on the same key
 * so the newest write always wins. When the host is unknown (only at module
 * init, never inside a real request) we fall back to stripping.
 */
function rewriteCookieDomain(cookie: string, host: string | null): string {
	// Anchor to an attribute boundary (`; `) so we never touch a `domain=`
	// substring that happens to live inside the cookie value (before the
	// first `;`).
	return host
		? cookie.replace(/(;\s*)domain=[^;]*/i, `$1Domain=${host}`)
		: cookie.replace(/;\s*domain=[^;]*/gi, "");
}

// ---------------------------------------------------------------------------
// URL sanitization (ported from deco-cx/apps vtex/utils/fetchVTEX.ts)
// ---------------------------------------------------------------------------

const removeNonLatin1Chars = (str: string): string => str.replace(/[^\x00-\x7F]|["']/g, "");

const removeScriptChars = (str: string): string => {
	return str
		.replace(/\+/g, "")
		.replaceAll(" ", "")
		.replace(/[[\]{}()<>]/g, "")
		.replace(/[/\\]/g, "")
		.replace(/\./g, "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
};

function sanitizeUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return input;
	}

	const QS_TO_SANITIZE = ["utm_campaign", "utm_medium", "utm_source", "map"];
	for (const qs of QS_TO_SANITIZE) {
		if (url.searchParams.has(qs)) {
			const values = url.searchParams.getAll(qs);
			url.searchParams.delete(qs);
			for (const v of values) {
				const sanitized = removeScriptChars(removeNonLatin1Chars(v));
				if (sanitized) url.searchParams.append(qs, sanitized);
			}
		}
	}

	const QS_TO_ENCODE = ["ft"];
	for (const qs of QS_TO_ENCODE) {
		if (url.searchParams.has(qs)) {
			const values = url.searchParams.getAll(qs);
			url.searchParams.delete(qs);
			for (const v of values) {
				url.searchParams.append(qs, encodeURIComponent(v.trim()));
			}
		}
	}

	return url.toString();
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface VtexConfig {
	account: string;
	publicUrl?: string;
	salesChannel?: string;
	locale?: string;
	appKey?: string;
	appToken?: string;
	/**
	 * ISO 3166-1 alpha-3 country code used for simulation/checkout.
	 * @default "BRA"
	 */
	country?: string;
	/**
	 * VTEX domain suffix. Override for non-standard VTEX environments.
	 * @default "com.br"
	 */
	domain?: string;
}

let _config: VtexConfig | null = null;
let _fetch: typeof fetch | InstrumentedFetch = withFetchTimeout();

export function configureVtex(config: VtexConfig) {
	_config = config;
	console.log(`[VTEX] Configured: ${config.account}.vtexcommercestable.com.br`);
}

/**
 * Override the fetch function used by all VTEX client calls.
 * Pass an `InstrumentedFetch` to get spans, traceparent injection,
 * URL redaction, and the canonical `http.client.request.duration` histogram —
 * use the pre-wired `createVtexFetch()` factory:
 *
 * ```ts
 * import { setVtexFetch, createVtexFetch } from "@decocms/apps/vtex";
 * setVtexFetch(createVtexFetch());
 * ```
 *
 * Accepts a plain `typeof fetch` too; in that mode VTEX calls are
 * uninstrumented (useful for tests + sites that haven't onboarded
 * the observability stack yet).
 */
export function setVtexFetch(fetchFn: typeof fetch | InstrumentedFetch) {
	_fetch = fetchFn;
}

/**
 * Read-only accessor for the configured VTEX fetch. Used by ad-hoc
 * callsites that don't fit the `vtexFetch*` helpers (FormData
 * uploads, the storefront proxies, .aspx endpoints) but still want
 * to participate in the instrumentation set up via `setVtexFetch`.
 *
 * Callers can stamp a per-call operation through the init:
 *
 * ```ts
 * const fetch = getVtexFetch();
 * await fetch(url, { method: "POST", operation: "notifyme" });
 * ```
 */
export function getVtexFetch(): InstrumentedFetch {
	return _fetch as InstrumentedFetch;
}

export function getVtexConfig(): VtexConfig {
	if (!_config) throw new Error("VTEX not configured. Call configureVtex() first.");
	return _config;
}

/**
 * Build the VTEX hostname for a given environment.
 * Centralizes `{account}.{env}.{domain}` so nothing is hardcoded.
 */
export function vtexHost(environment: string = "vtexcommercestable", config?: VtexConfig): string {
	const c = config ?? getVtexConfig();
	const domain = c.domain ?? "com.br";
	return `${c.account}.${environment}.${domain}`;
}

function baseUrl(): string {
	return `https://${vtexHost()}`;
}

function isUrl(): string {
	return `https://${vtexHost()}/api/io/_v/api/intelligent-search`;
}

function authHeaders(): Record<string, string> {
	const c = getVtexConfig();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
	};
	if (c.appKey && c.appToken) {
		headers["X-VTEX-API-AppKey"] = c.appKey;
		headers["X-VTEX-API-AppToken"] = c.appToken;
	}
	return headers;
}

/**
 * Read regionId from the current request's vtex_segment cookie.
 * Returns null when outside a request context or no regionId is set.
 */
function extractRegionIdFromCookies(): string | null {
	const ctx = RequestContext.current;
	if (!ctx) return null;
	const cookies = ctx.request.headers.get("cookie");
	if (!cookies) return null;
	const match = cookies.match(new RegExp(`(?:^|;\\s*)${SEGMENT_COOKIE_NAME}=([^;]+)`));
	if (!match?.[1]) return null;
	const segment = parseSegment(match[1]);
	return segment?.regionId ?? null;
}

/**
 * Read the raw `vtex_segment=<token>` cookie from the active request.
 * Returns null when outside a request context or no segment cookie is set.
 *
 * Used to forward the segment cookie on outgoing VTEX API calls so
 * Legacy Catalog endpoints (which gate on the cookie, not on
 * `?regionId=` query params) see the right region for products
 * available only through regional sellers.
 */
function getSegmentCookieHeader(): string | null {
	const ctx = RequestContext.current;
	if (!ctx) return null;
	const cookies = ctx.request.headers.get("cookie");
	if (!cookies) return null;
	const match = cookies.match(new RegExp(`(?:^|;\\s*)${SEGMENT_COOKIE_NAME}=([^;]+)`));
	if (!match?.[1]) return null;
	return `${SEGMENT_COOKIE_NAME}=${match[1]}`;
}

/** Case-insensitive lookup for `cookie` / `Cookie` in a headers init. */
function hasCookieHeader(headers: HeadersInit | undefined): boolean {
	if (!headers) return false;
	if (headers instanceof Headers) return headers.has("cookie");
	if (Array.isArray(headers)) {
		return headers.some(([k]) => k.toLowerCase() === "cookie");
	}
	return Object.keys(headers).some((k) => k.toLowerCase() === "cookie");
}

/**
 * Read the cookie header value from any HeadersInit shape.
 * Returns undefined when no cookie header is set.
 */
function readCookieHeader(headers: HeadersInit | undefined): string | undefined {
	if (!headers) return undefined;
	if (headers instanceof Headers) return headers.get("cookie") ?? undefined;
	if (Array.isArray(headers)) {
		const found = headers.find(([k]) => k.toLowerCase() === "cookie");
		return found?.[1];
	}
	const rec = headers as Record<string, string>;
	const key = Object.keys(rec).find((k) => k.toLowerCase() === "cookie");
	return key ? rec[key] : undefined;
}

/**
 * Return a new Headers instance that copies `headers` and replaces the
 * `cookie` value with `cookieValue` (or removes it when undefined).
 * Centralises the "merge cookie into existing init.headers" operation so
 * we never spread a Headers instance as a plain object — that collapses
 * to {} because Headers has no own enumerable entries, and silently
 * wipes every other header the caller set. See PR #53.
 */
function withCookieHeader(
	headers: HeadersInit | undefined,
	cookieValue: string | undefined,
): Headers {
	const next = new Headers(headers ?? {});
	if (cookieValue) next.set("cookie", cookieValue);
	else next.delete("cookie");
	return next;
}

export async function vtexFetchResponse(
	path: string,
	init?: InstrumentedFetchInit,
): Promise<Response> {
	const raw = path.startsWith("http") ? path : `${baseUrl()}${path}`;
	const url = sanitizeUrl(raw);

	// Forward the incoming `vtex_segment` cookie on outgoing calls when
	// the caller hasn't set a cookie header explicitly. This is what the
	// Legacy Catalog API (and a handful of other VTEX endpoints) needs
	// to resolve regional sellers correctly. Without it, products only
	// available via a region's seller appear as OutOfStock on PDPs even
	// for users with the cookie. Sites used to wrap `_fetch` themselves
	// to do this — see https://github.com/decocms/apps-start#regional-sellers
	const segmentCookie = !hasCookieHeader(init?.headers) ? getSegmentCookieHeader() : null;

	const response = await _fetch(url, {
		...init,
		headers: mergeHeaders(authHeaders(), segmentCookie, init?.headers),
	});
	if (!response.ok) {
		throw new Error(`VTEX API error: ${response.status} ${response.statusText} - ${url}`);
	}
	return response;
}

/**
 * Combine framework headers + optional segment cookie + caller headers,
 * preserving the precedence "caller wins" regardless of whether the
 * caller passed `Headers`, `string[][]`, or `Record<string, string>`.
 *
 * Why a helper: the naive `{ ...authHeaders, ...init?.headers }` spread
 * silently collapses a `Headers` instance to `{}` (Headers has no own
 * enumerable entries), which means any cookies the caller put on a
 * Headers object are lost on the wire. The `createVtexCheckoutProxy`
 * factory passes init with Headers, which makes this the failure mode
 * for every forwarder that relies on browser-supplied cookies reaching
 * VTEX. Funneling all merges through the `Headers` constructor (which
 * correctly absorbs every HeadersInit shape) keeps the bug from
 * sneaking back in.
 */
function mergeHeaders(
	auth: Record<string, string>,
	segmentCookie: string | null,
	callerHeaders: HeadersInit | undefined,
): Headers {
	const merged = new Headers(auth);
	if (segmentCookie) merged.set("cookie", segmentCookie);
	if (callerHeaders) {
		const incoming = new Headers(callerHeaders);
		incoming.forEach((value, key) => {
			merged.set(key, value);
		});
	}
	return merged;
}

export async function vtexFetch<T>(path: string, init?: InstrumentedFetchInit): Promise<T> {
	const response = await vtexFetchResponse(path, init);
	return response.json();
}

export interface VtexCachedFetchOptions {
	/** SWR cache TTL override in ms */
	cacheTTL?: number;
}

/**
 * Like vtexFetch but routes GET requests through the SWR in-memory cache.
 * Uses in-flight dedup + stale-while-revalidate.
 * Non-GET requests fall through to regular vtexFetch.
 */
export async function vtexCachedFetch<T>(
	path: string,
	init?: InstrumentedFetchInit,
	cacheOpts?: VtexCachedFetchOptions,
): Promise<T | null> {
	const method = (init?.method ?? "GET").toUpperCase();
	if (method !== "GET") return vtexFetch<T>(path, init);

	const raw = path.startsWith("http") ? path : `${baseUrl()}${path}`;
	const url = sanitizeUrl(raw);
	const opts: FetchCacheOptions | undefined = cacheOpts?.cacheTTL
		? { ttl: cacheOpts.cacheTTL }
		: undefined;

	// Mirrors vtexFetchResponse: Legacy Catalog and several other GET
	// endpoints gate regional seller availability on the `vtex_segment`
	// cookie. Cached GETs (PDP / shelf product lookups) must see the same
	// regionalization the rest of the stack does — otherwise sites have
	// to wrap _fetch themselves to forward the cookie, which is easy to
	// get subtly wrong (especially around HeadersInit shapes). Inline
	// here keeps the surface small; if a third callsite appears we
	// extract a shared helper.
	const segmentCookie = !hasCookieHeader(init?.headers) ? getSegmentCookieHeader() : null;

	return fetchWithCache<T>(
		url,
		() =>
			_fetch(url, {
				...init,
				headers: mergeHeaders(authHeaders(), segmentCookie, init?.headers),
			}),
		opts,
	);
}

/**
 * Like vtexFetch, but also forwards Set-Cookie headers via RequestContext.
 * Use for checkout, session, and auth actions that set cookies.
 *
 * Cookie propagation happens automatically:
 * - Reads the browser's Cookie header from RequestContext.request
 * - Writes upstream Set-Cookie headers to RequestContext.responseHeaders
 * - The invoke handler copies responseHeaders into the HTTP Response
 *
 * This mirrors deco-cx/deco's `proxySetCookie(response.headers, ctx.response.headers)`.
 */
export async function vtexFetchWithCookies<T>(
	path: string,
	init?: InstrumentedFetchInit,
): Promise<T> {
	// Auto-inject request cookies from RequestContext.
	//
	// We sanitize the forwarded Cookie header before sending it to VTEX:
	// the janus gateway returns 503 (empty body) on any cookie value that
	// isn't strict ASCII per RFC 6265. Third-party analytics tags that write
	// raw UTF-8 into document.cookie (e.g. category names with accents) will
	// otherwise poison every checkout call for the affected user. The drop
	// report is emitted via warnDroppedCookies() so we have observability the
	// next time a tag misbehaves.
	//
	// Headers normalisation: callers pass either Headers, [name,value][],
	// or Record<string,string>. We must NEVER spread a Headers instance as
	// a plain object — it collapses to {} and silently drops every other
	// header the caller set (auth, content-type, etc.). withCookieHeader()
	// funnels every shape through the Headers constructor and is the only
	// safe way to rewrite the cookie value.
	const callerCookie = readCookieHeader(init?.headers);
	if (!callerCookie) {
		const ctx = RequestContext.current;
		const raw = ctx?.request.headers.get("cookie");
		if (raw) {
			const { cookies, dropped } = sanitizeOutboundCookieHeader(raw);
			if (dropped.length) warnDroppedCookies(dropped, vtexHost());
			if (cookies) {
				init = { ...init, headers: withCookieHeader(init?.headers, cookies) };
			}
		}
	} else {
		// Caller passed an explicit cookie — sanitize it too.
		const { cookies, dropped } = sanitizeOutboundCookieHeader(callerCookie);
		if (dropped.length) warnDroppedCookies(dropped, vtexHost());
		init = { ...init, headers: withCookieHeader(init?.headers, cookies) };
	}

	const response = await vtexFetchResponse(path, init);
	const data = (await response.json()) as T;

	// Forward Set-Cookie headers to RequestContext.responseHeaders,
	// but skip VTEX internal IS cookies (managed server-side by the middleware).
	const responseHeaders = getResponseHeaders();
	if (responseHeaders) {
		const host = getRequestHost();
		const setCookies =
			typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
		for (const cookie of setCookies) {
			if (cookie.startsWith(`${SESSION_COOKIE}=`) || cookie.startsWith(`${ANONYMOUS_COOKIE}=`)) {
				continue;
			}
			responseHeaders.append("set-cookie", rewriteCookieDomain(cookie, host));
		}
	}

	return data;
}

export async function intelligentSearch<T>(
	path: string,
	params?: Record<string, string>,
	opts?: { cookieHeader?: string; locale?: string; regionId?: string },
): Promise<T> {
	const url = new URL(`${isUrl()}${path}`);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			url.searchParams.set(k, v);
		}
	}
	const c = getVtexConfig();
	if (c.salesChannel) url.searchParams.set("sc", c.salesChannel);

	const locale = opts?.locale ?? c.locale;
	if (locale && !url.searchParams.has("locale")) {
		url.searchParams.set("locale", locale);
	}

	const regionId = opts?.regionId ?? extractRegionIdFromCookies();
	if (regionId) {
		url.searchParams.set("regionId", regionId);
	}

	const headers: Record<string, string> = { ...authHeaders() };
	if (opts?.cookieHeader) {
		headers.cookie = opts.cookieHeader;
	} else {
		// IS already gets regionId on the query string above, but some
		// internal IS flows (and downstream services it consults) still
		// honor the `vtex_segment` cookie — forward it when the caller
		// didn't pass an explicit one. See vtexCachedFetch for the same
		// rationale.
		const segmentCookie = getSegmentCookieHeader();
		if (segmentCookie) headers.cookie = segmentCookie;
	}

	const fullUrl = url.toString();

	return fetchWithCache<T>(fullUrl, async () => {
		const response = await _fetch(fullUrl, { headers });
		if (!response.ok) {
			throw new Error(`VTEX IS error: ${response.status} - ${fullUrl}`);
		}
		return response;
	}) as Promise<T>;
}

/**
 * Execute a GraphQL query against the VTEX IO Runtime (myvtex.com).
 * Used for private profile/session/wishlist/payment queries that the
 * original Deco loaders called via `ctx.io.query(...)`.
 */
export async function vtexIOGraphQL<T>(
	body: {
		query: string;
		variables?: Record<string, unknown> | null;
		operationName?: string;
	},
	headers?: Record<string, string>,
): Promise<T> {
	const { account } = getVtexConfig();
	const res = await vtexFetch<{ data: T; errors?: Array<{ message: string }> }>(
		`https://${account}.myvtex.com/_v/private/graphql/v1`,
		{
			method: "POST",
			headers,
			body: JSON.stringify(body),
		},
	);
	if (res.errors?.length) {
		throw new Error(`VTEX IO GraphQL error: ${res.errors.map((e) => e.message).join(", ")}`);
	}
	return res.data;
}

// -- Page Type API (used by PLP to derive category facets from URL path) --

export interface PageType {
	id: string;
	name: string;
	url: string;
	title: string;
	metaTagDescription: string;
	pageType:
		| "Brand"
		| "Category"
		| "Department"
		| "SubCategory"
		| "Collection"
		| "Cluster"
		| "Search"
		| "Product"
		| "NotFound"
		| "FullText";
}

const PAGE_TYPE_TO_MAP_PARAM: Record<string, string | null> = {
	Brand: "brand",
	Collection: "productClusterIds",
	Cluster: "productClusterIds",
	Search: null,
	Product: null,
	NotFound: null,
	FullText: null,
};

function pageTypeToMapParam(type: PageType["pageType"], index: number): string | null {
	if (type === "Category" || type === "Department" || type === "SubCategory") {
		return `category-${index + 1}`;
	}
	return PAGE_TYPE_TO_MAP_PARAM[type] ?? null;
}

function cachedPageType(term: string): Promise<PageType | null> {
	return vtexCachedFetch<PageType>(`/api/catalog_system/pub/portal/pagetype/${term}`);
}

/**
 * Query VTEX Page Type API for each path segment (cumulative).
 * Mirrors deco-cx/apps `pageTypesFromUrl`.
 * Uses in-flight deduplication to avoid duplicate calls for the same segment.
 */
export async function pageTypesFromPath(pagePath: string): Promise<PageType[]> {
	const segments = pagePath.split("/").filter(Boolean);
	const results = await Promise.all(
		segments.map((_, index) => {
			const term = segments.slice(0, index + 1).join("/");
			return cachedPageType(term);
		}),
	);
	return results.filter((pt): pt is PageType => pt !== null);
}

const slugify = (str: string) =>
	str
		.replace(/,/g, "")
		.replace(/[·/_,:]/g, "-")
		.replace(/[*+~.()'"!:@&[\]`/ %$#?{}|><=_^]/g, "-")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();

/**
 * Convert page types to selectedFacets with correct IS facet keys.
 * Mirrors deco-cx/apps `filtersFromPathname`.
 */
export function filtersFromPageTypes(pageTypes: PageType[]): Array<{ key: string; value: string }> {
	return pageTypes
		.map((page, index) => {
			const key = pageTypeToMapParam(page.pageType, index);
			if (!key || !page.name) return null;
			return { key, value: slugify(page.name) };
		})
		.filter((f): f is { key: string; value: string } => f !== null);
}

/**
 * Build the IS facet path string from selectedFacets.
 * Mirrors deco-cx/apps `toPath`.
 */
export function toFacetPath(facets: Array<{ key: string; value: string }>): string {
	return facets.map(({ key, value }) => (key ? `${key}/${value}` : value)).join("/");
}

export function initVtexFromBlocks(blocks: Record<string, any>) {
	const vtexBlock = blocks.vtex || blocks["deco-vtex"];
	if (!vtexBlock) {
		console.warn("[VTEX] No vtex.json block found.");
		return;
	}
	const appKey = typeof vtexBlock.appKey === "string" ? vtexBlock.appKey : undefined;
	const appToken = typeof vtexBlock.appToken === "string" ? vtexBlock.appToken : undefined;
	configureVtex({
		account: vtexBlock.account,
		publicUrl: vtexBlock.publicUrl,
		salesChannel: vtexBlock.salesChannel || "1",
		locale: vtexBlock.locale || vtexBlock.defaultLocale,
		appKey,
		appToken,
		country: vtexBlock.country,
		domain: vtexBlock.domain,
	});
}
