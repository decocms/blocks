/**
 * What `@decocms/tanstack` adds to a next-major site on Cloudflare Workers
 * (see /next/caching#upstream-data and /next/telemetry#whats-sent):
 *
 * - upstream caching: GETs made through `createInstrumentedFetch` are served
 *   from the Cloudflare Cache API, honouring the upstream's `cache-control`,
 *   and bypass it while a draft is rendered;
 * - inbound request metrics (`http.server.request.duration`, by route
 *   pattern, never the raw URL) and cache metrics (`deco.cache.requests`,
 *   by layer and outcome), reported to the CMS's telemetry.
 *
 * Both reach the core through `Symbol.for` hooks on `globalThis` (the core
 * imports nothing from a binding): the upstream cache under
 * `decocms.blocks.upstreamCache`, measurements through the pipeline the
 * core keeps under `decocms.blocks.telemetry`. Nothing here is exported
 * from the package; the worker entry calls it.
 */
import { draftPointer } from "@decocms/blocks";
// The worker entry runs every request inside RequestContext, whose storage
// resolves to a no-op stub in browser bundles (this module is reachable from
// the package root, which client code imports).
import { RequestContext } from "@decocms/blocks/sdk/requestContext";

const UPSTREAM_CACHE = Symbol.for("decocms.blocks.upstreamCache");
const TELEMETRY = Symbol.for("decocms.blocks.telemetry");

interface Pipeline {
  histogram(name: string, attributes: Record<string, string | boolean>, seconds: number): void;
}

/** Whether the request being served renders a draft (then upstream caching is off). */
function renderingDraft(): boolean {
  try {
    return draftPointer(RequestContext.request) !== null;
  } catch {
    return false; // outside a request
  }
}

function pipeline(): Pipeline | undefined {
  return (globalThis as Record<symbol, Pipeline | undefined>)[TELEMETRY];
}

/** `deco.cache.requests`, by layer and outcome. */
export function recordCache(layer: "edge" | "upstream", outcome: string, seconds = 0): void {
  pipeline()?.histogram(
    "deco.cache.requests",
    { "deco.cache.layer": layer, "deco.cache.outcome": outcome.toLowerCase() },
    seconds,
  );
}

/** `http.server.request.duration` for one response, labelled by route pattern. */
export function recordInbound(request: Request, status: number, seconds: number): void {
  pipeline()?.histogram(
    "http.server.request.duration",
    {
      "http.request.method": request.method,
      "http.route": routePattern(new URL(request.url).pathname),
      status_class: `${Math.floor(status / 100)}xx`,
    },
    seconds,
  );
}

/**
 * A bounded route label for a path: numeric and hex ids become `:id`, the
 * segment before a trailing `/p` and every hyphenated segment (CMS slugs)
 * become `:slug`. A raw path is one series per URL and never leaves.
 */
export function routePattern(pathname: string): string {
  const segments = pathname.split("/");
  return segments
    .map((segment, i) => {
      if (/^\d+$/.test(segment) || /^[0-9a-f]{8,}$/i.test(segment)) return ":id";
      if (segment !== "" && segments[i + 1] === "p" && i + 2 === segments.length) return ":slug";
      return segment.includes("-") && !segment.startsWith(".") ? ":slug" : segment;
    })
    .join("/");
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
    if (hit) {
      recordCache("upstream", "hit");
      return { response: hit, cached: true };
    }
    recordCache("upstream", "miss");
    const response = await fetch(input, init);
    if (cacheable(response)) {
      // Awaited: the Cache API is local to the data center, and the next
      // request for the same URL should already find it.
      await cache.put(request.url, response.clone()).catch(() => {});
    }
    return { response, cached: false };
  };
}
