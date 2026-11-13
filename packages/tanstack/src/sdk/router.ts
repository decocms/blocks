/**
 * Deco-flavored TanStack Router factory.
 *
 * Uses standard URLSearchParams serialization instead of TanStack's default
 * JSON-based format. Required because VTEX (and most commerce platforms) uses
 * filter URLs like `?filter.brand=Nike&filter.brand=Adidas` which must
 * round-trip correctly through the router's search system.
 */

import { getRequestNonce } from "@decocms/blocks/sdk/nonce";
import type {
  AnyRoute,
  RouterOptions,
  SearchParser,
  SearchSerializer,
  TrailingSlashOption,
} from "@tanstack/react-router";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";

export const decoParseSearch: SearchParser = (searchStr) => {
  const str = searchStr.startsWith("?") ? searchStr.slice(1) : searchStr;
  if (!str) return {};

  const params = new URLSearchParams(str);
  const result: Record<string, string | string[]> = {};

  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
};

/**
 * Serializes the router's search object back to a query string.
 *
 * Must be a fixed point of {@link decoParseSearch}: on the server, TanStack
 * Router compares the request's href with `stringifySearch(parseSearch(...))`
 * (`router.beforeLoad`) and answers a 307 to the normalized URL when they
 * differ. A value-less parameter (`?sort=`, `?utm_source=`) parses to `""`,
 * so dropping `""` here turned every such request into a redirect that
 * Fresh — and TanStack's own default serializer, which only drops
 * `undefined` — never issued. `undefined`/`null` still remove a param, which
 * is how `navigate({ search: { q: undefined } })` clears one.
 */
export const decoStringifySearch: SearchSerializer = (search) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, String(v));
    } else {
      params.append(key, String(value));
    }
  }
  const str = params.toString();
  return str ? `?${str}` : "";
};

type TanStackRouterOptions = RouterOptions<AnyRoute, TrailingSlashOption>;

export interface CreateDecoRouterOptions {
  routeTree: AnyRoute;
  /**
   * `true`, `false`, or TanStack's predicate form — e.g. to skip the
   * scroll-to-top on the first render after a document load.
   */
  scrollRestoration?: TanStackRouterOptions["scrollRestoration"];
  defaultPreload?: "intent" | "viewport" | "render" | false;
  /** ms between the intent (hover/touchstart) and the preload. TanStack default: 50. */
  defaultPreloadDelay?: number;
  /**
   * How long preloaded data is reused by the navigation that follows, in ms.
   * TanStack default: 30_000. Without it, a route whose own `staleTime` is
   * lower refetches on click what the hover just loaded.
   */
  defaultPreloadStaleTime?: number;
  /** How long an unused preload stays in memory, in ms. TanStack default: 30 min. */
  defaultPreloadGcTime?: number;
  /** ms before a slow navigation shows the pending component. TanStack default: 1000. */
  defaultPendingMs?: number;
  /** Minimum ms the pending component stays once shown. TanStack default: 500. */
  defaultPendingMinMs?: number;
  trailingSlash?: TrailingSlashOption;
  /**
   * Router context — passed to all route loaders/components via routeContext.
   * Commonly used for { queryClient } per TanStack Query integration docs.
   */
  context?: Record<string, unknown>;
  /**
   * Non-DOM provider component to wrap the entire router.
   * Per TanStack docs, only non-DOM-rendering components (providers) should
   * be used — anything else causes hydration errors.
   *
   * Example: QueryClientProvider wrapping
   *   Wrap: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
   */
  Wrap?: (props: { children: any }) => any;
}

/**
 * Create a TanStack Router with Deco defaults:
 * - URLSearchParams-based search serialization (not JSON)
 * - Scroll restoration enabled
 * - Preload on intent
 *
 * The preload and pending options are passed through only when set, so
 * TanStack's own defaults apply otherwise.
 */
export function createDecoRouter(options: CreateDecoRouterOptions) {
  const {
    routeTree,
    scrollRestoration = true,
    defaultPreload = "intent",
    defaultPreloadDelay,
    defaultPreloadStaleTime,
    defaultPreloadGcTime,
    defaultPendingMs,
    defaultPendingMinMs,
    trailingSlash,
    context,
    Wrap,
  } = options;

  const timing = Object.fromEntries(
    Object.entries({
      defaultPreloadDelay,
      defaultPreloadStaleTime,
      defaultPreloadGcTime,
      defaultPendingMs,
      defaultPendingMinMs,
    }).filter(([, value]) => value !== undefined),
  );

  // On the server, `getRouter()` runs per request inside `RequestContext.run`,
  // so this reads the request's CSP nonce (enforce mode) — `ScriptOnce` and
  // TanStack's own hydration scripts read `router.options.ssr.nonce` and stamp
  // it. `undefined` in report-only mode and on the client, where it's a no-op.
  const nonce = getRequestNonce();

  return createTanStackRouter({
    routeTree,
    scrollRestoration,
    defaultPreload,
    ...timing,
    trailingSlash,
    context: context as any,
    Wrap,
    parseSearch: decoParseSearch,
    stringifySearch: decoStringifySearch,
    ...(nonce ? { ssr: { nonce } } : {}),
  });
}
