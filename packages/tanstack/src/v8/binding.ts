/**
 * What `@decocms/tanstack` adds to a next-major site on Cloudflare Workers
 * (see /next/caching#upstream-data): GETs made through
 * `createInstrumentedFetch` are served from the Cloudflare Cache API,
 * honouring the upstream's `cache-control`, and bypass it while a draft is
 * rendered. Hits carry the instrumented fetch's `cached=true` label.
 *
 * It reaches the core through a `Symbol.for` hook on `globalThis`
 * (`decocms.blocks.upstreamCache`; the core imports nothing from a binding).
 * Nothing here is exported from the package; the worker entry calls it.
 */
import { draftPointer } from "@decocms/blocks";
// The worker entry runs every request inside RequestContext, whose storage
// resolves to a no-op stub in browser bundles (this module is reachable from
// the package root, which client code imports).
import { RequestContext } from "@decocms/blocks/sdk/requestContext";

const UPSTREAM_CACHE = Symbol.for("decocms.blocks.upstreamCache");

/** Whether the request being served renders a draft (then upstream caching is off). */
function renderingDraft(): boolean {
  try {
    return draftPointer(RequestContext.request) !== null;
  } catch {
    return false; // outside a request
  }
}

/** Whether a response may be kept in a shared cache, per its `cache-control`. */
function cacheable(response: Response): boolean {
  if (response.status !== 200) return false;
  const control = response.headers.get("cache-control")?.toLowerCase() ?? "";
  if (/\b(no-store|no-cache|private)\b/.test(control)) return false;
  return /\b(s-maxage|max-age)=[1-9]/.test(control);
}

/**
 * Installs the upstream cache (idempotent). Requests that carry a user's
 * credentials (`authorization`, `cookie`) are never cached, and nothing is
 * read or written while a draft is rendered.
 */
export function installUpstreamCache(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (typeof g[UPSTREAM_CACHE] === "function") return;
  g[UPSTREAM_CACHE] = async (
    input: string | URL | Request,
    init: RequestInit,
    fetch: typeof globalThis.fetch,
  ): Promise<{ response: Response; cached: boolean }> => {
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    const request = new Request(input, init);
    if (
      cache === undefined ||
      renderingDraft() ||
      request.headers.has("authorization") ||
      request.headers.has("cookie")
    ) {
      return { response: await fetch(input, init), cached: false };
    }
    const hit = await cache.match(request.url).catch(() => undefined);
    if (hit) return { response: hit, cached: true };
    const response = await fetch(input, init);
    if (cacheable(response)) {
      // Awaited: the Cache API is local to the data center, and the next
      // request for the same URL should already find it.
      await cache.put(request.url, response.clone()).catch(() => {});
    }
    return { response, cached: false };
  };
}
