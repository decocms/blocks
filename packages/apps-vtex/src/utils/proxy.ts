/**
 * VTEX Proxy Utility.
 *
 * Proxies storefront requests for /checkout, /account, /api, /files, /arquivos
 * to the VTEX origin. Essential for checkout and My Account pages to work.
 *
 * Two flavors:
 * - `proxyToVtex()` — simple single-origin proxy (vtexcommercestable)
 * - `createVtexCheckoutProxy()` — production-grade dual-origin proxy with
 *   proper cookie attribute preservation, non-ASCII sanitization, and
 *   configurable origin routing (checkout UI vs API paths)
 *
 * Designed to be used with TanStack Start API routes or Cloudflare Worker
 * fetch handlers.
 */

import { getVtexConfig, getVtexFetch, type VtexConfig, vtexHost } from "../client";
import { proxySetCookie } from "./cookies";

export interface VtexProxyOptions {
	/**
	 * VTEX environment suffix.
	 * @default "vtexcommercestable"
	 */
	environment?: "vtexcommercestable" | "vtexcommercebeta";

	/**
	 * Additional path prefixes to proxy beyond the defaults.
	 * Example: ["/custom-api/"]
	 */
	extraPaths?: string[];

	/**
	 * Paths that should NOT be proxied even if they match a prefix.
	 */
	excludePaths?: string[];

	/**
	 * Whether to rewrite Set-Cookie domains to the storefront's domain.
	 * @default true
	 */
	rewriteCookieDomain?: boolean;

	/**
	 * Custom headers to inject into every proxied request.
	 */
	extraHeaders?: Record<string, string>;
}

const DEFAULT_PROXY_PATHS = [
	"/checkout",
	"/checkout/",
	"/account",
	"/account/",
	"/api/",
	"/files/",
	"/arquivos/",
	"/checkout/changeToAnonymousUser/",
	"/_v/",
	"/no-cache/",
	"/graphql/",
	"/login",
	"/login/",
	"/logout",
	"/logout/",
	"/assets/vtex",
	"/_secure/account",
	"/XMLData/",
] as const;

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
]);

/**
 * Returns all path prefixes that should be proxied to VTEX.
 */
export function getVtexProxyPaths(options?: VtexProxyOptions): string[] {
	return [...DEFAULT_PROXY_PATHS, ...(options?.extraPaths ?? [])];
}

/**
 * Check if a request path should be proxied to VTEX.
 */
export function shouldProxyToVtex(pathname: string, options?: VtexProxyOptions): boolean {
	const paths = getVtexProxyPaths(options);
	const excluded = options?.excludePaths ?? [];

	if (excluded.some((ex) => pathname.startsWith(ex))) return false;
	return paths.some((prefix) => pathname.startsWith(prefix));
}

function buildOriginUrl(request: Request, config: VtexConfig, environment: string): URL {
	const url = new URL(request.url);
	const originHost = vtexHost(environment, config);
	return new URL(`https://${originHost}${url.pathname}${url.search}`);
}

/**
 * Copy headers excluding hop-by-hop and Set-Cookie.
 *
 * Set-Cookie is excluded intentionally: Headers.forEach / .set() joins
 * multiple Set-Cookie values with ", " which corrupts cookies containing
 * commas (e.g. Expires dates). proxySetCookie handles Set-Cookie
 * separately using Headers.getSetCookie() for correct multi-cookie support.
 */
function filterHeaders(headers: Headers): Headers {
	const filtered = new Headers();
	headers.forEach((value, key) => {
		const lower = key.toLowerCase();
		if (lower === "set-cookie") return;
		if (!HOP_BY_HOP_HEADERS.has(lower)) {
			filtered.set(key, value);
		}
	});
	return filtered;
}

/**
 * Proxy a request to VTEX origin.
 *
 * Forwards the request with all cookies and headers, rewrites
 * Set-Cookie domains on the response, and strips hop-by-hop headers.
 *
 * @example
 * ```ts
 * // In a TanStack Start API route or catch-all handler
 * if (shouldProxyToVtex(url.pathname)) {
 *   return proxyToVtex(request);
 * }
 * ```
 */
export async function proxyToVtex(request: Request, options?: VtexProxyOptions): Promise<Response> {
	const config = getVtexConfig();
	const environment = options?.environment ?? "vtexcommercestable";

	const originUrl = buildOriginUrl(request, config, environment);
	const forwardHeaders = filterHeaders(new Headers(request.headers));

	const requestUrl = new URL(request.url);
	forwardHeaders.set("origin", request.headers.get("origin") ?? requestUrl.origin);
	forwardHeaders.set("Host", originUrl.hostname);
	forwardHeaders.set("X-Forwarded-Host", requestUrl.host);
	forwardHeaders.set("X-Forwarded-Proto", "https");

	if (options?.extraHeaders) {
		for (const [k, v] of Object.entries(options.extraHeaders)) {
			forwardHeaders.set(k, v);
		}
	}

	if (typeof config.appKey === "string" && typeof config.appToken === "string") {
		forwardHeaders.set("X-VTEX-API-AppKey", config.appKey);
		forwardHeaders.set("X-VTEX-API-AppToken", config.appToken);
	}

	const init: RequestInit = {
		method: request.method,
		headers: forwardHeaders,
		redirect: "manual",
	};

	if (request.method !== "GET" && request.method !== "HEAD") {
		init.body = request.body;
		// @ts-expect-error -- needed for streaming body in Workers
		init.duplex = "half";
	}

	// Route through the configured VTEX fetch so traces / metrics / logs
	// see the proxied origin call. The URL router classifies the call
	// into the right `vtex.<area>.<op>` bucket (e.g. `vtex.checkout.*`,
	// `vtex.vtexid.logout`, `vtex.io.segment`) — no per-callsite hint
	// needed because we're a generic forwarder.
	const originResponse = await getVtexFetch()(originUrl.toString(), init);

	const responseHeaders = filterHeaders(new Headers(originResponse.headers));

	proxySetCookie(
		originResponse.headers,
		responseHeaders,
		options?.rewriteCookieDomain !== false ? requestUrl.origin : undefined,
	);

	if (originResponse.status >= 300 && originResponse.status < 400) {
		const location = originResponse.headers.get("location");
		if (location) {
			const originVtexHost = vtexHost(environment, config);
			const storefrontOrigin = requestUrl.origin;
			const vtexOrigin = `https://${originVtexHost}`;
			const rewritten = location.replace(vtexOrigin, storefrontOrigin);
			responseHeaders.set("location", rewritten);
		}
	}

	return new Response(originResponse.body, {
		status: originResponse.status,
		statusText: originResponse.statusText,
		headers: responseHeaders,
	});
}

// ---------------------------------------------------------------------------
// Production-grade checkout proxy factory
// ---------------------------------------------------------------------------

export interface VtexCheckoutProxyConfig {
	/** VTEX account name (e.g. "casaevideonewio"). */
	account: string;

	/**
	 * Store's public checkout domain (e.g. "secure.casaevideo.com.br").
	 * Checkout UI, /files/, and /_v/private/graphql are routed here.
	 */
	checkoutOrigin: string;

	/**
	 * VTEX commerce-stable origin for API calls.
	 * @default `https://{account}.vtexcommercestable.com.br`
	 */
	apiOrigin?: string;

	/**
	 * myvtex origin — used for redirect rewriting.
	 * @default `https://{account}.myvtex.com`
	 */
	myvtexOrigin?: string;

	/**
	 * VTEX TLD — most accounts use `.com.br`, but some use `.com`.
	 * @default "com.br"
	 */
	domain?: string;

	/**
	 * Extra paths on which to force-expire cookies.
	 * Useful for logout: VTEX sends Max-Age=0 for auth cookies, but the
	 * checkout orderForm cookie sometimes survives. This appends explicit
	 * Set-Cookie: name=; Max-Age=0 entries.
	 */
	expireCookiesOnPaths?: Array<{
		pathPrefix: string;
		cookies: string[];
	}>;

	/**
	 * Optional HTML transform for checkout pages.
	 * Receives the full HTML string and should return the modified version.
	 */
	htmlTransform?: (html: string) => string;
}

const CF_INTERNAL_HEADERS = new Set([
	"cf-connecting-ip",
	"cf-ipcountry",
	"cf-ray",
	"cf-visitor",
	"cf-ew-via",
	"cdn-loop",
]);

const CHECKOUT_SKIP_HEADERS = new Set([
	...HOP_BY_HOP_HEADERS,
	"set-cookie",
	...CF_INTERNAL_HEADERS,
]);

const toAscii = (v: string) => v.replace(/[^\x20-\x7E]/g, "");

function filterHeadersStrict(headers: Headers): Headers {
	const filtered = new Headers();
	headers.forEach((value, key) => {
		if (CHECKOUT_SKIP_HEADERS.has(key.toLowerCase())) return;
		try {
			filtered.set(key, toAscii(value));
		} catch {
			// skip headers that still fail after sanitization
		}
	});
	return filtered;
}

/**
 * Rewrite Set-Cookie headers: only change the Domain attribute.
 * Unlike `proxySetCookie`, this preserves ALL attributes (Max-Age,
 * Expires, SameSite, etc.) which is critical for logout.
 */
function rewriteSetCookieDomain(from: Headers, to: Headers, toHostname: string) {
	const raw: string[] =
		typeof from.getSetCookie === "function"
			? from.getSetCookie()
			: (from.get("set-cookie") ?? "").split(/,(?=[^ ]+=)/).filter(Boolean);

	for (const cookie of raw) {
		const rewritten = cookie.replace(/Domain=[^;]*/i, `Domain=${toHostname}`);
		to.append("Set-Cookie", rewritten);
	}
}

/**
 * Creates a production-grade VTEX checkout proxy handler.
 *
 * Routes checkout UI pages to the store's public domain and API calls
 * to vtexcommercestable. Properly rewrites Set-Cookie domains (preserving
 * Max-Age/Expires), sanitizes non-ASCII headers, filters hop-by-hop and
 * CF-internal headers, and rewrites Location redirects.
 *
 * Returns a function compatible with `createDecoWorkerEntry`'s `proxyHandler`.
 *
 * @example
 * ```ts
 * const vtexProxy = createVtexCheckoutProxy({
 *   account: "casaevideonewio",
 *   checkoutOrigin: "secure.casaevideo.com.br",
 *   expireCookiesOnPaths: [
 *     { pathPrefix: "/api/vtexid/pub/logout", cookies: ["checkout.vtex.com"] },
 *   ],
 *   htmlTransform: (html) =>
 *     html.replace("</head>", "<style>.body{min-height:100vh}</style></head>"),
 * });
 *
 * createDecoWorkerEntry(serverEntry, {
 *   proxyHandler: async (request, url) => {
 *     if (url.pathname === "/login") return null;
 *     if (!shouldProxyToVtex(url.pathname)) return null;
 *     return vtexProxy(request, url);
 *   },
 * });
 * ```
 */
export function createVtexCheckoutProxy(
	config: VtexCheckoutProxyConfig,
): (request: Request, url: URL) => Promise<Response> {
	const domain = config.domain ?? "com.br";
	const checkoutOrigin = config.checkoutOrigin.startsWith("https://")
		? config.checkoutOrigin
		: `https://${config.checkoutOrigin}`;
	const apiOrigin = config.apiOrigin ?? `https://${config.account}.vtexcommercestable.${domain}`;
	const myvtexOrigin = config.myvtexOrigin ?? `https://${config.account}.myvtex.com`;

	function getOrigin(pathname: string, method: string): string {
		if (
			pathname.startsWith("/checkout") ||
			pathname.startsWith("/account") ||
			pathname.startsWith("/_secure/account") ||
			pathname.startsWith("/files/") ||
			pathname.startsWith("/_v/private/graphql")
		) {
			return checkoutOrigin;
		}
		if (method !== "GET" && method !== "HEAD" && pathname.startsWith("/_v/")) {
			return checkoutOrigin;
		}
		return apiOrigin;
	}

	return async (request: Request, url: URL): Promise<Response> => {
		const origin = getOrigin(url.pathname, request.method);
		const originUrl = new URL(`${origin}${url.pathname}${url.search}`);
		const fwd = filterHeadersStrict(new Headers(request.headers));

		fwd.set("Host", originUrl.hostname);
		fwd.set("X-Forwarded-Host", url.host);
		fwd.set("X-Forwarded-Proto", "https");
		fwd.set("origin", request.headers.get("origin") ?? url.origin);

		const isCheckoutUI =
			url.pathname.startsWith("/checkout") || url.pathname.startsWith("/account");
		const isLogout = url.pathname.startsWith("/api/vtexid/pub/logout");

		const init: RequestInit = {
			method: request.method,
			headers: fwd,
			redirect: isCheckoutUI || isLogout ? "manual" : "follow",
		};
		if (request.method !== "GET" && request.method !== "HEAD") {
			init.body = request.body;
			// @ts-expect-error -- needed for streaming body in Workers
			init.duplex = "half";
		}

		const originRes = await getVtexFetch()(originUrl.toString(), init);
		const resHeaders = filterHeadersStrict(new Headers(originRes.headers));
		rewriteSetCookieDomain(originRes.headers, resHeaders, url.hostname);

		// Force-expire cookies on configured paths
		if (config.expireCookiesOnPaths) {
			for (const rule of config.expireCookiesOnPaths) {
				if (url.pathname.startsWith(rule.pathPrefix)) {
					for (const name of rule.cookies) {
						resHeaders.append("Set-Cookie", `${name}=; Path=/; Max-Age=0; Domain=${url.hostname}`);
					}
				}
			}
		}

		// Rewrite redirect Location headers from VTEX domains to storefront
		if (originRes.status >= 300 && originRes.status < 400) {
			const loc = originRes.headers.get("location");
			if (loc) {
				resHeaders.set(
					"location",
					loc
						.replace(checkoutOrigin, url.origin)
						.replace(apiOrigin, url.origin)
						.replace(myvtexOrigin, url.origin),
				);
			}
		}

		// HTML transform for checkout pages
		const ct = originRes.headers.get("content-type") ?? "";
		if (config.htmlTransform && ct.includes("text/html")) {
			const html = await originRes.text();
			const patched = config.htmlTransform(html);
			return new Response(patched, {
				status: originRes.status,
				statusText: originRes.statusText,
				headers: resHeaders,
			});
		}

		return new Response(originRes.body, {
			status: originRes.status,
			statusText: originRes.statusText,
			headers: resHeaders,
		});
	};
}
