/**
 * The headers every HTML response carries: v7's security headers, the site's
 * Content-Security-Policy, and what Studio needs in it (`withStudioCsp`):
 * `frame-ancestors` so Deco Studio's site editor (and nothing else the site
 * doesn't name) can show the page in its frame, and Studio's origins in
 * `script-src` so the Studio channel can import Studio's modules. No
 * `X-Frame-Options`: `frame-ancestors` supersedes it and, unlike
 * `SAMEORIGIN`, can allow Studio's origin.
 */
import { cspDirectives, withStudioCsp } from "../csp.ts";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-XSS-Protection": "1; mode=block",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

export interface CspOptions {
  /**
   * The enforced policy's directives. `frame-ancestors` is added when they
   * have none; Studio's origins are added to `script-src` (`withStudioCsp`).
   */
  enforce?: string | readonly string[];
  /** Directives sent as `Content-Security-Policy-Report-Only` (Studio's origins added to its `script-src`). */
  reportOnly?: string | readonly string[];
  /** More origins that may frame the site, besides Studio's (a marketing tool's editor). */
  frameAncestors?: readonly string[];
}

/** Every HTML response's security headers. `studioOrigins`: the list the Studio channel trusts. */
export function htmlSecurityHeaders(
  csp: CspOptions | undefined,
  dev: boolean,
  studioOrigins?: readonly string[],
): Record<string, string> {
  const options = { studioOrigins, frameAncestors: csp?.frameAncestors, dev };
  const enforce = withStudioCsp(csp?.enforce, options);
  const reportOnly = cspDirectives(csp?.reportOnly).length
    ? withStudioCsp(csp?.reportOnly, { ...options, addFrameAncestors: false })
    : [];
  return {
    ...SECURITY_HEADERS,
    "Content-Security-Policy": enforce.join("; "),
    ...(reportOnly.length ? { "Content-Security-Policy-Report-Only": reportOnly.join("; ") } : {}),
  };
}
