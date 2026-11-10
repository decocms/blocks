/**
 * Where Deco Studio runs: the origins its site editor frames a site from and
 * talks to it from (`postMessage`). One list, so the worker's
 * `frame-ancestors` and a site's own never drift apart.
 *
 * No module state and no framework code: safe in a browser bundle.
 */

/**
 * Studio's origins, in the CSP source form (`https://*.decocms.com` matches
 * any subdomain). Test an origin with {@link isStudioOrigin}: the list holds a
 * wildcard, so `includes()` isn't the check.
 */
export const STUDIO_ORIGINS: readonly string[] = Object.freeze([
  "https://studio.decocms.com",
  "https://studio-stg.decocms.com",
  "https://decocms.com",
  "https://*.decocms.com",
]);

/**
 * The `frame-ancestors` sources a site sends so Studio can show it in the
 * site editor: the site itself, {@link STUDIO_ORIGINS}, and v7's
 * `https://*.deco.studio`. A binding adds the loopback origins in local
 * development (`http://localhost:*`), where a Studio runs on the same machine.
 */
export const STUDIO_FRAME_ANCESTORS: readonly string[] = Object.freeze([
  "'self'",
  ...STUDIO_ORIGINS,
  "https://*.deco.studio",
]);

/** Studio's production origin. */
export const STUDIO_ORIGIN = "https://studio.decocms.com";

/**
 * The exact origins a page trusts for the Studio channel by default, and adds
 * to its CSP (`script-src`, `frame-ancestors`): Studio's production and
 * staging origins. No wildcard: each one is compared exactly.
 */
export const DEFAULT_STUDIO_ORIGINS: readonly string[] = Object.freeze([
  STUDIO_ORIGIN,
  "https://studio-stg.decocms.com",
]);

/**
 * Where `StudioRefresh` puts the page's own refresh for Studio's HTML swap
 * (`STUDIO_PAGE_REFRESH` of `@decocms/blocks/protocol`, held equal by a test).
 */
export const STUDIO_PAGE_REFRESH = "__decoStudioRefresh";

/** `value` as an exact http(s) origin (`https://host[:port]`, a trailing `/` dropped; no wildcard), or `""`. */
function asOrigin(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    // A host name or an IP address: a URL parser accepts `*` in a host, which a
    // CSP source would read as a wildcard.
    if (!/^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)$/.test(url.hostname)) return "";
    return trimmed === url.origin || trimmed === `${url.origin}/` ? url.origin : "";
  } catch {
    return "";
  }
}

/**
 * The Studio origins the page trusts: the Studio channel accepts messages and
 * modules from them, and the binding adds them to the page's CSP `script-src`
 * and `frame-ancestors`. The binding option when given (an empty list turns
 * the channel off), else the `DECO_STUDIO_ORIGIN` environment variable, a
 * comma-separated list (a local or staging Studio, such as
 * `http://localhost:3000`; read where `process.env` exists, so on the
 * server), else {@link DEFAULT_STUDIO_ORIGINS}. Each entry must be an exact
 * http(s) origin; any other value (a path, a wildcard, a CSP keyword) is
 * dropped, so the list never widens the CSP beyond origins.
 */
export function studioOrigins(option?: readonly string[]): readonly string[] {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.DECO_STUDIO_ORIGIN;
  const list = option ?? (env?.trim() ? env.split(",") : DEFAULT_STUDIO_ORIGINS);
  return [...new Set(list.map(asOrigin).filter(Boolean))];
}

/**
 * Whether `origin` (a `MessageEvent.origin`, an `Origin` header) is one of
 * {@link STUDIO_ORIGINS}: `https`, the default port, and `decocms.com` or a
 * name under it.
 */
export function isStudioOrigin(origin: string | null | undefined): boolean {
  if (typeof origin !== "string" || origin === "") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // An origin is the scheme and host alone: `https://decocms.com/x` or one with
  // credentials isn't one.
  if (url.origin !== origin || url.protocol !== "https:" || url.port !== "") return false;
  const host = url.hostname;
  return host === "decocms.com" || host.endsWith(".decocms.com");
}
