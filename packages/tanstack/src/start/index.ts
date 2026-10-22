/**
 * Safe in the browser bundle: the `serverFns.fetch` hook for `createStart`.
 *
 * ```ts
 * // src/start.ts
 * export const startInstance = createStart(() => ({ serverFns: { fetch: decoServerFnFetch } }));
 * ```
 */
import { CSEG_GLOBAL, CSEG_PARAM } from "../shared.ts";

function publishedToken(): string | null {
  if (typeof window === "undefined") return null;
  const value = (window as unknown as Record<string, unknown>)[CSEG_GLOBAL];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `fetch` for server-function calls: adds the CDN segment token the page
 * published (`__cseg`), so the CDN can cache client-side navigation data. The
 * token is a hint: the site's page cache (the example worker entry the README links)
 * recomputes it from the request and lets the CDN keep the response only when
 * they match. With no token on the page, a plain `fetch`.
 */
export const decoServerFnFetch: typeof fetch = (input, init) => {
  // TanStack's server-function fetcher passes the URL as a string; anything else goes through as is.
  if (typeof input !== "string") return fetch(input, init);
  const token = publishedToken();
  if (!token) return fetch(input, init);
  const sep = input.includes("?") ? "&" : "?";
  return fetch(`${input}${sep}${CSEG_PARAM}=${encodeURIComponent(token)}`, init);
};
