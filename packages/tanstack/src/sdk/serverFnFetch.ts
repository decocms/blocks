/**
 * Client-side `serverFns.fetch` hook that echoes the CDN segment marker onto
 * `/_serverFn` URLs.
 *
 * Pairs with `cdnCacheControl: "serverfn-segment"` on `createDecoWorkerEntry`.
 * Putting the segment in the URL is what makes the key of whatever caches in
 * front of the Worker equivalent to the Worker's own — see `./cdnSegment`.
 *
 * The client does not COMPUTE the token, it repeats one the server issued and
 * published on the page. That is deliberate: the segment includes dimensions
 * only the server can see (region comes from `request.cf`), so a client-derived
 * token never matched on a regionalized store and the feature stayed inert
 * there.
 *
 * Only client-initiated requests carry it — SPA navigation and prefetch, which
 * is the volume Speculation Rules generates. The initial HTML document is a
 * browser navigation with no hook to attach anything to.
 *
 * SECURITY: the marker is a HINT. The worker recomputes the segment from the
 * request itself and only relaxes `no-store` on an exact match
 * (`cdnCacheableServerFn` in `./workerEntry`). A missing, stale, forged or
 * mismatched marker just keeps today's `no-store` — it can never produce a
 * wrong response.
 *
 * Wired automatically: `decoVitePlugin` supplies `sdk/startEntry` as the Start
 * entry when a site has no `src/start.ts` of its own. A site that owns one
 * composes this itself:
 *
 * ```ts
 * import { decoServerFnFetch } from "@decocms/tanstack/sdk/serverFnFetch";
 * export const startInstance = createStart(() => ({
 *   serverFns: { fetch: decoServerFnFetch },
 * }));
 * ```
 */

import { CSEG_GLOBAL, CSEG_PARAM } from "./cdnSegment";

function publishedMarker(): string | null {
  if (typeof window === "undefined") return null;
  const v = (window as unknown as Record<string, unknown>)[CSEG_GLOBAL];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Drop-in `serverFns.fetch`. Falls back to a plain `fetch` whenever there is no
 * marker to echo — no marker simply means the response stays uncached in front
 * of the Worker, which is the previous behaviour.
 */
export const decoServerFnFetch: typeof fetch = (input, init) => {
  // TanStack's serverFnFetcher always calls with the URL already built as a
  // string (start-client-core/src/client-rpc/serverFnFetcher.ts). Anything else
  // goes through untouched.
  if (typeof input !== "string") return fetch(input, init);
  const marker = publishedMarker();
  if (!marker) return fetch(input, init);
  const sep = input.includes("?") ? "&" : "?";
  return fetch(`${input}${sep}${CSEG_PARAM}=${encodeURIComponent(marker)}`, init);
};
