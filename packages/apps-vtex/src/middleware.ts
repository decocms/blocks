/**
 * VTEX Middleware utilities for TanStack Start.
 *
 * Extracts segment information from cookies/URL params, detects login state,
 * propagates Intelligent Search cookies, and provides cache-control decisions.
 *
 * Use with TanStack Start's createMiddleware() in the storefront:
 *
 * @example
 * ```ts
 * import { createMiddleware } from "@tanstack/react-start";
 * import {
 *   extractVtexContext,
 *   vtexCacheControl,
 * } from "@decocms/apps/vtex/middleware";
 *
 * const vtexMiddleware = createMiddleware().server(async ({ next, request }) => {
 *   const vtexCtx = extractVtexContext(request);
 *   const response = await next();
 *   response.headers.set("Cache-Control", vtexCacheControl(vtexCtx));
 *   propagateISCookies(request, response);
 *   return response;
 * });
 * ```
 */

import { ANONYMOUS_COOKIE, SESSION_COOKIE } from "./utils/intelligentSearch";
import {
	buildSegmentFromParams,
	DEFAULT_SEGMENT,
	parseSegment,
	SALES_CHANNEL_COOKIE,
	SEGMENT_COOKIE_NAME,
	serializeSegment,
} from "./utils/segment";
import type { Segment } from "./utils/types";
import { extractVtexAuthCookie, parseVtexAuthToken } from "./utils/vtexId";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export interface VtexRequestContext {
	/** Decoded segment from cookie or URL params. */
	segment: Partial<Segment>;
	/** Serialized segment token for cache key use. */
	segmentToken: string;
	/** Whether the user has a valid (non-expired) VTEX auth cookie. */
	isLoggedIn: boolean;
	/** Extracted email from the auth JWT, if available. */
	email?: string;
	/** Sales channel derived from segment. */
	salesChannel: string;
	/**
	 * VTEX region ID from the segment cookie.
	 * Present when the user has set a postal code (CEP) for regionalization.
	 * Null when no region is set (anonymous default segment).
	 */
	regionId: string | null;
	/** Whether this request carries price tables (B2B). */
	hasCustomPricing: boolean;
	/** Intelligent Search session cookie. */
	isSessionId: string;
	/** Intelligent Search anonymous cookie. */
	isAnonymousId: string;
	/** Whether IS cookies were freshly generated (browser didn't send them). */
	needsISCookies: boolean;
}

// -------------------------------------------------------------------------
// Cookie helpers
// -------------------------------------------------------------------------

const _IS_COOKIE_PREFIX = "vtex_is_";

/** Seconds in one day (86 400). Used for cookie Max-Age and stale-if-error. */
const ONE_DAY_SECONDS = 86_400;

/** Seconds in one year (~365 days). Used for long-lived IS cookie Max-Age. */
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

function getCookieValue(cookieHeader: string, name: string): string | null {
	const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
	return match?.[1] ?? null;
}

// -------------------------------------------------------------------------
// Core extraction
// -------------------------------------------------------------------------

/**
 * Extract VTEX context from an incoming request.
 *
 * Reads the segment cookie, URL params (utm_*, sc), and auth cookie
 * to build a complete picture of the user's VTEX session state.
 */
function generateUUID(): string {
	if (typeof crypto !== "undefined" && crypto.randomUUID) {
		return crypto.randomUUID();
	}
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
	});
}

export function extractVtexContext(request: Request): VtexRequestContext {
	const cookies = request.headers.get("cookie") ?? "";
	const url = new URL(request.url);

	const segmentCookie = getCookieValue(cookies, SEGMENT_COOKIE_NAME);
	const cookieSegment = segmentCookie ? parseSegment(segmentCookie) : null;

	const paramSegment = buildSegmentFromParams(url.searchParams);

	const vtexsc = getCookieValue(cookies, SALES_CHANNEL_COOKIE);

	const segment: Partial<Segment> = {
		...DEFAULT_SEGMENT,
		...cookieSegment,
		...paramSegment,
	};
	if (vtexsc) segment.channel = vtexsc;

	const segmentToken = serializeSegment(segment);

	const authToken = extractVtexAuthCookie(cookies);
	const authInfo = authToken ? parseVtexAuthToken(authToken) : null;

	const existingSessionId = getCookieValue(cookies, SESSION_COOKIE);
	const existingAnonymousId = getCookieValue(cookies, ANONYMOUS_COOKIE);
	const needsISCookies = !existingSessionId || !existingAnonymousId;

	return {
		segment,
		segmentToken,
		isLoggedIn: authInfo?.isLoggedIn ?? false,
		email: authInfo?.email,
		salesChannel: segment.channel ?? "1",
		regionId: segment.regionId ?? null,
		hasCustomPricing: Boolean(segment.priceTables && segment.priceTables.length > 0),
		isSessionId: existingSessionId ?? generateUUID(),
		isAnonymousId: existingAnonymousId ?? generateUUID(),
		needsISCookies,
	};
}

// -------------------------------------------------------------------------
// Cache control
// -------------------------------------------------------------------------

/**
 * Determine the appropriate Cache-Control header based on VTEX context.
 *
 * Rules:
 * - Logged-in users: private (personalized prices, wishlists, etc.)
 * - Custom pricing (B2B): private (price table specific)
 * - Anonymous default segment: public with CDN caching
 */
export function vtexCacheControl(
	ctx: VtexRequestContext,
	options?: {
		/** Max age for public (anonymous) responses in seconds. @default 60 */
		publicMaxAge?: number;
		/** Stale-while-revalidate for public responses in seconds. @default 3600 */
		publicSWR?: number;
	},
): string {
	if (ctx.isLoggedIn || ctx.hasCustomPricing) {
		return "private, no-cache, no-store, must-revalidate";
	}

	const maxAge = options?.publicMaxAge ?? 60;
	const swr = options?.publicSWR ?? 3600;

	return `public, s-maxage=${maxAge}, stale-while-revalidate=${swr}, stale-if-error=${ONE_DAY_SECONDS}`;
}

// -------------------------------------------------------------------------
// Cookie propagation
// -------------------------------------------------------------------------

/**
 * Set Intelligent Search cookies on the response only when the browser
 * doesn't already have them. On subsequent requests where the cookies
 * exist, this is a no-op — keeping the response free of Set-Cookie
 * headers so it remains cacheable at the CDN edge.
 */
export function propagateISCookies(ctx: VtexRequestContext, response: Response): void {
	if (!ctx.needsISCookies) return;

	const maxAge = ONE_YEAR_SECONDS;
	response.headers.append(
		"Set-Cookie",
		`${SESSION_COOKIE}=${ctx.isSessionId}; Path=/; SameSite=Lax; Max-Age=${maxAge}`,
	);
	response.headers.append(
		"Set-Cookie",
		`${ANONYMOUS_COOKIE}=${ctx.isAnonymousId}; Path=/; SameSite=Lax; Max-Age=${maxAge}`,
	);
}

/**
 * Build a segment cookie Set-Cookie header for the response.
 *
 * Use this when URL params change the segment (e.g., ?sc=2) so the
 * browser persists the new segment for subsequent requests.
 */
export function buildSegmentSetCookie(segment: Partial<Segment>, domain?: string): string {
	const token = serializeSegment(segment);
	let cookie = `${SEGMENT_COOKIE_NAME}=${token}; Path=/; SameSite=Lax; Max-Age=${ONE_DAY_SECONDS}`;
	if (domain) cookie += `; Domain=${domain}`;
	return cookie;
}

// -------------------------------------------------------------------------
// Cache key helpers
// -------------------------------------------------------------------------

/**
 * Build a cache key suffix from the VTEX context.
 *
 * This is used in the Cloudflare Worker entry to differentiate cached
 * responses by segment. Two anonymous users on the same sales channel
 * get the same cache key; a logged-in user gets a unique (uncached) key.
 */
export function vtexCacheKeySuffix(ctx: VtexRequestContext): string {
	if (ctx.isLoggedIn) return "__vtex_auth";
	const parts = [`sc=${ctx.salesChannel}`];
	if (ctx.regionId) parts.push(`r=${ctx.regionId}`);
	return `__vtex_${parts.join("_")}`;
}

// -------------------------------------------------------------------------
// Re-exports for convenience
// -------------------------------------------------------------------------

export type { Segment } from "./utils/types";
export type { VtexAuthInfo } from "./utils/vtexId";
export { isVtexLoggedIn } from "./utils/vtexId";
