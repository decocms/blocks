/**
 * VTEX auth helpers — pure functions for cookie extraction, JWT parsing,
 * Set-Cookie forwarding, and logout.
 *
 * These are consumed by site-level createServerFn wrappers in invoke.ts.
 * createServerFn itself must live in site source (not node_modules) because
 * TanStack Start's Vite plugin only transforms source files.
 */
import { getVtexConfig, getVtexFetch } from "../client";
import { extractVtexCookies } from "./cookieSanitizer";

const DOMAIN_RE = /;\s*domain=[^;]*/gi;

/**
 * Extract VTEX-relevant cookies from a raw Cookie header string.
 *
 * Strict allowlist: drops any cookie not on `VTEX_COOKIE_PREFIXES`, plus
 * any cookie whose value contains non-ASCII bytes (which would otherwise
 * make VTEX's janus gateway return 503 Service Unavailable). Both filters
 * live in `./cookieSanitizer` — this is a thin compatibility wrapper.
 */
export function extractVtexCookiesFromHeader(raw: string): string {
	return extractVtexCookies(raw);
}

/**
 * Strip Domain= from Set-Cookie headers so cookies are associated
 * with the storefront domain instead of the VTEX domain.
 */
export function stripCookieDomain(cookies: string[]): string[] {
	return cookies.map((c) => c.replace(DOMAIN_RE, ""));
}

/** Standard VTEX cookies to expire on logout. */
export const VTEX_LOGOUT_COOKIES = [
	"checkout.vtex.com=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
	"CheckoutOrderFormOwnership=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
	"checkout.vtex.com__orderFormId=; Path=/; Max-Age=0",
	"vtex_session=; Path=/; Max-Age=0",
	"vtex_segment=; Path=/; Max-Age=0",
];

/**
 * Perform VTEX logout — calls the VTEX ID logout endpoint and returns
 * the Set-Cookie headers (with domain stripped) to expire auth cookies.
 */
export async function performVtexLogout(cookies: string): Promise<{ setCookies: string[] }> {
	const config = getVtexConfig();
	const domain = config.domain ?? "com.br";
	const logoutUrl = `https://${config.account}.vtexcommercestable.${domain}/api/vtexid/pub/logout?scope=${config.account}&returnUrl=/`;

	const res = await getVtexFetch()(logoutUrl, {
		method: "GET",
		headers: { cookie: cookies },
		redirect: "manual",
		operation: "vtexid.logout",
	});

	const upstreamCookies = res.headers.getSetCookie?.() ?? [];

	return {
		setCookies: [...stripCookieDomain(upstreamCookies), ...VTEX_LOGOUT_COOKIES],
	};
}

/**
 * Parse VTEX auth JWT to extract email and userId.
 * Reads the VtexIdclientAutCookie_* cookie from a raw Cookie header.
 */
export function parseVtexAuthJwt(rawCookies: string): { email: string; userId: string } | null {
	try {
		const match = rawCookies.match(/VtexIdclientAutCookie_[^=]+=([^;]+)/);
		if (!match) return null;
		const token = match[1];
		const parts = token.split(".");
		if (parts.length < 2) return null;
		const payload = JSON.parse(
			Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
		);
		if (!payload.sub) return null;
		return { email: payload.sub, userId: payload.userId ?? "" };
	} catch {
		return null;
	}
}
