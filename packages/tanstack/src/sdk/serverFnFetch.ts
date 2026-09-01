/**
 * Client-side `serverFns.fetch` hook that attaches the CDN segment marker to
 * `/_serverFn` URLs.
 *
 * Pairs with `cdnCacheControl: "serverfn-segment"` on `createDecoWorkerEntry`.
 * Attaching the segment to the URL makes Cloudflare's CDN key (the raw URL)
 * equivalent to the key the Worker builds internally — see `./cdnSegment` for
 * why that is the whole problem.
 *
 * Only the client can do this: the initial HTML document is a browser
 * navigation with no JS hook. This covers SPA data requests and prefetches,
 * which is the volume Speculation Rules creates.
 *
 * SECURITY: the marker is a HINT, not a source of truth. The worker recomputes
 * the segment from the request itself and only releases the CDN when it matches
 * exactly (`cdnCacheableServerFn` in `./workerEntry`). A missing, diverging,
 * forged or stale-build marker just keeps today's `no-store` — it can never
 * produce a wrong response.
 *
 * @example
 * ```ts
 * // src/start.ts
 * import { createStart } from "@tanstack/react-start";
 * import { decoServerFnFetch } from "@decocms/tanstack";
 *
 * export const startInstance = createStart(() => ({
 *   serverFns: { fetch: decoServerFnFetch },
 * }));
 * ```
 */

import { detectDevice } from "@decocms/blocks/sdk/detectDevice";
import { CSEG_PARAM, segmentToken } from "./cdnSegment";

declare const __DECO_BUILD_HASH__: string | undefined;

function buildHash(): string | undefined {
  return typeof __DECO_BUILD_HASH__ !== "undefined" ? __DECO_BUILD_HASH__ : undefined;
}

function segmentMarker(): string | null {
  if (typeof navigator === "undefined") return null;
  // Device is the only dimension observable on the client. If this request is
  // in fact from a logged-in user, or in a region, or an A/B cohort, the worker
  // catches it during verification and keeps the no-store — the marker simply
  // won't match.
  return segmentToken({ device: detectDevice(navigator.userAgent) }, buildHash());
}

/**
 * Drop-in `serverFns.fetch` implementation. Falls back to a plain `fetch` when
 * there is no marker to add.
 */
export const decoServerFnFetch: typeof fetch = (input, init) => {
  // TanStack's serverFnFetcher always calls with the URL already built as a
  // string (start-client-core/src/client-rpc/serverFnFetcher.ts). Anything else
  // goes through untouched.
  if (typeof input !== "string") return fetch(input, init);
  const marker = segmentMarker();
  if (!marker) return fetch(input, init);
  const sep = input.includes("?") ? "&" : "?";
  return fetch(`${input}${sep}${CSEG_PARAM}=${marker}`, init);
};
