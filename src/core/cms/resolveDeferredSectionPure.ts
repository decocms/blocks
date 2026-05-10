/**
 * Framework-agnostic deferred section resolver.
 *
 * Pure logical core of `loadDeferredSection`. Hosts (TanStack, Next.js, Remix,
 * plain Node) build a `MatcherContext` from request primitives, call this,
 * then translate `cacheMetadata` into response headers themselves.
 */

import { normalizeUrlsInObject } from "../sdk/normalizeUrls";
import {
  type MatcherContext,
  type ResolvedSection,
  getDeferredRawProps,
  reExtractRawProps,
  resolveDeferredSection,
} from "./resolve";
import { runSingleSectionLoader } from "./sectionLoaders";

/**
 * Result of `resolveDeferredSectionPure`. Contains the enriched section plus
 * cache hints for the host transport layer.
 */
export interface ResolvedDeferredSection {
  section: ResolvedSection;
  /**
   * Hints for the host transport layer about how this response can be cached.
   * Mirrors `LoadedCmsPage.cacheMetadata` so hosts share one translation step.
   */
  cacheMetadata: {
    cacheable: boolean;
    cacheControl?: string;
  };
}

export interface ResolveDeferredSectionPureOptions {
  /**
   * Raw section props supplied by the client. Takes precedence over the
   * server-side deferred-props cache when present (backward compat).
   * @deprecated rawProps are now resolved server-side from the deferred props cache.
   */
  rawProps?: Record<string, unknown>;
  /**
   * Original index of the section in the page's section list. Used to look
   * up cached rawProps and to preserve ordering on the client.
   */
  index?: number;
}

/**
 * Resolve and enrich a single deferred section without depending on
 * TanStack request primitives. Mirrors `loadDeferredSection` in
 * `src/tanstack/routes/cmsRoute.ts`, minus the `setResponseHeader` call.
 *
 * @returns the enriched section + cacheMetadata, or `null` if rawProps cannot
 *   be recovered or the section fails to resolve.
 */
export async function resolveDeferredSectionPure(
  pagePath: string,
  component: string,
  ctx: MatcherContext,
  opts: ResolveDeferredSectionPureOptions = {},
): Promise<ResolvedDeferredSection | null> {
  const { rawProps: clientRawProps, index } = opts;

  // Resolve rawProps: prefer client-provided (backward compat), then server
  // cache, then re-extract from the page (handles cross-isolate cache miss
  // on Cloudflare Workers and TTL expiry for slow-scrolling users).
  const rawProps =
    clientRawProps ??
    (index !== undefined ? getDeferredRawProps(pagePath, component, index) : null) ??
    (index !== undefined
      ? await reExtractRawProps(pagePath, component, index, ctx)
      : null);

  if (!rawProps) {
    console.warn(
      `[CMS] Deferred section cache miss: ${component} at index ${index} on ${pagePath}`,
    );
    return null;
  }

  const section = await resolveDeferredSection(component, rawProps, pagePath, ctx);
  if (!section) return null;

  if (index !== undefined) section.index = index;

  // Build a Request for the section loader. Prefer the supplied request
  // so that header-derived state (auth, cookies, geo) flows in unchanged.
  const request =
    ctx.request ??
    new Request(ctx.url ?? pagePath, {
      headers: ctx.headers ?? {},
    });

  const enriched = await runSingleSectionLoader(section, request);
  const normalized = normalizeUrlsInObject(enriched) as ResolvedSection;

  return {
    section: normalized,
    cacheMetadata: {
      // Deferred section responses are safe to edge-cache. Without this signal
      // the worker entry passes POST _serverFn responses straight through.
      cacheable: true,
    },
  };
}
