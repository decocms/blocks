/**
 * The headers every HTML response carries: v7's security headers, the site's
 * Content-Security-Policy, and `frame-ancestors` so Deco Studio's site editor
 * (and nothing else the site doesn't name) can show the page in its frame. No
 * `X-Frame-Options`: `frame-ancestors` supersedes it and, unlike `SAMEORIGIN`,
 * can allow Studio's origin.
 */
import { STUDIO_FRAME_ANCESTORS } from "../studio.ts";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-XSS-Protection": "1; mode=block",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

/** A Studio on this machine, in local development. */
const LOOPBACK_ANCESTORS = ["http://localhost:*", "http://127.0.0.1:*"];

export interface CspOptions {
  /** The enforced policy's directives (`frame-ancestors` is added when they have none). */
  enforce?: string | readonly string[];
  /** Directives sent as `Content-Security-Policy-Report-Only`. */
  reportOnly?: string | readonly string[];
  /** More origins that may frame the site, besides Studio's (a marketing tool's editor). */
  frameAncestors?: readonly string[];
}

function directives(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = typeof value === "string" ? value.split(";") : [...value];
  return list.map((d) => d.trim()).filter(Boolean);
}

/** The `frame-ancestors` sources: Studio's, the site's own, and loopback in development. */
export function frameAncestors(csp: CspOptions | undefined, dev: boolean): string[] {
  return [
    ...new Set([
      ...STUDIO_FRAME_ANCESTORS,
      ...(csp?.frameAncestors ?? []),
      ...(dev ? LOOPBACK_ANCESTORS : []),
    ]),
  ];
}

/** Every HTML response's security headers. */
export function htmlSecurityHeaders(
  csp: CspOptions | undefined,
  dev: boolean,
): Record<string, string> {
  const enforce = directives(csp?.enforce);
  if (!enforce.some((d) => /^frame-ancestors(\s|$)/i.test(d))) {
    enforce.push(`frame-ancestors ${frameAncestors(csp, dev).join(" ")}`);
  }
  const reportOnly = directives(csp?.reportOnly);
  return {
    ...SECURITY_HEADERS,
    "Content-Security-Policy": enforce.join("; "),
    ...(reportOnly.length ? { "Content-Security-Policy-Report-Only": reportOnly.join("; ") } : {}),
  };
}
