/**
 * Where Deco Studio runs: the origins its site editor frames a site from and
 * talks to it from (`postMessage`). One list for every binding, so the
 * TanStack worker's `frame-ancestors`, a Next.js config's `allowedDevOrigins`
 * and the Studio bridge never drift apart.
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
