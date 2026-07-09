/**
 * Outbound cookie sanitization for VTEX API calls.
 *
 * VTEX's janus gateway strictly enforces RFC 6265: any cookie value containing
 * non-ASCII bytes causes the gateway to return `503 Service Unavailable` with
 * an empty body, before the request reaches the backing service. This is
 * deterministic — a single poisoned cookie (e.g. an analytics tag writing a
 * category name with accents into `document.cookie` without encoding) can
 * break every checkout call for a user.
 *
 * This module provides two filters:
 *
 * - `sanitizeOutboundCookieHeader()` — drops cookies whose value contains
 *   non-ASCII bytes or that look malformed. Default for cookie forwarding
 *   in `vtexFetchWithCookies`. Safe to apply to any cookie payload.
 *
 * - `extractVtexCookies()` — allowlist mode. Drops anything that isn't on
 *   `VTEX_COOKIE_PREFIXES`. Use when calling endpoints that have no business
 *   seeing the user's full cookie soup (e.g. logout, masterdata, profile).
 *
 * The allowlist is the canonical list of cookie name prefixes that VTEX APIs
 * actually consume. It lives here so it's the single source of truth for the
 * package — both `getVtexCookies()` (cookies.ts) and
 * `extractVtexCookiesFromHeader()` (authHelpers.ts) delegate to this module.
 */

/**
 * Cookie name prefixes that are VTEX-relevant and safe to forward to
 * `*.vtexcommercestable.com.br` / `*.myvtex.com` / `secure.<storefront>` APIs.
 */
export const VTEX_COOKIE_PREFIXES: readonly string[] = [
	"VtexIdclientAutCookie",
	"checkout.vtex.com",
	"CheckoutOrderFormOwnership",
	"vtex_session",
	"vtex_segment",
	"vtex_is_",
	"janus_sid",
];

export type DropReason = "non_ascii" | "not_in_allowlist" | "malformed";

export interface DroppedCookie {
	name: string;
	reason: DropReason;
}

export interface CookieSanitizeResult {
	/** Cookie header string ready to forward (may be empty). */
	cookies: string;
	/** Cookies that were filtered out, with the reason per cookie. */
	dropped: DroppedCookie[];
}

export interface CookieSanitizeOptions {
	/**
	 * When true, additionally enforces an allowlist: only cookies whose name
	 * starts with one of `VTEX_COOKIE_PREFIXES` are kept.
	 * @default false
	 */
	allowlist?: boolean;
}

/**
 * Cookie pairs are `name=value`, where `name` (token) must be visible ASCII
 * with no separators, and `value` must be ASCII (`0x20–0x7E`) per RFC 6265.
 * We intentionally allow `=` inside the value (some VTEX cookies are
 * URL-encoded JWTs).
 */
const TOKEN_RE = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;
const ASCII_VALUE_RE = /^[\x20-\x7E]*$/;

/**
 * Filter a `Cookie:` request header so it's safe to forward to a VTEX origin.
 *
 * Drops:
 *   - pairs without `=` (malformed)
 *   - pairs whose name isn't a valid HTTP token (malformed)
 *   - pairs whose value contains non-ASCII bytes (`non_ascii`)
 *   - when `opts.allowlist` is true: pairs not on `VTEX_COOKIE_PREFIXES`
 *     (`not_in_allowlist`)
 *
 * Returns the cleaned header plus a per-cookie drop report so callers can
 * log/observe which cookies were removed.
 *
 * @example
 * ```ts
 * const { cookies, dropped } = sanitizeOutboundCookieHeader(
 *   request.headers.get("cookie") ?? "",
 * );
 * if (dropped.length) console.warn("[vtex] dropped cookies", dropped);
 * fetch(vtexUrl, { headers: { cookie: cookies } });
 * ```
 */
export function sanitizeOutboundCookieHeader(
	raw: string,
	opts: CookieSanitizeOptions = {},
): CookieSanitizeResult {
	if (!raw) return { cookies: "", dropped: [] };

	const kept: string[] = [];
	const dropped: DroppedCookie[] = [];
	const allowlist = opts.allowlist === true;

	for (const segment of raw.split(";")) {
		const pair = segment.trim();
		if (!pair) continue;

		const eq = pair.indexOf("=");
		if (eq <= 0) {
			dropped.push({ name: pair.slice(0, 32), reason: "malformed" });
			continue;
		}

		const name = pair.slice(0, eq);
		const value = pair.slice(eq + 1);

		if (!TOKEN_RE.test(name)) {
			dropped.push({ name, reason: "malformed" });
			continue;
		}

		if (!ASCII_VALUE_RE.test(value)) {
			dropped.push({ name, reason: "non_ascii" });
			continue;
		}

		if (allowlist && !VTEX_COOKIE_PREFIXES.some((p) => name.startsWith(p))) {
			dropped.push({ name, reason: "not_in_allowlist" });
			continue;
		}

		kept.push(`${name}=${value}`);
	}

	return { cookies: kept.join("; "), dropped };
}

/**
 * Allowlist convenience wrapper — keep only VTEX-prefixed, ASCII-clean cookies.
 *
 * Equivalent to `sanitizeOutboundCookieHeader(raw, { allowlist: true }).cookies`.
 */
export function extractVtexCookies(raw: string): string {
	return sanitizeOutboundCookieHeader(raw, { allowlist: true }).cookies;
}

/**
 * Track which cookie names we've already warned about to avoid spamming
 * the worker logs. Process-scoped — Cloudflare Workers reset this on each
 * isolate restart, which is exactly the cadence we want.
 */
const _warned = new Set<string>();

/**
 * Emit a structured `console.warn` for each dropped cookie, deduped by
 * `name+reason` for the lifetime of the worker isolate. Call sites pass an
 * arbitrary `host` label so we can correlate in logs.
 */
export function warnDroppedCookies(dropped: DroppedCookie[], host: string): void {
	if (dropped.length === 0) return;
	for (const d of dropped) {
		const key = `${host}::${d.name}::${d.reason}`;
		if (_warned.has(key)) continue;
		_warned.add(key);
		console.warn(`[vtex.cookie.dropped] host=${host} name=${d.name} reason=${d.reason}`);
	}
}

/** Reset the dedup set — exposed for tests. */
export function _resetCookieWarnDedupForTests(): void {
	_warned.clear();
}
