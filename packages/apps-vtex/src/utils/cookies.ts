interface Cookie {
	name: string;
	value: string;
	domain?: string;
	path?: string;
	expires?: Date;
	maxAge?: number;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: "Strict" | "Lax" | "None";
}

function parseSingleSetCookie(raw: string): Cookie | null {
	const parts = raw.split(";").map((p) => p.trim());
	const [nameValue, ...attrs] = parts;
	const eqIdx = nameValue.indexOf("=");
	if (eqIdx < 0) return null;
	const cookie: Cookie = {
		name: nameValue.slice(0, eqIdx),
		value: nameValue.slice(eqIdx + 1),
	};
	for (const attr of attrs) {
		const eqi = attr.indexOf("=");
		const k = (eqi >= 0 ? attr.slice(0, eqi) : attr).trim();
		const v = eqi >= 0 ? attr.slice(eqi + 1).trim() : "";
		const lower = k.toLowerCase();
		if (lower === "domain") cookie.domain = v;
		else if (lower === "path") cookie.path = v;
		else if (lower === "secure") cookie.secure = true;
		else if (lower === "httponly") cookie.httpOnly = true;
		else if (lower === "samesite") cookie.sameSite = v as Cookie["sameSite"];
		else if (lower === "max-age") {
			const n = Number(v);
			if (!Number.isNaN(n)) cookie.maxAge = n;
		} else if (lower === "expires") {
			const d = new Date(v);
			if (!Number.isNaN(d.getTime())) cookie.expires = d;
		}
	}
	return cookie;
}

/**
 * Extract individual Set-Cookie values from a Headers object.
 *
 * Uses Headers.getSetCookie() (available in Cloudflare Workers and Node 18+)
 * which returns each Set-Cookie as a separate string — unlike Headers.get()
 * or Headers.forEach() which join multiple values with ", " and corrupt
 * cookie strings that contain commas in Expires dates.
 */
function getSetCookies(headers: Headers): Cookie[] {
	const rawCookies: string[] =
		typeof headers.getSetCookie === "function"
			? headers.getSetCookie()
			: getRawSetCookiesFallback(headers);

	const cookies: Cookie[] = [];
	for (const raw of rawCookies) {
		const cookie = parseSingleSetCookie(raw);
		if (cookie) cookies.push(cookie);
	}
	return cookies;
}

/**
 * Fallback for runtimes without Headers.getSetCookie().
 * Splits the comma-joined string heuristically — not perfect for cookies
 * with Expires containing commas, but better than the old approach.
 */
function getRawSetCookiesFallback(headers: Headers): string[] {
	const joined = headers.get("set-cookie");
	if (!joined) return [];
	const results: string[] = [];
	let current = "";
	for (const segment of joined.split(",")) {
		const trimmed = segment.trimStart();
		const looksLikeNewCookie = /^[^=;]+=[^;]/.test(trimmed) && current.length > 0;
		if (looksLikeNewCookie) {
			results.push(current.trim());
			current = trimmed;
		} else {
			current += (current ? "," : "") + segment;
		}
	}
	if (current.trim()) results.push(current.trim());
	return results;
}

function setCookie(headers: Headers, cookie: Cookie): void {
	let str = `${cookie.name}=${cookie.value}`;
	if (cookie.domain) str += `; Domain=${cookie.domain}`;
	if (cookie.path) str += `; Path=${cookie.path}`;
	if (cookie.secure) str += "; Secure";
	if (cookie.httpOnly) str += "; HttpOnly";
	if (cookie.sameSite) str += `; SameSite=${cookie.sameSite}`;
	if (cookie.maxAge != null) str += `; Max-Age=${cookie.maxAge}`;
	if (cookie.expires) str += `; Expires=${cookie.expires.toUTCString()}`;
	headers.append("Set-Cookie", str);
}

export const stringify = (cookies: Record<string, string>) =>
	Object.entries(cookies)
		.map(([key, value]) => `${key}=${value}`)
		.join("; ");

export const proxySetCookie = (from: Headers, to: Headers, toDomain?: URL | string) => {
	const newDomain = toDomain && new URL(toDomain);

	for (const cookie of getSetCookies(from)) {
		const newCookie = newDomain
			? {
					...cookie,
					domain: newDomain.hostname,
				}
			: cookie;

		setCookie(to, newCookie);
	}
};

export const CHECKOUT_DATA_ACCESS_COOKIE = "CheckoutDataAccess";
export const VTEX_CHKO_AUTH = "Vtex_CHKO_Auth";

// Re-export the canonical allowlist from cookieSanitizer so consumers that
// previously imported it from this module keep working. The single source
// of truth lives in cookieSanitizer.ts.
export { VTEX_COOKIE_PREFIXES } from "./cookieSanitizer";

import { extractVtexCookies } from "./cookieSanitizer";

/**
 * Filter a request's cookies to only VTEX-relevant ones.
 *
 * Strict allowlist: drops any cookie not on `VTEX_COOKIE_PREFIXES` plus any
 * cookie whose value contains non-ASCII bytes (which would make VTEX's
 * janus gateway return 503).
 */
export function getVtexCookies(request: Request): string {
	return extractVtexCookies(request.headers.get("cookie") ?? "");
}

/**
 * Ensure the unsuffixed VtexIdclientAutCookie is present alongside the
 * account-suffixed variant (e.g. VtexIdclientAutCookie_myaccount).
 *
 * VTEX GraphQL requires both the suffixed AND unsuffixed cookie for
 * authenticated mutations. The browser only stores the suffixed variant,
 * so server-side code must synthesize the unsuffixed one.
 */
export function ensureUnsuffixedAuthCookie(cookieStr: string): string {
	if (!cookieStr) return cookieStr;
	const cookies = cookieStr.split(";").map((c) => c.trim());
	let hasUnsuffixed = false;
	let suffixedToken: string | null = null;
	for (const c of cookies) {
		const [name, ...rest] = c.split("=");
		if (name === "VtexIdclientAutCookie") {
			hasUnsuffixed = true;
		} else if (name?.startsWith("VtexIdclientAutCookie_") && !suffixedToken) {
			suffixedToken = rest.join("=");
		}
	}
	if (!hasUnsuffixed && suffixedToken) {
		return `VtexIdclientAutCookie=${suffixedToken}; ${cookieStr}`;
	}
	return cookieStr;
}
